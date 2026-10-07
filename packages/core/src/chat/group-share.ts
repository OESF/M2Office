/**
 * @file グループの名前で共有を頼めるようにする（仕様書 第16.7.12.1節、ADR-0076）。
 *
 * 「技術部に共有して」の「技術部」が Chat のスペースの名前に無く、M2Office のグループの名前に当たれば、
 * そのグループに合うスペースを、依頼した人が入っているスペースの中から探す。覚えた組み合わせ → 名前 → メンバーの重なりの順。
 * 1 つに決まらなければ止める（候補を挙げる）。人に対応表を作らせない（ADR-0028）。見つけた組み合わせは覚える（会社で共有）。
 * 承認の画面には、届く先のメンバーの数・会社の外の人の数・グループとの違いを出す。違いがあっても止めない。
 */

import type { GroupChatSpace, UserGroup } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { ChatSpaceMembers, ConnectorPrincipal, WorkspaceConnector } from '../connectors/types.js';

/** メンバーの重なりで選ぶときの下限（グループの人のうち、スペースに入っている割合）。 */
export const GROUP_SPACE_MIN_OVERLAP = 0.6;
/** メンバーを数えて比べるスペースの数の上限（Chat の API を呼びすぎない）。 */
const OVERLAP_CANDIDATES = 15;

/** 名前を比べるために整える（全角と半角・空白・括弧の中・「グループ」などの言い添えを除く）。 */
export function normalizeGroupName(name: string): string {
  return name.normalize('NFKC').toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(のみなさん|の皆さん|のみんな|の全員|のメンバー|グループ|チーム|スペース|全体)$/g, '')
    .replace(/[\s　・_-]+/g, '');
}

/** スペースの名前がグループの名前に合うか（同じか、片方がもう片方を含む。2 字以上）。 */
export function namesMatch(group: string, space: string): boolean {
  const g = normalizeGroupName(group);
  const s = normalizeGroupName(space);
  if (!g || !s) return false;
  return g === s || (g.length >= 2 && s.includes(g)) || (s.length >= 2 && g.includes(s));
}

/**
 * メンバーの重なりからスペースを 1 つ選ぶ（純粋な関数）。
 *
 * @param scores スペースごとの、グループの人のうち入っている割合
 * @returns 下限を超え、ほかより重なりが大きい 1 つ。決まらなければ `null`
 */
export function pickByOverlap(scores: { space: string; ratio: number }[]): string | null {
  const sorted = [...scores].sort((a, b) => b.ratio - a.ratio);
  const top = sorted[0];
  if (!top || top.ratio < GROUP_SPACE_MIN_OVERLAP) return null;
  if (sorted[1] && sorted[1].ratio >= top.ratio) return null;
  return top.space;
}

/** グループの人の Google アカウント（Google と接続していればそのアカウント、無ければ M2Office のメールアドレス）。 */
export async function groupEmails(repo: Repository, tenantId: string, group: UserGroup): Promise<string[]> {
  const out: string[] = [];
  for (const id of group.memberIds) {
    const [conn, user] = await Promise.all([repo.getGoogleConnection(tenantId, id).catch(() => null), repo.findUserById(tenantId, id).catch(() => null)]);
    if (user?.status !== 'active') continue;
    const email = conn?.googleEmail ?? user.email;
    if (email) out.push(email.toLowerCase());
  }
  return out;
}

/** グループの名前で頼まれたときの答え。 */
export type GroupSpaceResolution =
  | { kind: 'not-group' }
  | { kind: 'found'; group: UserGroup; space: string; name: string; external: boolean; by: GroupChatSpace['by']; emails: string[] }
  | { kind: 'problem'; reason: string };

/**
 * 頼まれた名前が、Chat のスペースではなく M2Office のグループを指していれば、合うスペースを探す（読むだけ。覚えるのは見つけたとき）。
 *
 * @returns スペースの名前に当たる・グループに当たらないなら `not-group`（これまでどおりスペースの名前で探す）
 */
