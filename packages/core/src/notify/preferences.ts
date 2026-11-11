/**
 * @file Chat への通知の届け方を、秘書への頼みで変える（仕様書 第10.16.5節「変え方」、ADR-0138）。
 *
 * 「夜 10 時から朝 8 時は送らないで」「土日も送っていい」「完了は Chat に送らなくていい」「承認の依頼だけ Chat に送って」を、
 * 推論を使わずに読み取り、本人の通知の設定を直す。人に表や規則を作らせない（ADR-0028）。
 * 読み取れないものは `null` を返し、ほかの経路に進める（似た言い方を推測で設定にしない）。
 */

import type { UserSettings } from '@m2office/shared';
import { NOTIFICATION_KIND_LABELS } from './delivery.js';

/** 会話で頼まれた、通知の届け方の変更。 */
export type NotifyPreferenceRequest =
  | { kind: 'quiet'; from: string; to: string }
  | { kind: 'quietOff' }
  | { kind: 'daysOff'; on: boolean }
  | { kind: 'chatOff'; kinds: string[] }
  | { kind: 'chatOn'; kinds: string[] }
  | { kind: 'chatOnly'; kinds: string[] };

/** 種類の言い方と、通知の種類（`kind`）。長い言い方を先に当てる。 */
const KIND_WORDS: [RegExp, string][] = [
  [/承認(?:の)?依頼|承認/, 'approval'],
  [/(?:業務の)?完了|終わった(?:もの|こと)?/, 'run'],
  [/(?:業務の)?失敗/, 'failure'],
  [/(?:朝の|週の|週次の)?ブリーフ/, 'brief'],
  [/(?:急ぎの)?メール/, 'mail'],
  [/社内のお知らせ|お知らせ/, 'notice'],
  [/在庫/, 'inventory'],
  [/予約/, 'reservation'],
  [/契約/, 'contract'],
  [/問い合わせ/, 'inquiry'],
  [/会員/, 'member'],
  [/補助金|助成金/, 'subsidy'],
  [/サイネージ/, 'signage'],
  [/競合(?:の分析)?/, 'competitor'],
  [/セキュリティ/, 'security'],
];

/** 種類の並びの文（「完了と失敗の通知」）を種類にする。種類の言葉だけでできていなければ `null`（「議事録」などを取り違えない）。 */
export function kindsOf(phrase: string): string[] | null {
  const rest = phrase.replace(/[「」『』]/g, '').replace(/(?:の)?(?:通知|知らせ)$/, '');
  const out: string[] = [];
  for (const part of rest.split(/と|・|、|,|や/)) {
    const p = part.replace(/(?:の)?(?:通知|知らせ)$/, '').trim();
    if (!p) continue;
    const hit = KIND_WORDS.find(([re]) => new RegExp(`^(?:${re.source})$`).test(p));
    if (!hit) return null;
    if (!out.includes(hit[1])) out.push(hit[1]);
  }
  return out.length ? out : null;
}

