/**
 * @file Gemini Live による音声の対話（仕様書 第10.5節、ADR-0018）。
 *
 * Gemini Live 固有のメッセージ（`setup`・`realtimeInput`・`serverContent`）は、このファイルの中だけに置く。
 * 接続の確認（`secrets/gemini-check.ts`）と同じ接続先・同じ `setup` の形を使う。
 *
 * 鍵はサーバーだけが持つ。ブラウザには渡さない（ADR-0007 決定 7）。
 */

import { AUDIO, type VoiceEvent, type VoiceProvider, type VoiceSession, type VoiceSessionOptions } from './provider.js';

const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** 接続できるまで待つ時間（ミリ秒）。 */
const SETUP_TIMEOUT_MS = 15_000;

/** Gemini Live から届くメッセージのうち、使う部分だけ。 */
interface LiveMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { text?: string; inlineData?: { data?: string; mimeType?: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
}

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  /** 接続先。試験で差し替える。 */
  url?: string;
}

/**
 * Gemini Live の提供者。
 *
 * @remarks
 * 音は素の PCM でやり取りする。送りは 16 kHz、受けは 24 kHz（第10.5.5節）。
 * 受け取った音は呼び出し側へ渡すだけで、このファイルでは書き出さない（第10.5.3節）。
 */
export class GeminiLiveProvider implements VoiceProvider {
  readonly name = 'gemini-live';

  constructor(private readonly options: GeminiLiveOptions) {}

  async open(session: VoiceSessionOptions): Promise<VoiceSession> {
    const url = `${this.options.url ?? LIVE_URL}?key=${encodeURIComponent(this.options.apiKey)}`;
    const ws = new WebSocket(url);
    const model = this.options.model.startsWith('models/') ? this.options.model : `models/${this.options.model}`;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('音声の接続が時間内に始まりませんでした')), SETUP_TIMEOUT_MS);
      const fail = (reason: string) => { clearTimeout(timer); reject(new Error(reason)); };
      ws.addEventListener('error', () => fail('音声につなげませんでした'));
      ws.addEventListener('close', (ev) => fail(ev.reason || `音声の接続が閉じられました（${ev.code}）`));
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({
          setup: {
            model,
            generationConfig: {
              // 読み上げを切っている人には音声を作らせない（第10.5.5節）
              responseModalities: session.speak ? ['AUDIO'] : ['TEXT'],
              // 声（第10.5.6節）。選ばれていなければ提供者の既定に任せる。
              // `speechConfig` は `generationConfig` の中に置く。`setup` の直下に置くと
              // 「Unknown name "speechConfig" at 'setup'」で接続を断られる（2026-09-23 に実機で確認）
              ...(session.speak && session.voice
                ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voice } } } }
                : {}),
            },
            systemInstruction: { parts: [{ text: session.instructions }] },
            // 聞こえた文字と応答の文字を必ず受け取る（画面への併記と会話ログに使う。第10.5.2節）
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        }));
      });
      ws.addEventListener('message', async (ev) => {
        const message = await parseMessage(ev.data);
        if (message?.setupComplete === undefined) return;
        clearTimeout(timer);
        resolve();
      }, { once: false });
    });

    const emit = (event: VoiceEvent) => session.onEvent(event);
    ws.addEventListener('message', async (ev) => {
      const message = await parseMessage(ev.data);
      const content = message?.serverContent;
      if (!content) return;
      if (content.inputTranscription?.text) emit({ type: 'heard', text: content.inputTranscription.text });
      if (content.outputTranscription?.text) emit({ type: 'reply', text: content.outputTranscription.text });
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.text) emit({ type: 'reply', text: part.text });
        // 音は渡すだけ。ここでは書き出さない（第10.5.3節）
        if (part.inlineData?.data && session.speak) {
          emit({ type: 'audio', pcm: new Uint8Array(Buffer.from(part.inlineData.data, 'base64')) });
        }
      }
      if (content.turnComplete) emit({ type: 'turn-end' });
    });
    ws.addEventListener('close', (ev) => {
      emit({ type: 'closed', reason: ev.reason || '接続が終わりました' });
    });

    /** 1 往復分の文字を送る。 */
    const sendTurn = (text: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
      }));
    };

    return {
      sendAudio(pcm) {
        if (ws.readyState !== WebSocket.OPEN) return;
        // `realtimeInput.audio` で送る。以前の `mediaChunks` は Gemini 側で廃止され、
        // 送ると「realtime_input.media_chunks is deprecated」で接続を切られる（2026-09-23 に実機で確認）
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: `audio/pcm;rate=${AUDIO.inputHz}`,
              data: Buffer.from(pcm).toString('base64'),
            },
          },
        }));
      },
      sendText: sendTurn,
      // 送り方は文字と同じだが、意味が違う。利用者の発言ではなく、秘書への内部の指示である
      sendSystemNote: sendTurn,
      close() {
        try { ws.close(); } catch { /* すでに閉じていることがある */ }
      },
    };
  }
}

/** 届いたメッセージを JSON として読む。読めない形は無視する。 */
async function parseMessage(data: unknown): Promise<LiveMessage | null> {
  try {
    if (typeof data === 'string') return JSON.parse(data) as LiveMessage;
    if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString('utf8')) as LiveMessage;
    if (data instanceof Blob) return JSON.parse(await data.text()) as LiveMessage;
    return null;
  } catch {
    return null;
  }
}
