/**
 * @file Chat で秘書に頼む（仕様書 第10.16.3節、ADR-0138）。Chat アプリに届いた発言を、送った人の秘書に渡し、答えを Chat に返す。
 *
 * 受け取るのは、アプリとの個別メッセージと、スペースでアプリに言及した発言だけ（Google の決まり。第10.16.2節）。
 * 答えは、個別メッセージならそのまま、スペースなら**言及した人にだけ見える形**で返す（本人の予定や記憶が混ざるため）。
 * 会社の利用者でない人には、頼みを扱わずに一言だけ返す。後ろへ回した依頼は、終わったら同じ場所に結果を返す。
 * 承認は Chat の中ではしない。承認の画面へのリンクを返す。本人が Chat で頼んだことの答えは、控える時（夜・休みの日）でも返す。
 *
 * テナント境界: 受けた口（受け口の鍵か、会社の Pub/Sub の購読）で会社を決め、送った人をその会社の中だけで探す（不変則 I-2）。
 */

import { randomUUID } from 'node:crypto';
import {
  ChatAppClients, chatReplyText, parseChatEvent, type ChatInboxStore, type Logger, type Repository, type Secretary, type WorkspaceConnector, type SecretBox,
} from '@m2office/core';
import type { User } from '@m2office/shared';
import { listLookups, rememberLookup } from '../secretary/lookups.js';

/** 会社の利用者でない人への一言。 */
export const CHAT_NOT_A_USER = 'この会社の M2Office の利用者だけが使えます。';
/** 受け取りの記録と返す先を残す日数。 */
const KEEP_DAYS = 7;

/** Chat への返し方（会社の Chat アプリ。見本の会社は控えるだけ）。 */
export interface ChatReplySender {
  reply(tenantId: string, space: string, text: string, opts: { thread?: string | null; privateViewer?: string | null }): Promise<boolean>;
}

/** 見本の返し方。送ったことにして控える（開発と自動のテスト）。 */
export class MockChatReplySender implements ChatReplySender {
  readonly outbox: { tenantId: string; space: string; text: string; thread: string | null; privateViewer: string | null }[] = [];

  async reply(tenantId: string, space: string, text: string, opts: { thread?: string | null; privateViewer?: string | null }): Promise<boolean> {
    this.outbox.push({ tenantId, space, text, thread: opts.thread ?? null, privateViewer: opts.privateViewer ?? null });
    return true;
  }
}

/** 会社の Chat アプリから返す（アプリとして送る。本人にだけ見える返事はアプリとして送るときだけ使える）。 */
export class GoogleChatReplySender implements ChatReplySender {
  private readonly clients: ChatAppClients;

  constructor(deps: { repo: Repository; box: SecretBox }) {
    this.clients = new ChatAppClients(deps);
  }

  async reply(tenantId: string, space: string, text: string, opts: { thread?: string | null; privateViewer?: string | null }): Promise<boolean> {
    const client = await this.clients.for(tenantId);
    if (!client) return false;
    return client.reply(space, text, opts);
  }
}

export interface ChatBridgeDeps {
  repo: Repository;
  secretary: Pick<Secretary, 'respond'>;
  store: ChatInboxStore;
  /** 会社ごとの返し方（見本の会社は見本）。 */
  senderFor(tenantId: string): ChatReplySender;
  /** 会社の画面の入口（例: `https://a.m2office.net`）。 */
  appUrl(tenantId: string): Promise<string>;
  /** その会社の業務の名前を引く関数（拡張機能の業務を含む）。無ければ公式の業務の名前だけ。 */
  agentNames?(tenantId: string): Promise<(agentId: string) => string | undefined>;
  log: Logger;
  /** デバッグモードの記録（仕様書 第20.4.1節）。 */
  debug?: { add(tenantId: string, userId: string, kind: 'secretary', title: string, detail?: unknown): void } | null;
}

