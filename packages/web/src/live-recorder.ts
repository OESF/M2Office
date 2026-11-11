/**
 * @file 画面でその場で録る録音の仕組み（仕様書 第9.4.5.1節、ADR-0099）。
 *
 * マイクの音を 16 kHz・モノラル・16 ビットの PCM にし、10 秒ごとの欠片にして録りながら送る。止めたらサーバーが 1 つの WAV にする。
 * スマホで画面が消えるなどしてブラウザが録音を止めたら、そこまでを送り切り、画面に知らせる（続けて録れば同じ録音の後ろにつなぐ）。
 * 録音は画面に残さない（送り終えた欠片は捨てる）。
 *
 * 「会議の音も」（第9.4.5.2節、ADR-0137）では、ブラウザの画面の共有で会議のタブの音（相手の声）を受け、マイクの音と合わせて 1 つにする。
 * 映像は使わずにすぐ止める。共有が終わった（会議のタブを閉じた・共有を止めた）ら、会議が終わったとして画面に知らせる。
 */

import { api, ApiError } from './api.js';
import { micErrorReason, micUnavailableReason, WORKLET } from './voice.js';

/** 標本化の周波数（サーバーの WAV の見出しと同じ）。 */
const RATE = 16_000;
/** 欠片の長さ（秒）。 */
const PART_SEC = 10;
/** 録れる長さの上限（秒）。第9.4.5節と同じ 3 時間。 */
export const LIVE_MAX_SEC = 3 * 3600;
/** 画面が見えているのに音が届かなくなってから、止まったとみなすまでの長さ（ミリ秒）。 */
const STALL_MS = 3000;

/** 録っている間に画面へ伝える口。 */
export interface LiveRecorderHandlers {
  /** 録れている長さ（秒）。 */
  onSeconds(sec: number): void;
  /** 音の大きさ（0〜1）。 */
  onLevel(level: number): void;
  /** ブラウザが録音を止めた（画面が消えた・ほかのアプリに移った・電話が来た）。そこまでは送り切る。 */
  onInterrupted(): void;
  /** 3 時間に達した。画面は止めて渡す。 */
  onLimit(): void;
  /** まだ送れていない欠片の数（つながらないときに知らせる）。 */
  onPending(n: number): void;
  /** 会議の音の共有が終わった（会議のタブを閉じた・共有を止めた）。画面は止めて渡す（第9.4.5.2節「終わり方」）。 */
  onMeetingEnded?(): void;
}

/** 録り方。`meeting` は会議の画面の音とマイクを合わせて録る（第9.4.5.2節）。 */
export type CaptureMode = 'mic' | 'meeting';

/** 会議の音を取れなかった（共有の選びで「音声も共有する」を入れなかったなど）。画面は選び直すか、マイクだけで録るかを出す。 */
export class MeetingAudioMissing extends Error {
  constructor() {
    super('会議の音を取れませんでした。共有の選びで「音声も共有する」を入れてください');
  }
}

/**
 * 会議の音を録れる環境か（パソコンの Chrome・Edge。第9.4.5.2節「使える環境」）。
 * Safari・Firefox・スマホはタブの音を共有できないため、選びを出さない。
 */
export function meetingAudioSupported(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || /Firefox\//.test(ua)) return false;
  return /Chrome\/|Edg\//.test(ua);
}

/**
 * 会議の画面の音を受ける（映像はすぐ止める）。共有の選びを出すので、押した操作の中から呼ぶ。
 *
 * @throws MeetingAudioMissing 音が来なかったとき
 * @throws Error 共有を断られたとき
 */
