/**
 * @file 店頭サイネージのジングル（仕様書 第31.7.3節・第31.9.2節）。M2Office の音は画面の側で合成し（音の素材の権利を持たずに済む）、会社の音は取り置いたファイルを鳴らす。
 *
 * 声では読み上げない。ブラウザは人が触れていないページで音を出させないため、音を出せるかを確かめ、出せなければ画面が小さな印を出す。
 */

/** 1 つの音（周波数・始まり・長さ・強さ）。 */
type Note = [freq: number, at: number, dur: number, gain?: number];

/** M2Office が持つ音の譜（どれも 2 秒以内）。 */
const SCORES: Record<string, { type: OscillatorType; notes: Note[] }> = {
  // ピンポーン（下がる 2 つの音。既定）
  pinpon: { type: 'sine', notes: [[1318.5, 0, 0.9], [1046.5, 0.38, 1.3]] },
  // ピンポンパンポーン（上がる 4 つの音）
  pinponpanpon: { type: 'sine', notes: [[784, 0, 0.45], [988, 0.28, 0.45], [1175, 0.56, 0.45], [1568, 0.84, 1.1]] },
  // ポロン（明るい短い和音）
  poron: { type: 'triangle', notes: [[1046.5, 0, 1.2, 0.7], [1318.5, 0.07, 1.2, 0.6], [1568, 0.14, 1.3, 0.6]] },
  // ベル（1 つの鐘の音。倍音を重ねる）
  bell: { type: 'sine', notes: [[880, 0, 1.8], [1760, 0, 1.2, 0.35], [2640, 0, 0.8, 0.15]] },
};

/**
 * ジングルを鳴らす部品。ページに 1 つ作る。
 */
export class JinglePlayer {
  private ctx: AudioContext | null = null;
  private current: AudioScheduledSourceNode[] = [];

  constructor() {
    try { this.ctx = new AudioContext(); } catch { this.ctx = null; }
  }

  /** 音を出せるか（`AudioContext` が動いているか）。 */
  get ok(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** 音を許す（人が画面を押したとき）。自動再生を許す設定の端末では、開いたときから動く。 */
  async unlock(): Promise<boolean> {
    try { await this.ctx?.resume(); } catch { /* 許されない */ }
    return this.ok;
  }

  /** 鳴っている音を止める（割り込みを消したとき）。 */
  stop(): void {
    for (const n of this.current) { try { n.stop(); } catch { /* 止め済み */ } }
    this.current = [];
  }

  /**
   * 音を鳴らす。
   *
   * @param id M2Office の音の名前か、会社の音の ID
   * @param volume 大きさ（0〜100）
   * @param file 会社の音のファイル（取り置いたもの）
   */
  async play(id: string, volume: number, file?: Blob | null): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || volume <= 0) return;
    this.stop();
    const out = ctx.createGain();
    out.gain.value = Math.min(1, Math.max(0, volume / 100)) * 0.8;
    out.connect(ctx.destination);
    if (file) {
      try {
        const buf = await ctx.decodeAudioData(await file.arrayBuffer());
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        src.start();
        this.current.push(src);
        return;
      } catch { /* 読めない音は既定の音にする */ }
    }
    const score = SCORES[id] ?? SCORES['pinpon']!;
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, at, dur, gain = 1] of score.notes) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = score.type;
      osc.frequency.value = freq;
      // 立ち上がりを短く、減衰を長くして、鐘のような音にする
      env.gain.setValueAtTime(0, t0 + at);
      env.gain.linearRampToValueAtTime(0.5 * gain, t0 + at + 0.015);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(env);
      env.connect(out);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.05);
      this.current.push(osc);
    }
  }
}
