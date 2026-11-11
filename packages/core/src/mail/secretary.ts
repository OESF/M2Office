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
 * - 「このメールは新店舗の件」「A と B は同じにして」「採用というカテゴリーを作って」: カテゴリーを直す（第9.5.1.1.1節。中身は推論が読む）
 * - 「新店舗の件でメール来てる？」「アルファ商事から何か届いた？」: カテゴリーか差出人で絞って答える
 * - 「これは返事は要らない」「〇〇さんのメールは大事」「〇〇からのは宣伝でいい」: 振り分けを直して覚える（第9.5.1.1.2節。中身は推論が読む）
 * - 「メールについて何を覚えてる？」「〇〇さんのことは忘れて」: 覚えていることを答える・消す
 * - 「メールの学びの数を運営に共有して」「共有をやめて」: ベータテストの数の共有を切り替える
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
  /** `finished`: 「〇〇の件は終わった」「片付いた」（案件も終える。第11.13.8節「終わり」） */
  | { kind: 'done'; words: string; finished: boolean }
  | { kind: 'reply'; words: string }
  /** 相手を言わない「メールの返信を下書きして」。用意してある下書きを答える。 */
  | { kind: 'drafts' }
  | { kind: 'waiting' }
  /**
   * カテゴリーか振り分けの直し（中身は推論が読む）。`weak` は「A と B は同じにして」のように、カテゴリーの言葉を含まないもの
   * （カテゴリーがまだ 1 つも無ければ、メールの頼みとして扱わない）。
   */
  | { kind: 'teach'; text: string; weak: boolean }
  /** 覚えていることを答える。 */
  | { kind: 'lessons' }
  /** 相手について覚えていることを消す（合うものが無ければ、ふつうの記憶の「忘れて」として扱う）。 */
  | { kind: 'forget'; who: string }
  /** 学びの週ごとの数を運営に共有する・やめる。 */
  | { kind: 'share'; on: boolean }
  /** カテゴリーか差出人で絞って答える。 */
  | { kind: 'categoryAsk'; words: string };

const NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const numOf = (v: string) => (/^\d+$/.test(v) ? Number(v) : NUM[v] ?? NaN);
/** 名前の後ろの敬称と助詞を除く。 */
const clean = (v: string) => v.replace(/^(あの|その|この)/, '').replace(/(さん|様|さま|社|殿)$/, '').replace(/[「」『』\s]/g, '').trim();

/** 末尾の「。」「！」「？」を外す（正規表現の `[。！!？?]+$` は、記号が長く続くと遅くなるので、文字で見る）。 */
function trimEndMarks(s: string): string {
  let end = s.length;
  while (end > 0 && '。！!？?'.includes(s[end - 1]!)) end -= 1;
  return s.slice(0, end);
}

/**
 * 「〇〇は 1 週間待って」の〇〇と日数（正規表現で文の頭から読ませず、「待って」の前を文字で切り出す）。
 *
 * @returns 合わなければ `null`
 */
function waitOf(m: string): { who: string; days: number } | null {
  const w = /([0-9]{1,3}|[一二三四五六七八九十])\s{0,3}(日|週間)待って/.exec(m);
  if (!w) return null;
  let who = m.slice(0, w.index).trim();
  for (const suffix of [['は'], ['返事', '返信'], ['の'], ['へ', 'に']]) {
    const hit = suffix.find((x) => who.endsWith(x));
    if (hit) who = who.slice(0, -hit.length);
  }
  const n = numOf(w[1]!);
  return clean(who) && Number.isFinite(n) && n > 0 ? { who: clean(who), days: w[2] === '週間' ? n * 5 : n } : null;
}

/**
 * メールの画面に関わる依頼か（言い回しで見分ける）。
 *
 * @returns 依頼の種類。当てはまらなければ `null`
 */
