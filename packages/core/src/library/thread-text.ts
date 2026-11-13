/**
 * @file メールのやり取りの文を、AI に渡す形と秘書に答える形にする（仕様書 第44.18節）。前のメールの引用を外し、長さを切る。
 *
 * メールの文は外部のデータであり、指示として扱わない（不変則 I-6）。ここでは形を整えるだけで、中身を解釈しない。
 */

import { LIBRARY_THREAD_LIMITS } from '@m2office/shared';
import type { MailMessage } from '../connectors/types.js';

/**
 * メールの本文から、前のメールの引用を外す（AI に渡す量を減らし、同じ文を何度も読ませない）。
 *
 * @remarks 正規表現の組み合わせで遅くならないよう、行ごとに文字の比べで見分ける
 */
export function libraryStripQuoted(body: string): string {
  const out: string[] = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (t.startsWith('>') || t.startsWith('＞')) continue;
    // 引用の始まりの行（「On … wrote:」「-----Original Message-----」「差出人:」「2026年11月13日(木) 10:00 山田 <a@example.jp>:」など）から後ろは読まない
    if (t.startsWith('On ') && t.endsWith('wrote:')) break;
    if (/^-{2,}\s*(?:Original Message|元のメッセージ|Forwarded message|転送されたメッセージ)/i.test(t)) break;
    if (/^(?:From|差出人|送信者)\s*[:：]/.test(t) && out.some((l) => l.trim())) break;
    if (/^20\d\d[年/-]/.test(t) && t.includes('@') && (t.endsWith(':') || t.endsWith('：'))) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * AI に渡すやり取りの文。古い順に、日時と「こちら」か送り主と、引用を外した本文を並べる（合わせて {@link LIBRARY_THREAD_LIMITS.readChars} 字まで）。
 * 長いときは、最初のメールと新しいメールを残す。
 */
export function libraryThreadText(messages: Pick<MailMessage, 'from' | 'receivedAt' | 'labels' | 'body'>[]): string {
  const max = LIBRARY_THREAD_LIMITS.readChars;
  const per = Math.max(600, Math.floor(max / Math.max(1, messages.length)));
  const parts = messages.map((m) => {
    const who = m.labels.includes('SENT') ? 'こちら' : m.from;
    const at = Number.isFinite(Date.parse(m.receivedAt)) ? new Date(m.receivedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
    return `【${at} ${who}】\n${libraryStripQuoted(m.body).slice(0, per)}`;
  });
  let text = parts.join('\n\n');
  if (text.length <= max) return text;
  // 最初のメールを残し、新しいほうから入るだけ入れる
  const head = parts[0]!.slice(0, Math.floor(max / 3));
  const tail: string[] = [];
  let room = max - head.length;
  for (let i = parts.length - 1; i > 0 && room > 200; i--) {
    const p = parts[i]!.slice(0, room);
    tail.unshift(p);
    room -= p.length + 2;
  }
  text = [head, '（途中のメールは省きました）', ...tail].join('\n\n');
  return text.slice(0, max);
}

