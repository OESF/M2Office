/**
 * @file 名刺の裏面（仕様書 第27.5.1節、ADR-0082）。裏から読んだもの（英語の表記・裏の文・関連会社・商品とサービス）を連絡先に足し、
 * 表と裏を組にする手がかり（中身・位置）を決める。
 *
 * 人に組を指定させない（ADR-0028）。裏の文はデータであり、指示として扱わない（不変則 I-6）。
 */

import { EMPTY_CARD_ENGLISH, type CardBackInfo, type CardCorners, type CardEnglish, type CardFields, type Contact } from '@m2office/shared';
import type { ContactPatch } from './store.js';

/** 表の見つからない裏の名刺に残す理由（画面と組み直しの見分けに使う）。 */
export const ORPHAN_BACK_REASON = '表が見つかりません（裏の面だけです）';

/** 関連会社・商品とサービスの数の上限。 */
const LIST_MAX = 30;

/**
 * 裏（か、英語の表記のある表）から読んだものを、連絡先に足す差分にする。
 *
 * @param asBack 裏の面として読んだか（裏の文を置き換える）。表の面の英語の表記だけを足すときは `false`
 * @remarks 英語の欄は空のところだけ埋める（人が直した値と、先に読んだ値を上書きしない）。関連会社・商品とサービスは足し合わせる
 */
export function backPatch(contact: Pick<Contact, 'english' | 'backText' | 'related' | 'products'>, info: CardBackInfo, asBack: boolean): ContactPatch {
  const cur: CardEnglish = { ...EMPTY_CARD_ENGLISH, ...(contact.english ?? {}) };
  const english = { ...cur };
  let changed = false;
  for (const k of Object.keys(EMPTY_CARD_ENGLISH) as (keyof CardEnglish)[]) {
    if (!english[k] && info.english[k]) { english[k] = info.english[k]; changed = true; }
  }
  const patch: ContactPatch = {};
  if (changed) patch.english = english;
  if (asBack && info.text && info.text !== contact.backText) patch.backText = info.text;
  const union = (a: string[] | undefined, b: string[]) => [...new Set([...(a ?? []), ...b])].slice(0, LIST_MAX);
  const related = union(contact.related, info.related);
  if (related.length !== (contact.related ?? []).length) patch.related = related;
  const products = union(contact.products, info.products);
  if (products.length !== (contact.products ?? []).length) patch.products = products;
  return patch;
}

/** 会社名などを比べる形（空白・全角と半角・「株式会社」などを除く）。 */
function companyKey(s: string): string {
  return s.normalize('NFKC').toLowerCase()
    .replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|co\.?,?\s*ltd\.?|inc\.?|corporation|corp\.?|k\.k\.?|limited/g, '')
    .replace(/[\s.,・\-()]/g, '');
}

/** メールアドレスと Web のアドレスのドメイン。 */
function domains(f: Pick<CardFields, 'emails' | 'website'>): string[] {
  const out = f.emails.map((e) => e.split('@')[1]?.toLowerCase() ?? '').filter(Boolean);
  const web = /^(?:https?:\/\/)?(?:www\.)?([^/:?#]+)/i.exec(f.website.trim())?.[1]?.toLowerCase();
  if (web) out.push(web);
  return out;
}

/**
 * 裏が、この表（の連絡先）のものらしいか（中身で見る。第27.5.1節）。
 *
 * @remarks メールアドレス・電話番号が重なる、ドメインが同じ、会社名（日本語か英語）が同じか片方がもう片方を含む、のどれか
 */
export function backMatches(front: Pick<CardFields, 'company' | 'emails' | 'phones' | 'website'> & { english?: Partial<CardEnglish> },
  back: { fields: Pick<CardFields, 'company' | 'emails' | 'phones' | 'website'>; info: CardBackInfo }): boolean {
  if (back.fields.emails.some((e) => front.emails.includes(e))) return true;
  const digits = (s: string) => s.replace(/[^0-9]/g, '').replace(/^81/, '0');
  const fp = front.phones.map((p) => digits(p.number)).filter((d) => d.length >= 9);
  if (back.fields.phones.some((p) => fp.includes(digits(p.number)))) return true;
  const fd = domains(front);
  if (domains(back.fields).some((d) => fd.includes(d))) return true;
  const fronts = [front.company, front.english?.company ?? ''].map(companyKey).filter((x) => x.length >= 2);
  const backs = [back.fields.company, back.info.english.company].map(companyKey).filter((x) => x.length >= 2);
  return fronts.some((a) => backs.some((b) => a === b || a.includes(b) || b.includes(a)));
}

/** 四隅の真ん中（並べて撮った写真の位置で組にするとき。第27.5.1節）。無ければ `null`。 */
export function cornersCenter(c: CardCorners | null | undefined): { x: number; y: number } | null {
  if (!c || c.length !== 4) return null;
  return { x: c.reduce((a, p) => a + p[0], 0) / 4, y: c.reduce((a, p) => a + p[1], 0) / 4 };
}

/**
 * 並べて撮った表と裏を組にする。中身で組にし、残りは位置（上から下、同じ行は左から右）の順で組にする。
 *
 * @remarks 裏返すと左右が入れ替わることがあるため、位置の順は数が同じときだけ使う
 * @returns 裏の番号 → 表の番号
 */
export function pairByContentThenPosition<F, B>(
  fronts: F[], backs: B[], matches: (f: F, b: B) => boolean, frontCorners: (f: F) => CardCorners | null, backCorners: (b: B) => CardCorners | null,
): Map<number, number> {
  const out = new Map<number, number>();
  const used = new Set<number>();
  for (const [bi, b] of backs.entries()) {
    const hits = fronts.map((f, fi) => ({ f, fi })).filter(({ f, fi }) => !used.has(fi) && matches(f, b));
    if (hits.length === 1) { out.set(bi, hits[0]!.fi); used.add(hits[0]!.fi); }
  }
  const restF = fronts.map((_, i) => i).filter((i) => !used.has(i));
  const restB = backs.map((_, i) => i).filter((i) => !out.has(i));
  if (restF.length === restB.length && restF.length > 0) {
    // 四隅は画像の幅と高さを 1,000 とした割合。高さの 2 割ごとを 1 行とみなす
    const order = (c: CardCorners | null) => { const m = cornersCenter(c); return m ? Math.round(m.y / 200) * 10_000 + m.x : Number.MAX_SAFE_INTEGER; };
    const sf = [...restF].sort((a, b) => order(frontCorners(fronts[a]!)) - order(frontCorners(fronts[b]!)));
    const sb = [...restB].sort((a, b) => order(backCorners(backs[a]!)) - order(backCorners(backs[b]!)));
    sb.forEach((bi, k) => out.set(bi, sf[k]!));
  }
  return out;
}