export function mailCommand(message: string): MailCommand | null {
  const m = trimEndMarks(message.trim());
  // 学び（第9.5.1.1.2節）。覚えていること・忘れる・共有
  if (/メール(について|のこと|で|の(分け方|振り分け)について)?(何|なに)を?覚えて/.test(m)) return { kind: 'lessons' };
  // 「学びの数を運営に共有して」「メールの学びの数を…」（第11.13.7節「見せ方」。第9.5.1.1.2節）
  // 「勉強会の学びを共有して」のような、ほかの頼みと取り違えないよう、「学びの数」「メールの学び」のときだけ見る
  const learn = Math.max(m.indexOf('学びの数'), m.indexOf('メールの学び'));
  if (learn >= 0 && /運営|共有/.test(m.slice(learn))) return { kind: 'share', on: !/(やめ|止め|しないで|解除)/.test(m) };
  const f = /^(.+?)(さん|様|さま|社)?(のこと|からのメール(のこと)?)は忘れて/.exec(m);
  if (f && clean(f[1]!)) return { kind: 'forget', who: clean(f[1]!) };
  // 振り分けの直し（「この手のメールは見なくていい」が、見回りを止める頼みに取られないよう、先に見る）
  if (/^(これ|この(メール|人|方|相手)|.+?(から|さん|様|社)の?(メール|お知らせ)?)は(返事|返信)(が|は)?(要る|必要|要らない|いらない|不要|しなくて(いい|よい))/.test(m)
    || /^(.+?)(さん|様)?(から)?の(メール|お知らせ)?は(大事|重要|大切)/.test(m)
    || /^(.+?)からの?(メール|お知らせ)?は(宣伝|お知らせ|見なくて(いい|よい)|目を通すだけ|読むだけ)/.test(m)
    || /^この手の(メール|お知らせ)/.test(m)
    || /^(これ|このメール)は(宣伝|お知らせ|目を通すだけ|大事|重要|対応が要る)/.test(m)) {
    return { kind: 'teach', text: m, weak: false };
  }
  if (/^(もう)?メール(は|を)?(もう)?(見|チェックし|確認し)(なくて(いい|大丈夫|よい)|ないで)/.test(m)) return { kind: 'pause' };
  if (/(また|もう一度|再び)メール(を)?(見|チェックし|確認し)て|メールの見回りを(再開|戻)/.test(m)) return { kind: 'resume' };
  let x = /^(.+?)からの?メール(は|が(来|届)いたら)?(すぐ|すぐに|急ぎで)(知らせ|教え)て/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'urgent', who: clean(x[1]!) };
  const wait = waitOf(m);
  if (wait) return { kind: 'wait', ...wait };
  x = /^(.+?)の(件|メール)は(もう)?(済んだ|済み|片付いた|終わった|対応した|返事した|返信した)/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'done', words: clean(x[1]!), finished: x[2] === '件' && /終わった|片付いた/.test(x[4]!) };
  // カテゴリー（第9.5.1.1.1節）。直しは推論が読むので、ここでは頼みかどうかだけを見分ける
  if (/^(この|その|さっきの|今の|いまの)?メール(は|を)(.+?)の(件|カテゴリー|プロジェクト)(に(して|入れて|分けて))?(です|だ|だよ)?$/.test(m)
    || fromSenderIsCategory(m)
    || (/(カテゴリー|プロジェクト)/.test(m) && /(作って|まとめて|分けて|同じに|名前|変えて|消して|いらない|要らない|直して|付け替え|入れて|外して|終わった)/.test(m))) {
    return { kind: 'teach', text: m, weak: false };
  }
  // 案件との結び付けの直し（第11.13.8節）:「見本商事のメールは見積の件とは別」「新店舗の件のメールは内装の案件に入れて」
  if (/メール/.test(m) && (/案件/.test(m) || /の件(とは|と)(別|違う|関係ない)/.test(m)) && /(別|違う|関係ない|入れて|結んで|つなげて|まとめて|一緒|同じ|外して|分けて)/.test(m)) {
    return { kind: 'teach', text: m, weak: false };
  }
  const same = m.indexOf('は同じ');
  if (same > 1 && m.slice(0, same).includes('と') && /^は同じ(カテゴリー|プロジェクト|件)?(に|として|で)/.test(m.slice(same))) return { kind: 'teach', text: m, weak: true };
  x = /^(.+?)の(件|カテゴリー|プロジェクト)(で|の|について)の?(メール|連絡)(は|が|って)?(来|届|あ)/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'categoryAsk', words: clean(x[1]!) };
  x = /^(.+?)から(何か|なにか|メール|連絡)(は|が)?(来|届)(て(る|いる|ます)|た|いた)/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'categoryAsk', words: clean(x[1]!) };
  x = /^(.+?)(へ|に)の?(返事|返信)(を|の下書きを)?(書いて|作って)/.exec(m);
  if (x && clean(x[1]!)) return { kind: 'reply', words: clean(x[1]!) };
  if (/(返信|返事)待ちの?メール|メールの(返信|返事)待ち|(返信|返事)の来ていないメール/.test(m)) return { kind: 'waiting' };
  if (/メール/.test(m) && /(返信|返事)/.test(m) && /(下書き|書いて|作って)/.test(m)) return { kind: 'drafts' };
  return null;
}