async function displayAudio(): Promise<MediaStream> {
  let shared: MediaStream;
  try {
    // 型の定義に無い選び（systemAudio など）があるため、広い形で渡す
    const options = {
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    } as unknown as DisplayMediaStreamOptions;
    shared = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (err) {
    throw new Error(err instanceof DOMException && err.name === 'NotAllowedError' ? '会議の画面の共有がキャンセルされました' : '会議の画面を共有できませんでした');
  }
  for (const v of shared.getVideoTracks()) v.stop();
  if (!shared.getAudioTracks().length) {
    for (const t of shared.getTracks()) t.stop();
    throw new MeetingAudioMissing();
  }
  return new MediaStream(shared.getAudioTracks());
}

/** 秒を「12:34」「1:02:03」にする。 */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * 1 つの途中の録音を録って送る。
 *
 * @remarks
 * 欠片は番号つきで順に送り、失敗したら間を空けて送り直す（同じ番号はサーバーで 1 つになる）。
 * `capture()` で録り始め、`pause()` で止め（続けられる）、`finish()` で送り切って 1 つのファイルにする。
 */
export class LiveRecorder {
  private seq: number;
  private samples = 0;
  private buffer: Int16Array = new Int16Array(RATE * PART_SEC);
  private filled = 0;
  private queue: { seq: number; pcm: Blob }[] = [];
  private sending: Promise<void> | null = null;
  private closed = false;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private wake: { release(): Promise<void> } | null = null;
  private lastFrame = 0;
  private watchdog: number | null = null;
  private capturing = false;
  private display: MediaStream | null = null;
  /** いまの録り方（続けて録るときも同じにする） */
  mode: CaptureMode = 'mic';

  constructor(readonly id: string, nextSeq: number, private readonly startSec: number, private readonly h: LiveRecorderHandlers) {
    this.seq = nextSeq;
  }

  /** 録れている長さ（秒）。 */
  get seconds(): number {
    return this.startSec + this.samples / RATE;
  }

  /** まだ送れていない欠片があるか。 */
  get pending(): boolean {
    return this.queue.length > 0 || this.filled > 0;
  }

  /**
   * マイクを取り、録り始める。`meeting` なら、先に会議の画面の音を受ける（共有の選びを出すので、押した操作の中から呼ぶ）。
   *
   * @throws MeetingAudioMissing 会議の音が来なかったとき
   * @throws Error マイクを使えないとき・共有を断られたとき（利用者に見せる理由）
   */
  async capture(mode: CaptureMode = this.mode): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(micUnavailableReason());
    const display = mode === 'meeting' ? await displayAudio() : null;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      for (const t of display?.getTracks() ?? []) t.stop();
      throw new Error(micErrorReason(err));
    }
    this.mode = mode;
    const context = new AudioContext({ sampleRate: RATE });
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    const node = new AudioWorkletNode(context, 'm2o-mic', { processorOptions: { frames: RATE / 10 } });
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.take(ev.data);
    context.createMediaStreamSource(stream).connect(node);
    // 会議の音は、マイクの音と同じ取り込みにつなぐ（つないだ音は足し合わされて 1 つになる）
    if (display) context.createMediaStreamSource(display).connect(node);
    // 音を出さずに動かすため、無音の行き先へつなぐ
    const silent = context.createGain();
    silent.gain.value = 0;
    node.connect(silent).connect(context.destination);
    this.stream = stream;
    this.context = context;
    this.capturing = true;
    this.lastFrame = Date.now();
    for (const track of stream.getTracks()) track.addEventListener('ended', () => this.interrupted());
    this.display = display;
    // 会議のタブを閉じた・共有を止めたら、会議が終わったとみなす（第9.4.5.2節「終わり方」）
    for (const track of display?.getTracks() ?? []) track.addEventListener('ended', () => this.meetingEnded());
    context.addEventListener('statechange', () => { if (context.state !== 'running') this.interrupted(); });
    document.addEventListener('visibilitychange', this.onVisible);
    this.watchdog = window.setInterval(() => {
      // 画面が見えているのに音が届かない（裏にいる間に止められた）ときは、止まったとみなす
      if (document.visibilityState === 'visible' && Date.now() - this.lastFrame > STALL_MS) this.interrupted();
    }, 1000);
    await this.keepAwake();
  }

  /** 録るのを止める（続けて録れる）。録った分は送る。 */
  pause(): void {
    this.release();
    this.flush();
  }

  /**
   * 止めて送り切り、1 つのファイルにする。
   *
   * @returns できたファイル
   */
  async finish(): Promise<{ id: string; name: string }> {
    this.pause();
    while (this.queue.length) await this.drain();
    this.closed = true;
    return api.recordings.finish(this.id, { meeting: this.mode === 'meeting' });
  }

  /** 録るのをやめて、途中の録音を消す。 */
  async cancel(): Promise<void> {
    this.closed = true;
    this.release();
    this.queue = [];
    this.filled = 0;
    await api.recordings.discard(this.id);
  }

  private onVisible = () => {
    if (!this.capturing) return;
    if (document.visibilityState === 'visible') {
      if (Date.now() - this.lastFrame > STALL_MS || this.context?.state !== 'running') this.interrupted();
      else void this.keepAwake();
    }
  };

  /** 画面が消えないようにする（スマホ）。使えないブラウザでは何もしない。 */
  private async keepAwake(): Promise<void> {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl || this.wake) return;
    try {
      const sentinel = await wl.request('screen');
      this.wake = sentinel;
      (sentinel as unknown as EventTarget).addEventListener?.('release', () => { if (this.wake === sentinel) this.wake = null; });
    } catch {
      // 断られても録音は続ける（画面が消えたら、止まったとして扱う）
    }
  }

  private interrupted(): void {
    if (!this.capturing) return;
    this.pause();
    this.h.onInterrupted();
  }

  private meetingEnded(): void {
    if (!this.capturing) return;
    this.pause();
    if (this.h.onMeetingEnded) this.h.onMeetingEnded();
    else this.h.onInterrupted();
  }

  private release(): void {
    this.capturing = false;
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    for (const track of this.display?.getTracks() ?? []) track.stop();
    this.display = null;
    if (this.context && this.context.state !== 'closed') void this.context.close();
    this.context = null;
    void this.wake?.release().catch(() => undefined);
    this.wake = null;
  }

  /** マイクの音（100 ミリ秒ずつ）を受ける。 */
  private take(frame: Float32Array): void {
    if (!this.capturing) return;
    this.lastFrame = Date.now();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = Math.max(-1, Math.min(1, frame[i] ?? 0));
      sum += v * v;
      this.buffer[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.samples++;
      if (this.filled === this.buffer.length) this.flush();
    }
    this.h.onLevel(Math.min(1, Math.sqrt(sum / Math.max(1, frame.length)) * 5));
    this.h.onSeconds(this.seconds);
    if (this.seconds >= LIVE_MAX_SEC) {
      this.pause();
      this.h.onLimit();
    }
  }

  /** たまった分を欠片にして送る列に入れる。 */
  private flush(): void {
    if (this.filled === 0) return;
    const pcm = new Blob([this.buffer.slice(0, this.filled)], { type: 'application/octet-stream' });
    this.queue.push({ seq: this.seq++, pcm });
    this.buffer = new Int16Array(RATE * PART_SEC);
    this.filled = 0;
    this.h.onPending(this.queue.length);
    // 受けられない欠片（3 時間を超えた・録音が消えた）は捨てる。止めるときの `finish()` が理由を返す
    if (!this.sending) this.sending = this.drain().catch(() => undefined).finally(() => { this.sending = null; });
  }

  /** 送る列を先頭から送る。失敗したら間を空けて送り直す。 */
  private async drain(): Promise<void> {
    // ほかで送っている最中なら、それが終わるのを待つ（同じ欠片を 2 か所から送らない）
    if (this.sending) await this.sending;
    let wait = 1000;
    while (this.queue.length && !this.closed) {
      const part = this.queue[0]!;
      try {
        await api.recordings.putPart(this.id, part.seq, part.pcm);
        this.queue.shift();
        this.h.onPending(this.queue.length);
        wait = 1000;
      } catch (err) {
        // 3 時間を超えた・録音が消えたものは送り直しても受けられない
        if (err instanceof ApiError && (err.status === 413 || err.status === 404 || err.status === 400)) {
          this.queue = [];
          this.h.onPending(0);
          throw err;
        }
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30_000);
      }
    }
  }
}
