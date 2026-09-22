/**
 * @file Gemini への接続の確認（文章と音声）。管理者ページの「接続の確認」から呼ぶ。
 *
 * 文章はモデルを 1 回だけ呼ぶ。音声は Gemini Live の WebSocket を開き、setupComplete が来たら閉じる
 * （AI Radio の `server/lib/live-client.js` の接続先と setup の形を引き継ぐ）。
 * 鍵は URL に付けてサーバーから直接つなぐ。ブラウザには渡さない。
 *
 * @see 仕様書 第14.3.3節「Gemini」
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export type CheckResult = { ok: true; ms: number } | { ok: false; ms: number; error: string };

/** 文章のモデルを 1 回呼んで確かめる。 */
export async function checkGeminiText(apiKey: string, model: string, base = BASE): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '「はい」とだけ答えてください。' }] }], generationConfig: { maxOutputTokens: 8 } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, ms: Date.now() - started, error: json.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Gemini Live の接続を開き、準備ができたら閉じる。 */
export function checkGeminiLive(apiKey: string, model: string, url = LIVE_URL, timeoutMs = 15_000): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: CheckResult, ws?: WebSocket) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* 閉じられなくても結果は返す */ }
      resolve(r);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${url}?key=${encodeURIComponent(apiKey)}`);
    } catch (err) {
      finish({ ok: false, ms: 0, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => finish({ ok: false, ms: Date.now() - started, error: '時間内に応答がありませんでした' }, ws), timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ setup: { model: model.startsWith('models/') ? model : `models/${model}`, generationConfig: { responseModalities: ['AUDIO'] } } }));
    });
    ws.addEventListener('message', async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : await new Blob([ev.data as ArrayBuffer]).text();
      if (text.includes('setupComplete')) {
        clearTimeout(timer);
        finish({ ok: true, ms: Date.now() - started }, ws);
      }
    });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      finish({ ok: false, ms: Date.now() - started, error: ev.reason || `接続が閉じられました（${ev.code}）` });
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish({ ok: false, ms: Date.now() - started, error: '接続できませんでした' }, ws);
    });
  });
}
