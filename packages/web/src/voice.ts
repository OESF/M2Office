/**
 * @file 音声の対話（画面側）。マイクの音を送り、応答の文字と音を受け取る。
 *
 * 提供者（Gemini Live）を知らない。サーバーの中継とやり取りするのは、
 * 音のかたまり（PCM）と文字だけである（仕様書 第10.5.4節、ADR-0018）。
 *
 * **録音は残さない。** マイクの音は送ったら捨て、応答の音も鳴らしたら捨てる（第10.5.3節）。
 */

/** 送りの標本化周波数（サーバーと合わせる）。 */
const INPUT_HZ = 16_000;
/** 受けの標本化周波数。 */
const OUTPUT_HZ = 24_000;
/** 1 回に送る音の長さ（ミリ秒）。 */
const CHUNK_MS = 100;

/** 対話の中で画面に伝えること。 */
export interface VoiceHandlers {
  /** 聞こえた文字（本人の発話）。 */
  onHeard(text: string): void;
  /** 秘書の応答の文字。 */
  onReply(text: string): void;
  /** 状態が変わった（つないだ・終わった・失敗した）。 */
  onState(state: 'connecting' | 'listening' | 'closed', note?: string): void;
  /**
   * 秘書のキャンバスに出す答え（仕様書 第6.2.0節）。画面の入力に答えたときと同じ形で出す。
   * 届くのは、答えが大きいときと、本人が「画面に出して」と言ったときだけ（ほかは声だけで返す）
   */
  onAnswer?(answer: VoiceAnswer): void;
}

/** 音声の依頼に、秘書の取次が返した答え（画面の入力の応答と同じ形の一部）。 */
export interface VoiceAnswer {
  request: string;
  reply: {
    text: string;
    layer: string;
    evidence: { label: string; value: string; kind?: 'source' }[];
    suggestedAgent?: { id: string; version: number; name: string };
    helpArticles?: { id: string; title: string }[];
    lookup?: { runId: string; request: string };
  };
}

/** 開いている対話。画面はこれを持ち、終わるときに `stop()` を呼ぶ。 */
export interface VoiceCall {
  stop(): void;
}

