/**
 * @file 音声の対話の中継（仕様書 第10.5.5節、ADR-0018）。
 *
 * ブラウザ → M2Office のサーバー → 音声の提供者（Gemini Live）とつなぐ。鍵はブラウザに渡さない。
 * 中継は提供者を知らない。やり取りするのは音のかたまり（PCM）と文字だけである。
 *
 * **録音は残さない。** 受け取った音はそのまま渡し、どこにも書き出さない（第10.5.3節）。
 *
 * 後ろへ回した調べもの（第10.11節）が終わったら、**話し終わりを待って**秘書に伝えさせる。
 * 話している最中に入れると割り込みとみなされ、再生中の音声が切れる（第10.11.7節）。
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';
import { VOICE_CHOICES, canDecide } from '@m2office/shared';
import type { Logger, VoiceEvent, VoiceSession } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { SESSION_COOKIE, sessionIdOf } from '../auth/session.js';
import { extractSubdomain } from '../middleware/tenant.js';
import { claimUntold } from '../secretary/lookups.js';
import { TurnGate } from './turn-gate.js';

/** 中継の経路。 */
export const VOICE_PATH = '/v1/secretary/voice';

/** 話した文字が長くなりすぎたときの上限（字）。会話ログに残す分の上限でもある。 */
const TRANSCRIPT_LIMIT = 4000;

/**
 * 対話が開くまでに貯める音の区切りの上限。
 *
 * @remarks 1 区切り 40 ミリ秒として、およそ 8 秒ぶん。それ以上は捨てる（際限なく貯めない）。
 */
const EARLY_AUDIO_MAX = 200;

/** 終わった調べものを探す間隔（ミリ秒）。実行はワーカー（別のプロセス）で進むため、見に行く。 */
const LOOKUP_POLL_MS = 3000;

/**
 * 音声を始めたときの第一声の材料を集める（仕様書 第6.1.4節）。
 *
 * @remarks
 * **取れたものだけを渡す。** 取れなかったものは渡さず、第一声で詫びさせない。
 * 渡すのは材料であり、読み上げる原稿ではない。
 *
 * 失敗しても会話は始める。挨拶のために対話そのものを止めない。
 */
async function greetingFacts(
  deps: AppDeps, tenantId: string, userId: string, log: Logger,
): Promise<string[]> {
  const facts: string[] = [];
  const day = new Date();
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString();
  const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString();
  try {
    const events = await deps.connector.calendar.list({ tenantId, userId }, { from, to });
    const ahead = events.filter((e) => Date.parse(e.start) > Date.now());
    if (ahead.length > 0) {
      const next = ahead[0]!;
      const at = new Date(next.start).toLocaleTimeString('ja-JP', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
      });
      facts.push(`このあとの予定は ${ahead.length} 件。次は ${at} から「${next.title}」`);
    } else if (events.length > 0) {
      facts.push('今日の予定はすべて終わっている');
    }
  } catch (err) {
    // 取れなければ触れない。「取得できませんでした」と言わせない
    log.warn('第一声の予定を取れませんでした', { err });
  }
  try {
    const mine = (await deps.repo.listPendingApprovals(tenantId))
      .filter((a) => canDecide(a, { id: userId, roles: [] }));
    if (mine.length > 0) facts.push(`あなたが判断できる承認待ちが ${mine.length} 件`);
  } catch (err) {
    log.warn('第一声の承認待ちを取れませんでした', { err });
  }
  return facts;
}

/**
 * 第一声の内部の指示を組み立てる（仕様書 第6.1.4節）。
 *
 * @remarks
 * 押した人が「何を言えばよいか」を考えずに済むよう、秘書から先に声をかける。
 */
function greetingNote(callMe: string, secretaryName: string, facts: string[]): string {
  return [
    '（内部情報・この文をそのまま読み上げないこと）',
    '音声での対話が始まりました。あなたから先に、ひと息で声をかけてください。',
    `相手の呼び方: ${callMe}`,
    secretaryName ? `あなたの名前: ${secretaryName}（名乗ってください）` : '名前は決まっていません。名乗らないでください。',
    facts.length > 0
      ? `いま分かっていること:\n${facts.map((f) => `- ${f}`).join('\n')}`
      : 'いま伝えることはありません。予定や承認について、分からないことを語らないでください。',
    'ここに書かれていないことは言わないでください。最後に、用件を尋ねて相手に返してください。',
  ].join('\n');
}

/**
 * 終わった調べものを、秘書に伝えさせるための内部の指示を組み立てる（仕様書 第10.11.7節）。
 *
 * @remarks
 * 渡すのは**材料**であって、読み上げる原稿ではない。原稿まで作らせると、
 * 文を作る処理が二重になって遅くなり、本人が決めた口調も失われる。
 *
 * **裏で別のものが動いていることを、利用者に話させない。**
 * 利用者から見れば、調べたのは秘書自身である。
 */