/** 時刻の言い方（「夜 10 時」「朝 8 時半」「22:30」「午後 9 時」）を `HH:MM` にする。読めなければ `null`。 */
export function readTime(text: string): string | null {
  const t = text.normalize('NFKC').replace(/\s+/g, '');
  const colon = /^(?:(夜|朝|午前|午後|昼|夕方))?(\d{1,2}):(\d{2})$/.exec(t);
  const kanji = /^(?:(夜|朝|午前|午後|昼|夕方|深夜))?(\d{1,2})時(?:(半)|(\d{1,2})分)?$/.exec(t);
  const m = colon ? { part: colon[1], h: Number(colon[2]), min: Number(colon[3]) } : kanji ? { part: kanji[1], h: Number(kanji[2]), min: kanji[3] ? 30 : Number(kanji[4] ?? 0) } : null;
  if (!m || m.h > 24 || m.min > 59) return null;
  let h = m.h;
  if ((m.part === '夜' || m.part === '午後' || m.part === '夕方') && h < 12) h += 12;
  if (m.part === '夜' && m.h === 12) h = 0;
  if (m.part === '深夜' && h === 12) h = 0;
  if (h === 24) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m.min).padStart(2, '0')}`;
}

const CHAT = '(?:Chat|chat|チャット)';
const SEND = '(?:送って|届けて|通知して|知らせて)';
const STOP = '(?:送らないで|届けないで|通知しないで|知らせないで|鳴らさないで|控えて|止めて)';
const NO_NEED = '(?:送らなくて(?:いい|よい|大丈夫)|届けなくて(?:いい|よい)|いらない|要らない|不要)';
const TIME = '(?:夜|朝|午前|午後|昼|夕方|深夜)?\\d{1,2}(?::\\d{2}|時(?:半|\\d{1,2}分)?)';

/**
 * 秘書への頼みから、通知の届け方の変更を読み取る（第10.16.5節「変え方」）。
 *
 * @returns 読み取れた変更。通知の届け方の頼みでなければ `null`
 */
export function notifyPreferenceRequest(message: string): NotifyPreferenceRequest | null {
  const m = message.normalize('NFKC').replace(/\s+/g, '').replace(/[。．.!！]+$/, '');
  if (m.length > 80) return null;
  // 時間帯: 「夜 10 時から朝 8 時は（Chat に）送らないで」「9 時〜17 時は通知しないで」
  const range = new RegExp(`^(?:${CHAT}(?:に|は|には))?(${TIME})(?:から|〜|~|-|ー)(${TIME})(?:まで)?(?:の間)?(?:は|には)?(?:${CHAT}(?:に|には|は))?(?:通知を)?${STOP}`).exec(m);
  if (range) {
    const from = readTime(range[1]!);
    const to = readTime(range[2]!);
    if (from && to && from !== to) return { kind: 'quiet', from, to };
    return null;
  }
  // 時間で控えない: 「夜も送っていい」「時間を気にせず Chat に送って」「いつでも通知して」
  if (new RegExp(`^(?:${CHAT}(?:に|は|には))?(?:夜中?|夜間|深夜|時間(?:を)?(?:気にせず|に関係なく)|いつでも|24時間)(?:も)?(?:${CHAT}に)?${SEND}(?:いい|よい|大丈夫|ください|ほしい)?$`).test(m)) {
    return { kind: 'quietOff' };
  }
  // 休みの日: 「土日も送っていい」「休みの日は送らないで」
  const days = '(?:休みの日|休日|土日|週末|祝日|営業日でない日)';
  if (new RegExp(`^${days}(?:も)(?:${CHAT}に)?${SEND}(?:いい|よい|大丈夫|ください|ほしい)?$`).test(m)) return { kind: 'daysOff', on: false };
  if (new RegExp(`^${days}(?:は|には)(?:${CHAT}に)?${STOP}$`).test(m)) return { kind: 'daysOff', on: true };
  // 種類ごと: 「承認の依頼だけ Chat に送って」「完了は Chat に送らなくていい」「完了も Chat に送って」
  const only = new RegExp(`^(.+?)だけ(?:を)?${CHAT}に${SEND}(?:ください|ほしい)?$`).exec(m);
  if (only) {
    const kinds = kindsOf(only[1]!);
    return kinds ? { kind: 'chatOnly', kinds } : null;
  }
  const off = new RegExp(`^(.+?)(?:は|を)${CHAT}に(?:は)?(?:${NO_NEED}|${STOP})$`).exec(m);
  if (off) {
    const kinds = kindsOf(off[1]!);
    return kinds ? { kind: 'chatOff', kinds } : null;
  }
  const on = new RegExp(`^(.+?)も${CHAT}に${SEND}(?:ください|ほしい|いい)?$`).exec(m);
  if (on) {
    const kinds = kindsOf(on[1]!);
    return kinds ? { kind: 'chatOn', kinds } : null;
  }
  return null;
}

/** 種類の名前の並び（「「承認依頼」「業務の完了」」）。 */
const names = (kinds: string[]) => kinds.map((k) => `「${NOTIFICATION_KIND_LABELS[k] ?? k}」`).join('');

/**
 * 読み取った変更を本人の通知の設定に当てる。
 *
 * @returns 新しい設定と、本人への答え
 */
export function applyNotifyPreference(
  current: UserSettings['notifications'], req: NotifyPreferenceRequest,
): { next: UserSettings['notifications']; text: string } {
  const next = { ...current, chatOff: [...(current.chatOff ?? [])] };
  let text: string;
  switch (req.kind) {
    case 'quiet':
      next.quietHours = { from: req.from, to: req.to };
      text = `Chat には、${req.from}〜${req.to} の間は送らず、明けてからまとめて送ります。`;
      break;
    case 'quietOff':
      next.quietHours = null;
      text = next.quietDaysOff ? 'Chat には、時間に関係なく送ります（会社の休みの日は送りません）。' : 'Chat には、時間に関係なく送ります。';
      break;
    case 'daysOff':
      next.quietDaysOff = req.on;
      text = req.on ? '会社の休みの日は、Chat に送りません。明けた日にまとめて送ります。' : '会社の休みの日も、Chat に送ります。';
      break;
    case 'chatOff':
      next.chatOff = [...new Set([...next.chatOff, ...req.kinds])];
      text = `${names(req.kinds)}は Chat に送りません（画面には届きます）。`;
      break;
    case 'chatOn':
      next.chatOff = next.chatOff.filter((k) => !req.kinds.includes(k));
      text = `${names(req.kinds)}も Chat に送ります。`;
      break;
    case 'chatOnly':
      next.chatOff = Object.keys(NOTIFICATION_KIND_LABELS).filter((k) => !req.kinds.includes(k));
      text = `Chat には${names(req.kinds)}だけを送ります（ほかは画面に届きます）。`;
      break;
  }
  if (!current.channels.chat) text += '\nいまは Chat に送らない設定です。Chat でも受け取るときは、個人設定の通知で入れてください。';
  return { next, text };
}