/** マイクの音（Float32）を 16 ビットの PCM に直す。 */
function toPcm16(input: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i++) {
    const v = Math.max(-1, Math.min(1, input[i] ?? 0));
    out.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** 受け取った PCM を、鳴らせる形（Float32）に直す。 */
function fromPcm16(bytes: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes);
  // 音の置き場（AudioBuffer）は共有でない領域を要求するため、型でもそう示す
  const out = new Float32Array(new ArrayBuffer(bytes.byteLength * 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/**
 * マイクの口が無いときの理由。
 *
 * @remarks
 * 多くは「安全な文脈でない」ことによる。設定では直せないため、そう伝える。
 */
function micUnavailableReason(): string {
  if (!window.isSecureContext) {
    return `この画面は ${location.protocol}//${location.host} で開かれているため、ブラウザがマイクを使わせません。`
      + 'https で開くか、localhost で開いてください（ブラウザの設定では変えられません）';
  }
  return 'このブラウザはマイクに対応していません';
}

/**
 * マイクを取れなかった理由を、直せる形で伝える。
 *
 * @remarks
 * 「許可してください」と言ってよいのは、本人が断ったときだけである。
 * 機器が無い・ほかのアプリが使っている場合に許可を求めても直らない。
 */
function micErrorReason(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'マイクの使用が許可されませんでした。ブラウザのアドレス欄のマイクの印から許可してください';
    case 'NotFoundError':
      return 'マイクが見つかりませんでした。端末にマイクがつながっているか確かめてください';
    case 'NotReadableError':
      return 'マイクを使えませんでした。ほかのアプリが使っていないか確かめてください';
    default:
      return `マイクを使えませんでした（${name || '理由不明'}）`;
  }
}

/**
 * 音声の対話を始める。
 *
 * @param handlers 画面へ伝える口
 * @returns 開いた対話。失敗した場合も `onState('closed', 理由)` で知らせる
 *
 * @remarks
 * マイクの許可はブラウザが本人に尋ねる。許可されなければ始めない。
 * 認証はログイン状態の Cookie による（同じ生成元へつなぐ）。
 */
export async function startVoice(handlers: VoiceHandlers): Promise<VoiceCall> {
  handlers.onState('connecting');

  // ブラウザは、安全な文脈（HTTPS か localhost）でしかマイクを使わせない。
  // それ以外では navigator.mediaDevices 自体が無く、**許可を尋ねる画面も出ない**。
  // ここで「設定で許可してください」と言うと、できないことを指示することになる
  if (!navigator.mediaDevices?.getUserMedia) {
    handlers.onState('closed', micUnavailableReason());
    return { stop: () => undefined };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  } catch (err) {
    handlers.onState('closed', micErrorReason(err));
    return { stop: () => undefined };
  }

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/secretary/voice`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const input = new AudioContext({ sampleRate: INPUT_HZ });
  const output = new AudioContext({ sampleRate: OUTPUT_HZ });
  let playAt = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { ws.close(); } catch { /* すでに閉じている */ }
    for (const track of stream.getTracks()) track.stop();
    void input.close();
    void output.close();
    handlers.onState('closed');
  };

  ws.addEventListener('open', async () => {
    // マイクの音を一定の長さに区切って送る
    await input.audioWorklet.addModule(
      URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })),
    );
    const node = new AudioWorkletNode(input, 'm2o-mic', { processorOptions: { frames: (INPUT_HZ * CHUNK_MS) / 1000 } });
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(toPcm16(ev.data));
    };
    input.createMediaStreamSource(stream).connect(node);
    // 音を出さずに動かすため、無音の行き先へつなぐ
    const silent = input.createGain();
    silent.gain.value = 0;
    node.connect(silent).connect(input.destination);
    handlers.onState('listening');
  });

  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      // 応答の音。鳴らしたら捨てる
      const samples = fromPcm16(ev.data);
      const buffer = output.createBuffer(1, samples.length, OUTPUT_HZ);
      buffer.copyToChannel(samples, 0);
      const source = output.createBufferSource();
      source.buffer = buffer;
      source.connect(output.destination);
      playAt = Math.max(playAt, output.currentTime);
      source.start(playAt);
      playAt += buffer.duration;
      return;
    }
    try {
      const message = JSON.parse(String(ev.data)) as { type: string; text?: string; reason?: string; message?: string } & Partial<VoiceAnswer>;
      if (message.type === 'secretary' && message.reply && typeof message.request === 'string') {
        handlers.onAnswer?.({ request: message.request, reply: message.reply });
      }
      if (message.type === 'heard' && message.text) handlers.onHeard(message.text);
      if (message.type === 'reply' && message.text) handlers.onReply(message.text);
      // 断り書き（選んだ声が使えなかった、など）。やり取りではないので帯の知らせに出す
      if (message.type === 'note' && message.text) handlers.onState('listening', message.text);
      if (message.type === 'error') { handlers.onState('closed', message.message); stop(); }
      if (message.type === 'closed') stop();
    } catch {
      // 読めない知らせは無視する
    }
  });

  ws.addEventListener('close', () => stop());
  ws.addEventListener('error', () => {
    handlers.onState('closed', '音声につなげませんでした');
    stop();
  });

  return { stop };
}

/**
 * マイクの音を一定の長さにまとめて渡す処理（AudioWorklet）。
 *
 * @remarks 画面の描画を止めないよう、音の処理は別の系統で行う。
 */
const WORKLET = `
class M2oMic extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frames = options.processorOptions.frames;
    this.buffer = new Float32Array(this.frames);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.frames) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('m2o-mic', M2oMic);
`;