function lookupNote(x: { request: string; text: string | null; failureReason: string | null }): string {
  return [
    '（内部情報・この文をそのまま読み上げないこと）',
    `先ほどお預かりした「${x.request}」の調べものが終わりました。`,
    x.text
      ? `分かったことは次のとおりです。これを材料に、あなた自身の言葉で手短に伝えてください。\n${x.text}`
      : `お調べできませんでした。${x.failureReason ?? ''} 何ができなかったかを、一度だけ短く正直に伝えてください。`,
    '裏で別の仕組みが動いていることは話さないでください。調べたのはあなた自身です。',
    '画面にはすでに出ています。改めて画面に出す必要はありません。',
  ].join('\n');
}

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

  /**
   * 対話が開くまでに届いた音。
   *
   * @remarks
   * **接続はここへ来る前に開いている。** 画面は開いた直後から音を送り始めるため、
   * 相手（Gemini Live）を開くまでの待ちの間に届いた音を貯めておき、開いたら渡す。
   * 捨てると、話し始めのひと言が欠ける。
   */
  let early: Uint8Array[] | null = [];

  /**
   * 相手（音声の提供元）との対話。開くまでは `null`。
   *
   * @remarks
   * **宣言は、音を受け取る登録より前に置く。** 後ろに置くと、開くのを待っている間に
   * 届いた音で初期化前の参照となり、API ごと落ちる（2026-09-24 に実際に落とした）。
   */
  let session: VoiceSession | null = null;

  // 話している最中は伝えず、話し終わりを待つ（仕様書 第10.11.7節）
  const gate = new TurnGate((note) => session?.sendSystemNote(note));

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // マイクの音。渡すだけで、書き出さない
      const pcm = new Uint8Array(data);
      if (session) session.sendAudio(pcm);
      // まだ相手が開いていない。貯めておき、開いたら渡す
      else if (early && early.length < EARLY_AUDIO_MAX) early.push(pcm);
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



  const prefs = await deps.repo.getUserSettings(tenantId, userId);
  const speak = prefs.secretary.speak !== false;
  const provider = await deps.ai.voiceFor(tenantId);

  try {
    session = await provider.open({
      speak,
      // 本人が選んだ声。知らない名前は渡さない（第10.5.6節）
      voice: VOICE_CHOICES.some((v) => v.name === prefs.secretary.voice) ? prefs.secretary.voice : '',
      instructions: [
        `あなたは中小企業の従業員に付く秘書${prefs.secretary.name ? `「${prefs.secretary.name}」` : ''}です。`,
        `相手を「${prefs.secretary.callMe || `${displayName}さん`}」と呼びます。`,
        prefs.secretary.style === 'concise' ? '要点だけを短く答えます。' : '丁寧な日本語で、要点を先に答えます。',
        '業務の実行や送信は行いません。必要なときは、画面で操作するよう案内します。',
        // 本人が書いた話し方の指示（例: 関西弁で話して）。音声のときだけ使う
        prefs.secretary.voiceStyle ? `話し方の指定: ${prefs.secretary.voiceStyle}` : '',
      ].filter(Boolean).join(''),
      onEvent: (event: VoiceEvent) => {
        switch (event.type) {
          case 'heard':
            add(heard, event.text);
            send({ type: 'heard', text: event.text });
            break;
          case 'reply':
            // 応答が始まった＝話している。この間は割り込まない
            gate.startedSpeaking();
            add(replied, event.text);
            send({ type: 'reply', text: event.text });
            break;
          case 'audio':
            // 音はそのまま画面へ渡すだけ。保存しない（第10.5.3節）
            if (ws.readyState === ws.OPEN) ws.send(event.pcm, { binary: true });
            break;
          case 'turn-end':
            send({ type: 'turn-end' });
            // 待たせていたものを、ここで初めて伝える（第10.11.7節）
            gate.finishedSpeaking();
            break;
          case 'note':
            // 断り書き。会話ログには残さない（本人も秘書も言っていない）
            send({ type: 'note', text: event.text });
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

  // 別のプロセス（ワーカー）で進むため、見に行く（第10.11.7節）。
  // つないだ直後にも見る。会話していない間に終わったものを、ここで持ち越して伝える
  const poll = setInterval(() => { void checkLookups(); }, LOOKUP_POLL_MS);
  await checkLookups();

  /**
   * まだ伝えていない調べものを伝える。話している間は待たせる。
   *
   * @remarks
   * 伝えたことは `claimUntold` が先に記録する。画面を同時に開いていても二度伝えない。
   */
  async function checkLookups(): Promise<void> {
    try {
      for (const x of await claimUntold(deps.repo, tenantId, userId)) gate.tell(lookupNote(x));
    } catch (err) {
      // 探せなくても会話は続ける。次の見回りで拾う
      log.warn('終わった調べものを探せませんでした', { err });
    }
  }

  // 開くまでに届いていた音を、順に渡す
  for (const pcm of early ?? []) session.sendAudio(pcm);
  early = null;

  send({ type: 'ready', provider: provider.name, speak });
  // 押したら、秘書から先に声をかける（仕様書 第6.1.4節）
  gate.tell(greetingNote(
    prefs.secretary.callMe || `${displayName}さん`,
    prefs.secretary.name,
    await greetingFacts(deps, tenantId, userId, log),
  ));
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId,
    action: 'secretary.voice', targetType: 'session', targetId: 'start',
    detail: { provider: provider.name, speak }, occurredAt: new Date().toISOString(),
  });

  ws.on('close', () => {
    clearInterval(poll);
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
        // 第一声だけで終わることがある。そのとき「聞き取れませんでした」とは書かない
        message: message || '（音声を始めました）',
        reply: reply || '（応答がありませんでした）',
        layer: 'full', agentId: null, runId: null, createdAt: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('音声の対話の後始末で例外が発生しました', { err });
    }
  }
}