/** 「〇〇からのメールは〇〇の件」か（目印の言葉を文字で探し、正規表現で文の頭から読ませない）。 */
function fromSenderIsCategory(m: string): boolean {
  const at = m.search(/からの?メール[はを]/);
  return at > 0 && /の(件|カテゴリー|プロジェクト)/.test(m.slice(at));
}

/** 差出人の表示名（「山田 <a@b>」→「山田」）。 */
const nameOf = (from: string) => from.split(',')[0]!.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || from;

/** 一覧の言葉で、合うスレッドを探す（差出人か件名に含むもの。新しいものから）。 */
export function findThread(o: MailOverview, words: string): MailItem | null {
  const w = words.toLowerCase();
  const all = [...o.reply, ...o.action, ...o.waiting, ...o.read];
  return all.find((t) => t.from.toLowerCase().includes(w) || t.subject.toLowerCase().includes(w)) ?? null;
}

/**
 * カテゴリーか差出人で絞った答え（「新店舗の件でメール来てる？」）。
 *
 * @param category 合ったカテゴリーの名前（差出人・件名で探したときは `null`）
 * @param kase そのカテゴリーに結んだ進んでいる案件（第11.13.8節）。あれば、次にやることと期限を 1 行添える
 */
export function mailCategoryText(words: string, category: string | null, items: MailItem[], kase: { title: string; nextStep: string; dueOn: string | null } | null = null): string {
  const what = category ? `「${category}」のメール` : `「${words}」に合うメール`;
  const caseLine = kase && (kase.nextStep || kase.dueOn)
    ? [`案件「${kase.title}」${kase.nextStep ? `の次にやること: ${kase.nextStep}` : ''}${kase.dueOn ? `（期限 ${kase.dueOn}）` : ''}`, '']
    : [];
  if (!items.length) return [`一覧には、${what}はありません。`, '', ...caseLine, '[メールを開く](/mail)'].join('\n');
  const label: Record<string, string> = { reply: '返事が要る', action: '対応が要る', waiting: '返事待ち', read: '目を通すだけ' };
  return [`一覧に、${what}が ${items.length} 件あります。`, '', ...items.slice(0, 10).map((t) => `${line(t)}［${label[t.group] ?? ''}］`), '', ...caseLine, '[メールを開く](/mail)'].join('\n');
}

/** 覚えていることの答え（第9.5.1.1.2節「見る・直す・消す」）。 */
export function mailLessonsText(items: { text: string; source: 'told' | 'behavior' }[]): string {
  if (!items.length) return 'メールの分け方について、まだ覚えていることはありません。違う分け方をしていたら「これは返事は要らない」のように言ってください。';
  const told = items.filter((x) => x.source === 'told');
  const seen = items.filter((x) => x.source === 'behavior');
  return [
    `メールの分け方について、${items.length} 件覚えています。`,
    ...(told.length ? ['', '**あなたが直したこと**', ...told.slice(0, 15).map((x) => `- ${x.text}`)] : []),
    ...(seen.length ? ['', '**ふだんの扱いから**', ...seen.slice(0, 15).map((x) => `- ${x.text}`)] : []),
    '', '違っていれば「〇〇さんのことは忘れて」と言ってください。個人設定の「記憶とデータ」でも消せます。',
  ].join('\n');
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
