/**
 * @file Gemini Live による音声の対話（仕様書 第10.5節、ADR-0018）。
 *
 * Gemini Live 固有のメッセージ（`setup`・`realtimeInput`・`serverContent`）は、このファイルの中だけに置く。
 * 接続の確認（`secrets/gemini-check.ts`）と同じ接続先・同じ `setup` の形を使う。
 *
 * 鍵はサーバーだけが持つ。ブラウザには渡さない（ADR-0007 決定 7）。
 */

import { AUDIO, type VoiceEvent, type VoiceProvider, type VoiceSession, type VoiceSessionOptions, type VoiceTool } from './provider.js';

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
  /** ツールの呼び出し（仕様書 第10.5.7節）。 */
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] };
  /** 音声の相手が取りやめた呼び出し（本人が話をさえぎったときなど）。 */
  toolCallCancellation?: { ids?: string[] };
  /** 使った量（AI の利用の記録に使う。第6.6.2節）。 */
  usageMetadata?: { promptTokenCount?: number; responseTokenCount?: number; totalTokenCount?: number };
}

/** ツールを Gemini の関数の宣言にする。型の名前は大文字で書く（Gemini の決まり）。 */
function declarations(tools: VoiceTool[]) {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: 'OBJECT',
        properties: Object.fromEntries(Object.entries(t.parameters).map(([k, v]) => [k, { type: 'STRING', description: v.description }])),
        required: t.required,
      },
    })),
  }];
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

  /**
   * 音声の対話を開く。
   *
   * @remarks
   * **選んだ声を相手が受け付けないことがある。** 声の一覧は提供者の更新で変わり、
   * こちらの一覧が先に古くなる。そのときは**既定の声で開き直す**。
   * 声が合わないだけで音声そのものが使えなくなるのは、割に合わない（仕様書 第10.5.6節）。
   */
  async open(session: VoiceSessionOptions): Promise<VoiceSession> {
    try {
      return await this.connect(session);
    } catch (err) {
      if (!session.voice) throw err;
      // 声を外してもう一度だけ試す。これで開けるなら、原因は声である
      const retried = await this.connect({ ...session, voice: '' });
      session.onEvent({
        type: 'note',
        text: `「${session.voice}」の声は使えなかったため、既定の声でお話しします。`,
      });
      return retried;
    }
  }

  private async connect(session: VoiceSessionOptions): Promise<VoiceSession> {
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
              // 常に音声で求める。現行のモデル（gemini-3.1-flash-live-preview）は文字だけ（TEXT）を断り、
              // 「The requested combination of response modalities (TEXT) is not supported」で接続を切る
              // （2026-09-27 に実機で確認）。声で答えない人には、受け取った音を渡さずに捨てる（第10.5.5節）
              responseModalities: ['AUDIO'],
              // 声（第10.5.6節）。選ばれていなければ提供者の既定に任せる。
              // `speechConfig` は `generationConfig` の中に置く。`setup` の直下に置くと
              // 「Unknown name "speechConfig" at 'setup'」で接続を断られる（2026-09-23 に実機で確認）
              ...(session.speak && session.voice
                ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voice } } } }
                : {}),
            },
            systemInstruction: { parts: [{ text: session.instructions }] },
            // 秘書の取次を呼ぶ道（仕様書 第10.5.7節）。渡さなければ話し相手だけになる
            ...(session.tools && session.tools.length > 0 ? { tools: declarations(session.tools) } : {}),
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
    // 取りやめられた呼び出し。結果が出ても返さない
    const cancelled = new Set<string>();
    ws.addEventListener('message', async (ev) => {
      const message = await parseMessage(ev.data);
      const used = message?.usageMetadata;
      if (used && session.onUsage) {
        const input = used.promptTokenCount ?? 0;
        const output = used.responseTokenCount ?? Math.max(0, (used.totalTokenCount ?? 0) - input);
        if (input || output) session.onUsage({ model: this.options.model, inputTokens: input, outputTokens: output });
      }
      for (const id of message?.toolCallCancellation?.ids ?? []) cancelled.add(id);
      if (message?.toolCall?.functionCalls?.length) {
        await answerToolCalls(message.toolCall.functionCalls);
        return;
      }
      const content = message?.serverContent;
      if (!content) return;
      if (content.inputTranscription?.text) emit({ type: 'heard', text: content.inputTranscription.text });
      if (content.outputTranscription?.text) emit({ type: 'reply', text: content.outputTranscription.text });
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.text) emit({ type: 'reply', text: part.text });
        // 音は渡すだけ。ここでは書き出さない（第10.5.3節）。声で答えない人には渡さず、ここで捨てる
        if (part.inlineData?.data && session.speak) {
          emit({ type: 'audio', pcm: new Uint8Array(Buffer.from(part.inlineData.data, 'base64')) });
        }
      }
      if (content.turnComplete) emit({ type: 'turn-end' });
    });
    ws.addEventListener('close', (ev) => {
      emit({ type: 'closed', reason: ev.reason || '接続が終わりました' });
    });

    /**
     * ツールの呼び出しに答える（仕様書 第10.5.7節）。知らないツールと、ツールの失敗は、断りの文で返す。
     *
     * @remarks 返すまで音声の相手は待つ。結果は話し終わりを待たずに返してよい（相手が求めているため）
     */
    async function answerToolCalls(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
      const responses = [];
      for (const call of calls) {
        const tool = session.tools?.find((t) => t.name === call.name);
        let response: Record<string, unknown>;
        if (!tool) {
          response = { error: 'そのツールはありません' };
        } else {
          try {
            const args = Object.fromEntries(Object.entries(call.args ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : String(v ?? '')]));
            response = await tool.run(args);
          } catch {
            response = { error: '処理できませんでした。画面の入力欄でもう一度お試しください' };
          }
        }
        if (call.id && cancelled.has(call.id)) continue;
        responses.push({ ...(call.id ? { id: call.id } : {}), name: call.name ?? '', response });
      }
      if (responses.length === 0 || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }

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
