/**
 * @file 秘書の「不正の兆しの見張り」の受け口（仕様書 第16.8.3節、ADR-0091）。管理者だけが使える。
 *
 * - 「セキュリティの知らせは？」: この 7 日の兆しを、何が・いつ・誰に起きたかで並べる
 * - 「〇〇さんの端末をすべてログアウトして」: その人の端末をすべてログアウトする（アカウントは止めない）
 * - 「これは大丈夫」「〇〇さんのは大丈夫」: 同じ人・同じ型の兆しを 30 日知らせない（いちばん新しい兆しに当てる）
 * - 「〇〇さんを止めて」: アカウントを止めるのは管理者ページの「ユーザーと権限」で行うと案内する（業務の中断と名刺の整理が連動するため）
 * - Google のログインの記録（段 3）を読めていなければ、「セキュリティの知らせは？」の答えに一言添える（担当がいなければ、Google の管理者の人に接続してもらうよう伝える）
 *
 * 推論を使わずに見分ける（決まった言い方だけ）。管理者でなければ、見張りの中身を答えない。
 */

import type { User } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { SECURITY_SIGNAL_LABELS, type SecurityWatch } from '../security/watch.js';

/** 秘書が受ける依頼。 */
export type SecurityRequest =
  | { kind: 'list' }
  | { kind: 'signout'; name: string }
  | { kind: 'dismiss'; name: string | null }
  | { kind: 'stop'; name: string };

/** 秘書の見張りの受け口に要るもの。 */
export interface SecuritySecretaryDeps {
  watch: SecurityWatch;
  repo: Repository;
}

/**
 * 依頼を見分ける。当たらなければ `null`（ふつうの会話に回す）。
 */
export function securityRequest(message: string): SecurityRequest | null {
  const m = message.normalize('NFKC').replace(/\s+/g, '');
  if (/(セキュリティの(?:お?知らせ|兆し)|不正(?:アクセス)?の兆し)/.test(m) && !/(方法|設定|とは|仕組み|どうやって)/.test(m)) return { kind: 'list' };
  const out = /^(.+?)さん(?:の(?:端末|ログイン))?(?:を|は)?(?:すべて|全部|ぜんぶ)?ログアウト(?:させて|して|させてください|してください)/.exec(m);
  if (out) return { kind: 'signout', name: out[1]! };
  const ok = /^(?:(.+?)さんの(?:件|兆し|知らせ|もの|分)?(?:は|も)?|(?:これ|それ|今の|いまの|その知らせ|さっきの)(?:は|も)?)(?:大丈夫|問題(?:ない|ありません)|心配(?:ない|ありません))(?:です)?[。!！]?$/.exec(m);
  if (ok) return { kind: 'dismiss', name: ok[1] ?? null };
  const stop = /^(.+?)さん(?:のアカウント)?を(?:止めて|停止して|使えなくして)/.exec(m);
  if (stop) return { kind: 'stop', name: stop[1]! };
  return null;
}

/** 呼び名から会社の人を探す（空白を除いて、表示名に含まれる人）。 */
function findUsers(users: User[], name: string): User[] {
  const n = name.replace(/\s+/g, '');
  return users.filter((u) => u.displayName.replace(/\s+/g, '').includes(n));
}

const when = (at: string) => new Date(at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * 依頼に答える。
 *
 * @returns 答えの文。この受け口で扱わない（名前の人がいない「止めて」など）なら `null`
 * @remarks 危険度: 中（管理者の依頼で、その人の端末をログアウトする。どれも監査ログに残す）
 */
export async function answerSecurity(deps: SecuritySecretaryDeps, tenantId: string, userId: string, req: SecurityRequest, now: Date = new Date()): Promise<string | null> {
  const users = await deps.repo.listUsers(tenantId);
  const me = users.find((u) => u.id === userId);
  const admin = !!me && me.status === 'active' && me.roles.includes('admin');
  if (req.kind === 'list') {
    if (!admin) return 'セキュリティの知らせは、管理者だけが見られます。';
    const [list, google] = await Promise.all([deps.watch.recent(tenantId, now), deps.watch.googleStatus(tenantId).catch(() => null)]);
    // Google のログインの記録（段 3。第16.8.6節）を読めていなければ一言添える。画面に説明を常に出さず、聞かれたときに伝える（原則 u11）
    const googleNote = google === 'disconnected'
      ? 'Google のログインの記録はまだ見張っていません。Google の管理者の人に、管理者ページの「接続」→「Google Workspace」の「Google のログインの記録」で接続してもらってください。'
      : google === 'error' ? 'Google のログインの記録を読めていません。担当の人に、管理者ページの「接続」→「Google Workspace」で接続し直してもらってください。' : null;
    if (list.length === 0) return ['この 7 日に、不正の兆しは見つかっていません。', ...(googleNote ? [googleNote] : [])].join('\n');
    const lines = list.slice(0, 10).map((s) => `・${when(s.createdAt)} ${SECURITY_SIGNAL_LABELS[s.type]}${s.userName ? `（${s.userName}さん）` : ''}${s.severity === 'high' ? ' 【重い】' : ''}${s.detail['offHours'] ? '（深夜か休業日）' : ''}`);
    return [`この 7 日の不正の兆しは ${list.length} 件です。`, ...lines,
      '覚えが無ければ「〇〇さんの端末をすべてログアウトして」、問題が無ければ「〇〇さんのは大丈夫」と伝えてください。', ...(googleNote ? [googleNote] : [])].join('\n');
  }
  const target = req.kind === 'dismiss' && req.name === null ? null : findUsers(users, req.name ?? '');
  if (target && target.length === 0) return req.kind === 'stop' ? null : `「${req.name}」さんが見つかりません。表示名で教えてください。`;
  if (target && target.length > 1) return `「${req.name}」さんが ${target.length} 人います（${target.map((u) => u.displayName).join('・')}）。フルネームで教えてください。`;
  if (!admin) return req.kind === 'stop' ? null : 'この操作は、管理者だけが行えます。';
  const who = target?.[0] ?? null;
  if (req.kind === 'signout') {
    const n = await deps.watch.signOut(tenantId, userId, who!.id, now);
    return n > 0
      ? `${who!.displayName}さんの端末 ${n} つをすべてログアウトさせました。アカウントは止めていません。止めるときは、管理者ページの「ユーザーと権限」で行います。`
      : `${who!.displayName}さんは、いまログインしている端末がありません。`;
  }
  if (req.kind === 'dismiss') {
    const s = await deps.watch.dismiss(tenantId, userId, who?.id ?? null, now);
    if (!s) return who ? `${who.displayName}さんの、この 1 日の兆しは見つかりません。` : 'この 1 日の兆しは見つかりません。';
    return `分かりました。${s.userName ?? '対象の人'}さんの「${SECURITY_SIGNAL_LABELS[s.type]}」は、30 日のあいだ知らせません。`;
  }
  return `${who!.displayName}さんのアカウントを止めるのは、管理者ページの「ユーザーと権限」で行います（止めると、その人の業務の中断と名刺の整理も行います）。いますぐ端末だけを締め出すなら、「${who!.displayName}さんの端末をすべてログアウトして」と伝えてください。`;
}