export async function resolveGroupSpace(
  deps: { repo: Repository; connector: WorkspaceConnector; now?: () => Date }, p: ConnectorPrincipal, wanted: string,
): Promise<GroupSpaceResolution> {
  const want = normalizeGroupName(wanted);
  if (!want || /^spaces\//.test(wanted.trim()) || /chat\.google\.com/.test(wanted)) return { kind: 'not-group' };
  const groups = await deps.repo.listGroups(p.tenantId);
  const group = groups.find((g) => normalizeGroupName(g.name) === want);
  if (!group) return { kind: 'not-group' };
  const spaces = await deps.connector.chat.listSpaces(p);
  // 同じ名前のスペースがあれば、これまでどおりスペースの名前として扱う
  if (spaces.some((s) => s.displayName.normalize('NFKC').trim().toLowerCase() === wanted.normalize('NFKC').trim().toLowerCase())) return { kind: 'not-group' };
  const emails = await groupEmails(deps.repo, p.tenantId, group);
  const found = (s: { space: string; displayName: string; external: boolean }, by: GroupChatSpace['by']): GroupSpaceResolution =>
    ({ kind: 'found', group, space: s.space, name: s.displayName, external: s.external, by, emails });
  const remember = async (s: { space: string; displayName: string }, by: GroupChatSpace['by']) => {
    if (group.chatSpace?.space === s.space) return;
    await deps.repo.setGroupChatSpace(p.tenantId, group.id, { space: s.space, name: s.displayName, by, at: (deps.now?.() ?? new Date()).toISOString() });
  };
  // 1. 覚えた組み合わせ（本人がそのスペースに入っていれば）
  const known = group.chatSpace ? spaces.find((s) => s.space === group.chatSpace!.space) : undefined;
  if (known) return found(known, group.chatSpace!.by);
  // 2. 名前
  const byName = spaces.filter((s) => namesMatch(group.name, s.displayName));
  if (byName.length === 1) {
    await remember(byName[0]!, 'name');
    return found(byName[0]!, 'name');
  }
  // 3. メンバーの重なり（名前の候補が複数ならその中から、無ければ全部から）
  const pool = (byName.length ? byName : spaces).slice(0, OVERLAP_CANDIDATES);
  const scores: { space: string; ratio: number }[] = [];
  if (emails.length) {
    for (const s of pool) {
      const m = await deps.connector.chat.members(p, s.space, emails).catch(() => null);
      if (m) scores.push({ space: s.space, ratio: m.present.length / emails.length });
    }
  }
  const picked = pickByOverlap(scores);
  const hit = picked ? spaces.find((s) => s.space === picked) : undefined;
  if (hit) {
    await remember(hit, 'members');
    return found(hit, 'members');
  }
  const top = [...scores].sort((a, b) => b.ratio - a.ratio).filter((x) => x.ratio > 0).slice(0, 3).map((x) => spaces.find((s) => s.space === x.space)!.displayName);
  const names = (byName.length ? byName.map((s) => s.displayName) : top).slice(0, 3);
  return {
    kind: 'problem',
    reason: names.length
      ? `グループ「${group.name}」に合う Chat のスペースを 1 つに決められません（候補: ${names.map((n) => `「${n}」`).join('・')}）。スペースの名前で頼むか、「${group.name}の共有は〇〇のスペースにして」と教えてください`
      : `グループ「${group.name}」に合う Chat のスペースが見つかりません（あなたが入っているスペースだけを探します）。Chat でスペースを作るか、スペースの名前で頼んでください`,
  };
}

/** 承認の画面に出す、届く先の説明と、社内だけと言えるか。 */
export interface ReachNotes {
  notes: string[];
  /** メンバーを確かめ、会社の外の人も Google のグループも入っていないと分かった */
  internalOnly: boolean;
}

/**
 * 届く先のメンバーを数え、承認の画面の説明にする（読むだけ）。グループの名前で頼んだときは、グループとの違いも出す。
 *
 * @remarks 確かめられなければ、その旨を書き、社内だけとは言わない（分からないものは社外。第9.4.0節）
 */
export async function reachNotes(
  deps: { repo: Repository; connector: WorkspaceConnector }, p: ConnectorPrincipal, space: string,
  group: { group: UserGroup; by: GroupChatSpace['by']; emails: string[] } | null,
): Promise<ReachNotes> {
  let m: ChatSpaceMembers | null = null;
  try {
    m = await deps.connector.chat.members(p, space, group?.emails ?? []);
  } catch {
    m = null;
  }
  const notes: string[] = [];
  if (group) {
    const how = group.by === 'name' ? '名前が合いました' : group.by === 'members' ? 'メンバーが重なっています' : '前に教えていただいた組み合わせです';
    notes.push(`グループ「${group.group.name}」に合う Chat のスペースです（${how}）`);
  }
  if (!m) {
    notes.push('スペースのメンバーを確かめられませんでした');
    return { notes, internalOnly: false };
  }
  notes.push(`メンバー ${m.humans} 人${m.googleGroups ? `・Google のグループ ${m.googleGroups} つ（中の人は数えられません）` : ''}${m.external ? `（うち会社の外の人 ${m.external} 人）` : ''}`);
  if (group) {
    const names = await displayNames(deps.repo, p.tenantId, group.group, m.absent);
    if (names.length) notes.push(`グループにいて、スペースにいない人（読めません）: ${names.join('、')}`);
    const extra = Math.max(0, m.humans - m.present.length);
    if (extra) notes.push(`スペースにいて、グループにいない人（届きます）: ${extra} 人`);
    if (m.unknown.length) notes.push(`確かめられなかった人: ${(await displayNames(deps.repo, p.tenantId, group.group, m.unknown)).join('、')}`);
  }
  return { notes, internalOnly: m.external === 0 && m.googleGroups === 0 };
}

/** グループの人のメールアドレスを、M2Office の名前にする。 */
async function displayNames(repo: Repository, tenantId: string, group: UserGroup, emails: string[]): Promise<string[]> {
  const want = new Set(emails.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const id of group.memberIds) {
    const [conn, user] = await Promise.all([repo.getGoogleConnection(tenantId, id).catch(() => null), repo.findUserById(tenantId, id).catch(() => null)]);
    const email = (conn?.googleEmail ?? user?.email ?? '').toLowerCase();
    if (want.has(email)) out.push(user?.displayName || email);
  }
  return out;
}
