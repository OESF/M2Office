/**
 * @file 音声の対話の中継（仕様書 第10.5.5節、ADR-0018）。
 *
 * ブラウザ → M2Office のサーバー → 音声の提供者（Gemini Live）とつなぐ。鍵はブラウザに渡さない。
 * 中継は提供者を知らない。やり取りするのは音のかたまり（PCM）と文字だけである。
 *
 * **録音は残さない。** 受け取った音はそのまま渡し、どこにも書き出さない（第10.5.3節）。
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';
import type { VoiceEvent, VoiceSession } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { SESSION_COOKIE, sessionIdOf } from '../auth/session.js';
import { extractSubdomain } from '../middleware/tenant.js';

/** 中継の経路。 */
export const VOICE_PATH = '/v1/secretary/voice';

/** 話した文字が長くなりすぎたときの上限（字）。会話ログに残す分の上限でもある。 */
const TRANSCRIPT_LIMIT = 4000;

/** Cookie の文字列から 1 つ取り出す。 */
function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * つないできた相手を確かめる（仕様書 第20.7節）。
 *
 * @remarks
 * ブラウザの WebSocket はヘッダーを付けられないため、ログイン状態の Cookie で確かめる。
 * 開発用のヘッダー（`AUTH_DEV_HEADERS=true`）は、動作確認のスクリプトのためだけに受け付ける。
 */
async function authenticate(deps: AppDeps, req: IncomingMessage) {
  const host = req.headers.host ?? '';
  const devTenant = deps.auth.devHeaders ? (req.headers['x-tenant'] as string | undefined) : undefined;
  const subdomain = devTenant ?? extractSubdomain(host);
  if (!subdomain) return null;
  const tenant = await deps.repo.findTenantBySubdomain(subdomain);
  // 停止中・緊急停止・解約済みの会社では開かない（第23.8.6節）
  if (!tenant || (tenant.status !== 'active' && tenant.status !== 'trial')) return null;

  const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (token) {
    const session = await deps.repo.findActiveSession(tenant.id, sessionIdOf(token), new Date());
    const user = session ? await deps.repo.findUserById(tenant.id, session.userId) : null;
    if (user && user.status === 'active') return { tenant, user };
  }
  const email = deps.auth.devHeaders ? (req.headers['x-user'] as string | undefined) : undefined;
  if (email) {
    const user = await deps.repo.findUserByEmail(tenant.id, email);
    if (user && user.status === 'active') return { tenant, user };
  }
  return null;
}

/**
 * 音声の中継を、HTTP サーバーに取り付ける。
 *
 * @param server `@hono/node-server` が返すサーバー
 *
 * @remarks
 * テナント境界: つないだ時点で会社と利用者を確定し、以降のすべてに持ち回る（不変則 I-2）。
 */
export function attachVoiceRelay(deps: AppDeps, server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== VOICE_PATH) return;
    void (async () => {
      const who = await authenticate(deps, req);
      if (!who) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void start(deps, ws, who.tenant.id, who.user.id, who.user.displayName);
      });
    })();
  });
}

/** 1 つの対話を中継する。 */
async function start(
  deps: AppDeps, ws: NodeWebSocket, tenantId: string, userId: string, displayName: string,
): Promise<void> {
  const log = deps.log.child({ tenantId, userId });
  const startedAt = Date.now();
  // 画面に併記し、終わったら会話ログへ残す（第10.5.2・10.5.5節）。音は残さない
  const heard: string[] = [];
  const replied: string[] = [];
  const add = (into: string[], text: string) => {
    if (into.join('').length < TRANSCRIPT_LIMIT) into.push(text);
  };
  const send = (payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  const prefs = await deps.repo.getUserSettings(tenantId, userId);
  const speak = prefs.secretary.speak !== false;
  const provider = await deps.ai.voiceFor(tenantId);

  let session: VoiceSession | null = null;
  try {
    session = await provider.open({
      speak,
      instructions: [
        `あなたは中小企業の従業員に付く秘書${prefs.secretary.name ? `「${prefs.secretary.name}」` : ''}です。`,
        `相手を「${prefs.secretary.callMe || `${displayName}さん`}」と呼びます。`,
        prefs.secretary.style === 'concise' ? '要点だけを短く答えます。' : '丁寧な日本語で、要点を先に答えます。',
        '業務の実行や送信は行いません。必要なときは、画面で操作するよう案内します。',
      ].join(''),
      onEvent: (event: VoiceEvent) => {
        switch (event.type) {
          case 'heard':
            add(heard, event.text);
            send({ type: 'heard', text: event.text });
            break;
          case 'reply':
            add(replied, event.text);
            send({ type: 'reply', text: event.text });
            break;
          case 'audio':
            // 音はそのまま画面へ渡すだけ。保存しない（第10.5.3節）
            if (ws.readyState === ws.OPEN) ws.send(event.pcm, { binary: true });
            break;
          case 'turn-end':
            send({ type: 'turn-end' });
            break;
          case 'closed':
            send({ type: 'closed', reason: event.reason });
            ws.close();
            break;
        }
      },
    });
  } catch (err) {
    log.warn('音声の対話を開けませんでした', { err });
    send({ type: 'error', message: '音声の対話を始められませんでした。しばらくしてからお試しください' });
    ws.close();
    return;
  }

  send({ type: 'ready', provider: provider.name, speak });
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId,
    action: 'secretary.voice', targetType: 'session', targetId: 'start',
    detail: { provider: provider.name, speak }, occurredAt: new Date().toISOString(),
  });

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // マイクの音。渡すだけで、書き出さない
      session?.sendAudio(new Uint8Array(data));
      return;
    }
    try {
      const message = JSON.parse(data.toString('utf8')) as { type?: string; text?: string };
      if (message.type === 'text' && message.text) session?.sendText(message.text);
      if (message.type === 'stop') ws.close();
    } catch {
      // 読めない指示は無視する
    }
  });

  ws.on('close', () => {
    session?.close();
    void finish();
  });

  /** 終わったときに、聞こえた文字と応答を会話ログへ残す（第11.9.4.1節）。 */
  async function finish(): Promise<void> {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    try {
      await deps.repo.appendAudit({
        id: randomUUID(), tenantId, actorType: 'user', actorId: userId,
        action: 'secretary.voice', targetType: 'session', targetId: 'end',
        // 話した中身は入れない（第10.5.5節）
        detail: { seconds }, occurredAt: new Date().toISOString(),
      });
      const message = heard.join('').trim();
      const reply = replied.join('').trim();
      if (!message && !reply) return;
      if (!prefs.memory.keepConversations) return;
      await deps.repo.appendConversation({
        id: randomUUID(), tenantId, userId,
        message: message || '（聞き取れませんでした）',
        reply: reply || '（応答がありませんでした）',
        layer: 'full', agentId: null, runId: null, createdAt: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('音声の対話の後始末で例外が発生しました', { err });
    }
  }
}
