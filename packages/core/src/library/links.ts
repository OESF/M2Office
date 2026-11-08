/**
 * @file 資料のつながり（仕様書 第44.17.1節。段 5）。目録の項目から決まりで見つける。推論は呼ばない（AI の費用を増やさない）。
 *
 * つながりの決まりと強さ（Q-314。使いながら直す）:
 * - 同じメールで届いた（4）・同じ資料の版（4）
 * - 同じ取引先で、案件の語が 1 つ以上重なる（2。重なる語 1 つごとに 1 足す。5 まで）
 * - 取引先が違うか無く、語が 2 つ以上重なる（1。重なる語 1 つごとに 1 足す。3 まで）
 * - PC から入れたときの元のフォルダが同じ（1。30 件を超えるフォルダは除く）
 *
 * 本人の資料どうしだけをつなぐ（呼ぶ側が本人の資料だけを渡す）。取引先が同じだけの資料どうしは線にせず、グラフでは取引先の点に集める。
 * すべての組を比べず、語・メール・フォルダごとの索引で比べる。一般的すぎる語と、大きすぎる組は除く。
 *
 * @see 仕様書 第44.17節
 * @see ADR-0127
 */

import { LIBRARY_LINK_LABELS, type LibraryItem, type LibraryLinkKind } from '@m2office/shared';
import { libraryNormal, libraryVersionKey } from './store.js';

/** つながりを見つけるのに使う 1 件（目録の項目と、入口の記録のメールの ID・元のフォルダ）。 */
export interface LibraryLinkInput extends LibraryItem {
  messageIds: string[];
  folders: string[];
}

/** つながり 1 つ。`shared` は重なった語（語のつながりのとき）。 */
export interface LibraryLink {
  id: string;
  kind: LibraryLinkKind;
  strength: number;
  shared: string[];
}

/** 決まりの値（Q-314）。 */
export const LIBRARY_LINK_RULES = {
  mail: 4,
  version: 4,
  projectBase: 2,
  projectMax: 5,
  wordsMin: 2,
  wordsBase: 1,
  wordsMax: 3,
  folder: 1,
  /** これを超える資料が入ったフォルダはつながりにしない */
  folderMax: 30,
  /** その人の資料のこの割合を超えて出る語は、一般的すぎるので数えない */
  commonShare: 0.3,
  /** 資料が少ない人でも、この数までの語は数える（3 件しか無い人で、どの語も一般的にならないように） */
  commonFloor: 3,
  /** これを超える資料に出る語・取引先の組は比べない（大きすぎる組で全部がつながるのを避ける） */
  groupMax: 60,
} as const;

/** 2 件の組の鍵。 */
const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

/** 資料の検索の語（正規化して重ねない。1 文字の語は数えない）。 */
const wordsOf = (i: LibraryItem) => [...new Set(i.keywords.map(libraryNormal).filter((w) => w.length >= 2))];

/**
 * 資料どうしのつながりを見つける（第44.17.1節）。
 *
 * @param items 本人の資料（共有された他人の資料を混ぜないこと）
 * @returns 資料の ID ごとの、つながる資料（強い順）
 */
export function libraryLinks(items: LibraryLinkInput[]): Map<string, LibraryLink[]> {
  const R = LIBRARY_LINK_RULES;
  const best = new Map<string, { kind: LibraryLinkKind; strength: number; shared: string[] }>();
  const offer = (a: string, b: string, kind: LibraryLinkKind, strength: number, shared: string[] = []) => {
    if (a === b) return;
    const k = pairKey(a, b);
    const cur = best.get(k);
    if (!cur || strength > cur.strength) best.set(k, { kind, strength, shared });
  };
  /** 同じ組の中の全部の組に、同じつながりを付ける。 */
  const within = (ids: string[], kind: LibraryLinkKind, strength: number) => {
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) offer(ids[x]!, ids[y]!, kind, strength);
  };
  const index = (key: (i: LibraryLinkInput) => string[]) => {
    const m = new Map<string, string[]>();
    for (const i of items) for (const k of new Set(key(i))) if (k) m.set(k, [...(m.get(k) ?? []), i.id]);
    return m;
  };

  // 同じメール・同じ資料の版・同じフォルダ
  for (const ids of index((i) => i.messageIds).values()) if (ids.length <= R.groupMax) within(ids, 'mail', R.mail);
  for (const ids of index((i) => [libraryVersionKey(i) ?? '']).values()) if (ids.length <= R.groupMax) within(ids, 'version', R.version);
  for (const ids of index((i) => i.folders.map((f) => f.trim()).filter(Boolean)).values()) if (ids.length <= R.folderMax) within(ids, 'folder', R.folder);

  // 語（一般的すぎる語は数えない）。理由には元の書き方で出す
  const words = new Map(items.map((i) => [i.id, wordsOf(i)]));
  const shown = new Map<string, string>();
  for (const i of items) for (const k of i.keywords) if (!shown.has(libraryNormal(k))) shown.set(libraryNormal(k), k.trim());
  const byWord = new Map<string, string[]>();
  for (const [id, ws] of words) for (const w of ws) byWord.set(w, [...(byWord.get(w) ?? []), id]);
  const common = Math.max(R.commonFloor, Math.floor(items.length * R.commonShare));
  const shared = new Map<string, string[]>();
  for (const [w, ids] of byWord) {
    if (ids.length < 2 || ids.length > common || ids.length > R.groupMax) continue;
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
      const k = pairKey(ids[x]!, ids[y]!);
      shared.set(k, [...(shared.get(k) ?? []), w]);
    }
  }
  const party = new Map(items.map((i) => [i.id, libraryNormal(i.counterparty)]));
  for (const [k, ws] of shared) {
    const [a, b] = k.split('\n') as [string, string];
    const same = !!party.get(a) && party.get(a) === party.get(b);
    const label = ws.map((w) => shown.get(w) ?? w);
    if (same) offer(a, b, 'project', Math.min(R.projectMax, R.projectBase + ws.length - 1), label);
    else if (ws.length >= R.wordsMin) offer(a, b, 'words', Math.min(R.wordsMax, R.wordsBase + ws.length - R.wordsMin), label);
  }

  const out = new Map<string, LibraryLink[]>(items.map((i) => [i.id, []]));
  for (const [k, v] of best) {
    const [a, b] = k.split('\n') as [string, string];
    out.get(a)?.push({ id: b, ...v });
    out.get(b)?.push({ id: a, ...v });
  }
  const at = new Map(items.map((i) => [i.id, i.docDate ?? i.receivedAt.slice(0, 10)]));
  for (const list of out.values()) list.sort((x, y) => y.strength - x.strength || (at.get(y.id) ?? '').localeCompare(at.get(x.id) ?? ''));
  return out;
}

/** つながりの理由の文（重なった語があれば添える）。 */
export function libraryLinkReason(l: Pick<LibraryLink, 'kind' | 'shared'>): string {
  const label = LIBRARY_LINK_LABELS[l.kind];
  return (l.kind === 'project' || l.kind === 'words') && l.shared.length ? `${label}（${l.shared.slice(0, 3).join('・')}）` : label;
}
