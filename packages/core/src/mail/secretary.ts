/**
 * @file 秘書がメールの画面の一覧から答える（仕様書 第9.5.1.1節「秘書」、第10.9.6節）。
 *
 * - 「メールをチェックして」「大事なメールある？」: 一覧から答える（その場で 50 通を読み直さない）
 * - 「返事待ちのメールは？」: 返事待ちを答える
 * - 「メールは見なくていい」「またメールを見て」: 見回りを止める・戻す
 * - 「〇〇さんからのメールはすぐ知らせて」: すぐ知らせる相手に足す
 * - 「〇〇さんは 1 週間待って」: その相手だけ、返事待ちに並べるまでの日数を変える
 * - 「〇〇の件は済んだ」: 一覧から外す
 * - 「〇〇さんへの返事を書いて」: 一覧のスレッドの下書きを用意して、画面へのリンクを添える（送るのは画面の「送る」から）
 *
 * 推論に選ばせずに言い回しで見分ける。差出人・件名はデータとして扱う（不変則 I-6）。
 */

import type { MailItem, MailOverview } from '@m2office/shared';

/** メールの依頼の種類。 */
export type MailCommand =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'urgent'; who: string }
  | { kind: 'wait'; who: string; days: number }
  | { kind: 'done'; words: string }
  | { kind: 'reply'; words: string }
  /** 相手を言わない「メールの返信を下書きして」。用意してある下書きを答える。 */
  | { kind: 'drafts' }
  | { kind: 'waiting' };

const NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const numOf = (v: string) => (/^\d+$/.test(v) ? Number(v) : NUM[v] ?? NaN);
/** 名前の後ろの敬称と助詞を除く。 */
const clean = (v: string) => v.replace(/^(あの|その|この)/, '').replace(/(さん|様|さま|社|殿)$/, '').replace(/[「」『』\s]/g, '').trim();

/**
 * メールの画面に関わる依頼か（言い回しで見分ける）。
 *
 * @returns 依頼の種類。当てはまらなければ `null`
 */
export function mailCommand(message: string): MailCommand | null {
  const m = message.trim().replace(/[。！!？?]+$/, '');
  if (/メール(は|を)?(もう)?(見|チェックし|確認し)(なくて(いい|大丈夫|よい)|ないで)/.test(m)) return { kind: 'pause' };
  if (/(また|もう一度|再び)メール(を)?(見|チェックし|確認し)て|メールの見回りを(再開|戻)/.test(m)) return { kind: 'resume' };
  let x = /^(.+?)からの?メール(は|が(来|届)いたら)?(すぐ|すぐに|急ぎで)(知らせ|教え)て/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'urgent', who: clean(x[1]!) };
  x = /^(.+?)(へ|に)?の?(返事|返信)?(は)?\s*([0-9]+|[一二三四五六七八九十])\s*(日|週間)待って/.exec(m);
  if (x && clean(x[1]!)) {
    const n = numOf(x[5]!);
    if (Number.isFinite(n) && n > 0) return { kind: 'wait', who: clean(x[1]!), days: x[6] === '週間' ? n * 5 : n };
  }
  x = /^(.+?)の(件|メール)は(もう)?(済んだ|済み|片付いた|終わった|対応した|返事した|返信した)/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'done', words: clean(x[1]!) };
  x = /^(.+?)(へ|に)の?(返事|返信)(を|の下書きを)?(書いて|作って)/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'reply', words: clean(x[1]!) };
  if (/(返信|返事)待ちの?メール|メールの(返信|返事)待ち|(返信|返事)の来ていないメール/.test(m)) return { kind: 'waiting' };
  if (/メール/.test(m) && /(返信|返事)/.test(m) && /(下書き|書いて|作って)/.test(m)) return { kind: 'drafts' };
  return null;
}

/** 差出人の表示名（「山田 <a@b>」→「山田」）。 */
const nameOf = (from: string) => from.split(',')[0]!.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || from;

/** 一覧の言葉で、合うスレッドを探す（差出人か件名に含むもの。新しいものから）。 */
export function findThread(o: MailOverview, words: string): MailItem | null {
  const w = words.toLowerCase();
  const all = [...o.reply, ...o.action, ...o.waiting, ...o.read];
  return all.find((t) => t.from.toLowerCase().includes(w) || t.subject.toLowerCase().includes(w)) ?? null;
}

/** 1 件の行。 */
const line = (t: MailItem) => `- ${nameOf(t.from)} — ${t.subject || '（件名なし）'}${t.summary || t.due ? `（${[t.summary, t.due ? `期限 ${t.due}` : ''].filter(Boolean).join('・')}）` : ''}`;

/**
 * メールの確認の答え（一覧から。第10.9.6節）。
 */
export function mailOverviewText(o: MailOverview): string {
  const need = o.reply.length + o.action.length;
  const lines = [need ? `返事・対応が要るメールは ${need} 件です。` : '返事・対応が要るメールはありません。'];
  if (o.reply.length) lines.push('', `**返事が要る（${o.reply.length}）**`, ...o.reply.slice(0, 10).map(line));
  if (o.action.length) lines.push('', `**対応が要る（${o.action.length}）**`, ...o.action.slice(0, 10).map(line));
  if (o.waiting.length) lines.push('', `**返事待ち（${o.waiting.length}）**`, ...o.waiting.slice(0, 5).map((t) => `- ${nameOf(t.from)} — ${t.subject}`));
  if (o.read.length || o.promoCount) lines.push('', `ほかに、目を通すだけのものが ${o.read.length} 件、宣伝・お知らせが ${o.promoCount} 件あります。`);
  if (o.aiLimited) lines.push('', 'AI の上限に達したため、新しいメールは振り分けていません。');
  lines.push('', '[メールを開く](/mail)');
  return lines.join('\n');
}

/** 返事待ちの答え。 */
export function mailWaitingText(o: MailOverview): string {
  if (!o.waiting.length) return '返事を待っているメールはありません。';
  return [`返事を待っているメールは ${o.waiting.length} 件です。`, '', ...o.waiting.slice(0, 10).map((t) => `- ${nameOf(t.from)} — ${t.subject}`), '', '催促の下書きは、メールの画面で開くと用意してあります。', '', '[メールを開く](/mail)'].join('\n');
}

/** 用意してある返事の下書きの答え（相手を言わない「メールの返信を下書きして」）。 */
export function mailDraftsText(o: MailOverview): string {
  const ready = o.reply.filter((t) => t.draftReady);
  if (!o.reply.length) return '返事が要るメールはありません。\n\n[メールを開く](/mail)';
  return [
    `返事が要るメール ${o.reply.length} 件のうち、${ready.length} 件に下書きを用意してあります。メールの画面で確かめて、「送る」を押してください。`,
    '', ...o.reply.slice(0, 10).map((t) => `${line(t)}${t.draftReady ? '' : '（下書きはこれから）'}`), '', '[メールを開く](/mail)',
  ].join('\n');
}