/**
 * Chat の発言を秘書に渡す橋渡し。
 *
 * @remarks 発言は送った人の依頼として扱う。文の中のほかの人の発言・リンク先は指示として扱わない（不変則 I-6。秘書の決まりのまま）
 */
export class ChatSecretaryBridge {
  /** 会社ごとの、古い記録を最後に消した時刻。 */
  private readonly purgedAt = new Map<string, number>();

  constructor(private readonly deps: ChatBridgeDeps) {}

  /** 送った人を、その会社の利用者から探す（会社のメールアドレスか、Google の接続のアカウント）。 */
  private async userOf(tenantId: string, email: string): Promise<User | null> {
    const direct = await this.deps.repo.findUserByEmail(tenantId, email).catch(() => null);
    if (direct) return direct;
    const conn = (await this.deps.repo.listGoogleConnections(tenantId).catch(() => [])).find((c) => c.googleEmail?.toLowerCase() === email);
    return conn ? this.deps.repo.findUserById(tenantId, conn.userId) : null;
  }

  /**
   * Chat アプリに届いた出来事を扱う。
   *
   * @returns 扱った結果（記録とテストに使う）
   */
  async handle(tenantId: string, payload: unknown, now: Date = new Date()): Promise<'ignored' | 'duplicate' | 'rejected' | 'answered' | 'failed'> {
    const msg = parseChatEvent(payload);
    if (!msg) return 'ignored';
    if (!(await this.deps.store.takeMessage(tenantId, msg.messageName, now.toISOString()))) return 'duplicate';
    await this.purgeOld(tenantId, now);
    const sender = this.deps.senderFor(tenantId);
    const where = { thread: msg.thread, privateViewer: msg.direct ? null : msg.senderName };
    const user = await this.userOf(tenantId, msg.senderEmail);
    if (!user || user.status !== 'active') {
      await sender.reply(tenantId, msg.space, CHAT_NOT_A_USER, where).catch(() => false);
      // 送り主のアカウントは残し、文は残さない
      await this.deps.repo.appendAudit({
        id: randomUUID(), tenantId, actorType: 'system', actorId: 'chat', action: 'chat.inbound_rejected', targetType: 'chat_message',
        targetId: msg.messageName, detail: { sender: msg.senderEmail, direct: msg.direct }, occurredAt: now.toISOString(),
      }).catch(() => undefined);
      return 'rejected';
    }
    // 個別メッセージの場所を覚える（通知の控えも同じ場所に届く。第6.5.5.2.1節）
    if (msg.direct) await this.deps.repo.setChatDmSpace(tenantId, user.id, msg.space).catch(() => undefined);
    this.deps.debug?.add(tenantId, user.id, 'secretary', `Chat の依頼（${msg.direct ? '個別メッセージ' : 'スペースでの言及'}）: ${msg.text}`, { space: msg.space });
    try {
      const reply = await this.deps.secretary.respond(tenantId, user.id, msg.text, undefined, { channel: 'chat' });
      const runId = reply.lookup?.runId && !reply.lookup.runId.startsWith('plan:') ? reply.lookup.runId : null;
      const base = (await this.deps.appUrl(tenantId)).replace(/\/+$/, '');
      const link = runId ? `${base}/runs/${encodeURIComponent(runId)}` : null;
      await sender.reply(tenantId, msg.space, chatReplyText(reply.text, link), where);
      // 後ろへ回した依頼は、終わったら同じ場所に返す（第10.16.3節「重い依頼」）
      if (runId) {
        await this.deps.store.addPending({
          tenantId, runId, userId: user.id, space: msg.space, thread: msg.thread, privateViewer: where.privateViewer,
          request: msg.text, approvalTold: false, createdAt: now.toISOString(),
        });
      }
      this.deps.debug?.add(tenantId, user.id, 'secretary', `Chat への答え（${reply.layer}）: ${reply.text}`);
      return 'answered';
    } catch (err) {
      this.deps.log.warn('Chat の依頼に答えられませんでした', { tenantId, err });
      await sender.reply(tenantId, msg.space, 'いまお答えできませんでした。少し後にもう一度頼んでください。', where).catch(() => false);
      return 'failed';
    }
  }

