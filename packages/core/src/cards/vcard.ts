/**
 * @file 連絡先を vCard（3.0）にする。1 件ずつ、見られる人が書き出せる。
 *
 * @see 仕様書 第27.8節 画面（詳細の操作「vCard で書き出す」）
 * @see 仕様書 第27.10節 個人情報とデータの扱い（まとめての書き出しは Phase 2）
 */

import type { Contact, PhoneKind } from '@m2office/shared';

const PHONE_TYPE: Record<PhoneKind, string> = { main: 'WORK,VOICE', direct: 'WORK,VOICE', mobile: 'CELL', fax: 'WORK,FAX' };

/**
 * 連絡先を vCard の文にする。
 *
 * @returns CRLF 区切りの vCard 3.0
 * @remarks 区切りの文字（`,`・`;`・改行）は vCard の決まりどおりに逃がす。空の項目は書かない
 */
export function toVCard(c: Pick<Contact, 'name' | 'nameKana' | 'company' | 'department' | 'title' | 'postalCode' | 'address' | 'phones' | 'emails' | 'website' | 'note' | 'english'>): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name || c.company)}`];
  // 日本語の氏名は姓と名を分けられないことが多い。分けずに姓の欄へ入れる
  lines.push(`N:${esc(c.name)};;;;`);
  if (c.nameKana) lines.push(`X-PHONETIC-LAST-NAME:${esc(c.nameKana)}`, `SORT-STRING:${esc(c.nameKana)}`);
  if (c.company || c.department) lines.push(`ORG:${esc(c.company)}${c.department ? `;${esc(c.department)}` : ''}`);
  if (c.title) lines.push(`TITLE:${esc(c.title)}`);
  for (const p of c.phones) lines.push(`TEL;TYPE=${PHONE_TYPE[p.kind]}:${esc(p.number)}`);
  for (const e of c.emails) lines.push(`EMAIL;TYPE=INTERNET,WORK:${esc(e)}`);
  if (c.address || c.postalCode) lines.push(`ADR;TYPE=WORK:;;${esc(c.address)};;;${esc(c.postalCode)};JP`);
  if (c.website) lines.push(`URL:${esc(c.website)}`);
  if (c.note) lines.push(`NOTE:${esc(c.note)}`);
  // 英語の表記（第27.5.1節）は、言語の印を付けて同じ項目をもう 1 つ書く
  const en = c.english;
  if (en?.name) lines.push(`FN;LANGUAGE=en:${esc(en.name)}`);
  if (en?.company || en?.department) lines.push(`ORG;LANGUAGE=en:${esc(en.company ?? '')}${en.department ? `;${esc(en.department)}` : ''}`);
  if (en?.title) lines.push(`TITLE;LANGUAGE=en:${esc(en.title)}`);
  if (en?.address) lines.push(`ADR;TYPE=WORK;LANGUAGE=en:;;${esc(en.address)};;;;`);
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}