  /** 1 時間に 1 回まで、古い受け取りの記録と返す先を消す。 */
  private async purgeOld(tenantId: string, now: Date): Promise<void> {
    const last = this.purgedAt.get(tenantId) ?? 0;
    if (now.getTime() - last < 3_600_000) return;
    this.purgedAt.set(tenantId, now.getTime());
    await this.deps.store.purge(tenantId, new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString()).catch(() => undefined);
  }

  /**
   * 後ろへ回した依頼の結果を、Chat に返す（API が定期に呼ぶ）。承認待ちになったら、承認の画面へのリンクを 1 度だけ返す。
   *
   * @returns 返した数
   * @remarks 返したものは「伝えた」と記録し、画面の秘書が同じ結果を重ねて伝えないようにする（第10.11.7節）
   */
  async sweep(now: Date = new Date()): Promise<number> {
    let sent = 0;
    for (const tenantId of await this.deps.store.tenantsWithPending().catch(() => [])) {
      try {
        const base = (await this.deps.appUrl(tenantId)).replace(/\/+$/, '');
        const sender = this.deps.senderFor(tenantId);
        const nameOf = this.deps.agentNames ? await this.deps.agentNames(tenantId) : undefined;
        for (const p of await this.deps.store.listPending(tenantId)) {
          const where = { thread: p.thread, privateViewer: p.privateViewer };
          if (Date.parse(p.createdAt) < now.getTime() - KEEP_DAYS * 86_400_000) {
            await this.deps.store.removePending(tenantId, p.runId);
            continue;
          }
          const views = await listLookups(this.deps.repo, tenantId, p.userId, nameOf);
          const view = views.find((v) => v.runId === p.runId);
          if (!view) {
            const run = await this.deps.repo.getRun(tenantId, p.runId).catch(() => null);
            if (!run) await this.deps.store.removePending(tenantId, p.runId);
            continue;
          }
          if (!view.done && view.status === 'awaiting_approval' && !p.approvalTold) {
            await sender.reply(tenantId, p.space, chatReplyText(`「${p.request.slice(0, 60)}」は、承認を待っています。`, `${base}/approvals`), where);
            await this.deps.store.markApprovalTold(tenantId, p.runId);
            sent++;
            continue;
          }
          if (!view.done) continue;
          // 画面の秘書と重ねて伝えない（先に記録を取れた側だけが伝える）
          const claimed = await this.deps.repo.claimLookupDelivery(tenantId, p.runId);
          await this.deps.store.removePending(tenantId, p.runId);
          if (!claimed) continue;
          const agentName = view.agentName;
          const head = agentName ? `「${agentName}」に頼んだ「${p.request.slice(0, 40)}」` : `「${p.request.slice(0, 40)}」`;
          const text = view.status === 'completed' ? `${head}の結果です。\n\n${view.text ?? ''}` : `${head}はできませんでした。${view.failureReason ?? ''}`;
          await sender.reply(tenantId, p.space, chatReplyText(text, `${base}/runs/${encodeURIComponent(p.runId)}`), where);
          await rememberLookup(this.deps.repo, tenantId, p.userId, view);
          sent++;
        }
      } catch (err) {
        // 1 社の失敗で、ほかの会社を止めない
        this.deps.log.warn('Chat への結果の返しに失敗しました', { tenantId, err });
      }
    }
    return sent;
  }
}

/** Chat の発言を受ける見本の会社か（開発。Google の署名の代わりに決まった印を受ける）。 */
export function isMockTenant(connector: Pick<WorkspaceConnector, 'sourceFor'>, tenantId: string): boolean {
  return connector.sourceFor(tenantId) === 'mock';
}
