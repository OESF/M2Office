/**
 * @file 秘書の層 1（LLM を使わない直接応答）で答える定型の照会の一覧。
 *
 * 承認待ち・予定・未読メール・今日のタスク・実行状況を、データから直接整形して返す。
 *
 * @see 仕様書 第10.9.2節 層 1 の照会カタログ
 */

import { randomUUID } from 'node:crypto';
import { canDecide, TEXT_SIZES, TEXT_SIZE_STANDARD, stepTextSize, type TextSize, type UserSettings } from '@m2office/shared';
import { withCompartments } from '../engine/run-access.js';
import type { Repository } from '../repository/types.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import { addDays, jst, ymd } from '../connectors/mock.js';
import {
  DO_NOT_REMEMBER, LEADING, TRAILING, memoryTextOf, refusalMessage, refuseToRemember,
} from './memory.js';

/** 「〜は覚えないで」から、覚えない言葉を取り出す。 */
function excludeWordOf(message: string): string {
  return message
    .replace(/[、。,.\s]*(は|を|って|の件は|のことは)?\s*(覚え(ないで(ください)?|なくて(いい|よい|大丈夫)(です)?|ないように(してください)?)|記憶しないで(ください)?)\s*[。．!！]*\s*$/, '')
    .replace(/^\s*(この件は|それは|これは)\s*/, '')
    .trim();
}

/**
 * 層 1 の照会カタログ（仕様書 第10.9.2節）。
 *
 * LLM を介さずにデータを整形して返す定型の照会を、宣言的に定義する。
 * カタログの追加に実装の変更を伴わせないことが狙いである。
 *
 * @remarks
 * 層 1 は推論を通らないため、事実の誤りが混入しない（第10.9.4節）。
 * 頻度の高い照会ほど正確になるという性質は、信頼の獲得に直接効く。
 */
export interface DirectQuery {
  id: string;
  /** 照会の名前。画面や監査ログに表示する。 */
  label: string;
  /** 言い回しの揺れを拾うためのパターン。 */
  patterns: RegExp[];
  /**
   * 当たっても層 1 で答えない言い回し。
   * 「メールの返信を下書きして」は照会ではなく依頼であり、業務エージェントへ回す。
   */
  excludes?: RegExp[];
  /** 権限区画。区画内のものは本人参照に限る（第16.3.4節）。 */
  compartment: string | null;
  /** 層 2 の読み取りに見せる、答えられる範囲（第49.5節）。範囲の外の頼みに選ばせないため */
  readHint?: string;
  answer(ctx: DirectQueryContext): Promise<DirectAnswer>;
}

export interface DirectQueryContext {
  tenantId: string;
  userId: string;
  /** 依頼の本文。「今日」「明日」などの期間の判定に使う。 */
  message: string;
  repo: Repository;
  connector: WorkspaceConnector;
}

export interface DirectAnswer {
  text: string;
  /**
   * 会話ログに残すか（仕様書 第11.9.4.1節）。省略時は残す。
   *
   * @remarks 「この会話は残さないで」のように、残さないこと自体が答えである照会で `false` にする。
   */
  keep?: boolean;
  /** 根拠。その応答に添えて会話ペインに表示する（仕様書 第6.2節）。 */
  evidence: EvidenceItem[];
  /** 文字の大きさを変えたとき、変えた後の値（仕様書 第6.1節）。画面はすぐに当てる。 */
  display?: UserSettings['display'];
}

/** 根拠 1 件。`kind: 'source'` は社内の知識の出典（題名と抜き出しの 2 段で出す。仕様書 第6.2節「出典の見せ方」）。 */
export interface EvidenceItem {
  label: string;
  value: string;
  kind?: 'source';
  /** 答えで根拠にした出典か（画面の「根拠」の先頭に出す。仕様書 第6.2節・第10.9.4.1節）。 */
  cited?: boolean;
}

/** 定型の問いの終わり（「は？」「を教えて」「ある？」など）。頼みの全体の形を読むために使う。 */
const ASK_TAIL = String.raw`(?:の?一覧)?\s*(?:は|を|って)?\s*(?:何|なに)?\s*(?:が|か)?\s*(?:ある|あります|どう|教えて|見せて|確認して|知りたい|何件|いくつ|何通)?(?:か|ですか|ますか|なってる|なっていますか)?(?:ください)?\s*[？?。！!]*\s*$`;

/**
 * 予定の照会の定型（「今日の予定は？」「今週のスケジュールを見せて」「次の予定は？」）。頼みの全体がこの形のときだけ当てる（第49.4節）。
 *
 * @remarks 「今週の予定の詳細を教えて」「10 月 1 日の出張の行程」のような形の違う頼みは、層 2 の読み取りが選ぶ
 */
// @wordlist 定型（第49.4節）
const SCHEDULE_ASK = new RegExp(String.raw`^\s*(?:(?:今日|きょう|本日|明日|あした|あす|今週|次)の)?(?:予定|スケジュール)` + ASK_TAIL);
/** 未読のメールの件数の定型（「未読のメールは何件？」）。 */
// @wordlist 定型（第49.4節）
const UNREAD_ASK = new RegExp(String.raw`^\s*(?:未読(?:の)?メール|メールの未読|未読)` + ASK_TAIL);
/** 今日のタスクの定型（「今日のタスクは？」）。 */
// @wordlist 定型（第49.4節）
const TASKS_ASK = new RegExp(String.raw`^\s*(?:今日の)?(?:タスク|ToDo|やること)` + ASK_TAIL, 'i');
/** 承認待ちの定型（「承認待ちはある？」）。 */
// @wordlist 定型（第49.4節）
const APPROVALS_ASK = new RegExp(String.raw`^\s*(?:承認待ち|承認(?:が)?(?:要る|必要な)もの|確認すること)` + ASK_TAIL);
/** 覚えていることの一覧の定型（「何を覚えてる？」「覚えていることを見せて」）。 */
// @wordlist 定型（第49.4節）
const MEMORY_LIST_ASK = new RegExp(String.raw`^\s*(?:(?:私|わたし)(?:のこと)?(?:について)?(?:は|、)?\s*)?(?:何を覚えて(?:る|いる|います)|覚えている(?:こと)?|記憶(?:の一覧|していること)?)` + ASK_TAIL);
/** 実行の状況の定型（「実行の状況は？」）。 */
// @wordlist 定型（第49.4節）
const RUNS_ASK = new RegExp(String.raw`^\s*(?:実行(?:の)?状況|業務の(?:状況|進み具合|進捗)|進捗|最近の実行)` + ASK_TAIL);

/** 接続口の値の出どころを根拠の 1 行目に示す。ダミーを本物と取り違えないため。 */
export function sourceNote(connector: WorkspaceConnector, tenantId: string): { label: string; value: string }[] {
  return connector.sourceFor(tenantId) === 'mock'
    ? [{ label: '出どころ', value: 'ダミーデータ（Google 未接続）' }]
    : [];
}

const hm = (iso: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
const md = (iso: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' })
    .format(new Date(iso));

/**
 * 予定 1 件の行（本文の箇条書き）。終日の予定は時刻を出さない（0 時と出さない）。
 *
 * @param withDay 日付も出すか（今日の予定なら時刻だけ）
 */
export function eventLine(e: { title: string; start: string; end: string; location: string | null; allDay?: boolean }, withDay: boolean): string {
  const when = e.allDay ? '終日' : `${hm(e.start)}〜${hm(e.end)}`;
  return `- ${withDay ? `${md(e.start)} ` : ''}${when}　${e.title}${e.location ? `（${e.location}）` : ''}`;
}

/** 予定を照会する期間。「今日」「明日」「今週」を言葉から決める。 */
function rangeOf(message: string): { label: string; from: string; to: string } {
  const today = ymd(new Date());
  if (/明日/.test(message)) return { label: '明日', from: jst(addDays(today, 1), 0), to: jst(addDays(today, 2), 0) };
  if (/今週|週/.test(message)) return { label: '今後 7 日間', from: jst(today, 0), to: jst(addDays(today, 7), 0) };
  return { label: '今日', from: jst(today, 0), to: jst(addDays(today, 1), 0) };
}

/** 今日／明日／今週の予定を返す。 */
const schedule: DirectQuery = {
  id: 'calendar-range',
  label: '予定の確認',
  patterns: [SCHEDULE_ASK],
  readHint: '今日・明日・今後 7 日間の予定と、次の予定だけを答えられる。ほかの日（来週の金曜・〇月〇日など）は答えられない',
  compartment: null,
  async answer(ctx) {
    const range = rangeOf(ctx.message);
    const events = await ctx.connector.calendar.list(
      { tenantId: ctx.tenantId, userId: ctx.userId }, { from: range.from, to: range.to },
    );
    const wantsNext = /次の/.test(ctx.message);
    if (wantsNext) {
      const next = events.find((e) => Date.parse(e.start) > Date.now());
      return {
        text: next ? `次の予定は ${md(next.start)}${next.allDay ? '（終日）' : ` ${hm(next.start)} から`}の「${next.title}」です。${next.location ? `場所は ${next.location} です。` : ''}`
          : `${range.label}、この後の予定はありません。`,
        evidence: sourceNote(ctx.connector, ctx.tenantId),
      };
    }
    if (events.length === 0) {
      return { text: `${range.label}の予定はありません。`, evidence: sourceNote(ctx.connector, ctx.tenantId) };
    }
    // 予定の中身は本文に並べる。「根拠」に隠すと、件数しか見えない（2026-11-17。「詳細を表示して」でも同じ答えだった）
    return {
      text: [`${range.label}の予定は ${events.length} 件です。`, '', ...events.map((e) => eventLine(e, range.label !== '今日'))].join('\n'),
      evidence: sourceNote(ctx.connector, ctx.tenantId),
    };
  },
};

/** 未読メールの件数を返す。 */
const unreadMail: DirectQuery = {
  id: 'mail-unread',
  label: '未読メールの確認',
  // 「大事なメールある？」「〇〇のメールを探して」は件数の問いではない。形の違う頼みは層 2 の読み取りが選ぶ（第49.5節）
  patterns: [UNREAD_ASK],
  readHint: '未読の件数を尋ねる頼みだけに選ぶ（新しい未読 5 通の差出人と件名も並べる）。中身を見て大事なものを案内してほしい頼み（確認・チェック・大事なもの）はメールの確認、特定の相手・件名のメールを探す頼みは調べもの',
  compartment: null,
  async answer(ctx) {
    // 受信トレイの「メイン」だけを数える。振り分けられたものと迷惑メールは数えない（仕様書 第10.9.2節）
    const { total, more, items } = await ctx.connector.mail.unread({ tenantId: ctx.tenantId, userId: ctx.userId }, { limit: 5 });
    // 新しいもの（5 件まで）の差出人と件名は本文に並べる（「根拠」に隠さない）
    const from = (m: { from: string }) => m.from.replace(/\s*<.*>$/, '').replace(/^"|"$/g, '');
    return {
      text: total === 0 ? '受信トレイに未読のメールはありません。'
        : [`受信トレイに未読のメールが ${total} 件${more ? '以上' : ''}あります。`, ...(items.length ? ['', ...items.map((m) => `- ${from(m)}: ${m.subject}`), ...(total > items.length ? [`- ほか ${total - items.length} 件${more ? '以上' : ''}`] : [])] : [])].join('\n'),
      evidence: sourceNote(ctx.connector, ctx.tenantId),
    };
  },
};

/** 今日が期限のタスクと、期限を過ぎたタスクを返す。 */
const todayTasks: DirectQuery = {
  id: 'tasks-today',
  label: '今日のタスク',
  patterns: [TASKS_ASK],
  readHint: '今日までが期限の ToDo（タスク・やること）の一覧',
  compartment: null,
  async answer(ctx) {
    const items = await ctx.connector.tasks.list({ tenantId: ctx.tenantId, userId: ctx.userId }, {});
    const endOfToday = Date.parse(jst(addDays(ymd(new Date()), 1), 0));
    const due = items.filter((t) => t.due && Date.parse(t.due) < endOfToday);
    const overdue = due.filter((t) => Date.parse(t.due!) < Date.now());
    return {
      text: due.length === 0
        ? '今日が期限のタスクはありません。'
        : [`今日までのタスクが ${due.length} 件あります（うち期限切れ ${overdue.length} 件）。`, '', ...due.map((t) => `- ${overdue.includes(t) ? '（期限切れ）' : ''}${t.title}`)].join('\n'),
      evidence: sourceNote(ctx.connector, ctx.tenantId),
    };
  },
};

/** 承認待ちの件数と一覧を返す。 */
/**
 * 「この会話は残さないで」に応える（仕様書 第11.9.4.1節、ADR-0014）。
 *
 * @remarks
 * 直近 1 時間の自分の会話を消す。「いまの話」の範囲を、本人にも実装にも分かる形で決めている。
 * 以後も残さないようにするのは、個人設定の「会話を残す」の役目である。
 */
const conversationForget: DirectQuery = {
  id: 'conversation-forget',
  label: '会話を残さない',
  patterns: [/^\s*(この|今の|いまの|さっきの)(会話|話|やり取り|やりとり)[はを]?\s*(残さないで|記録しないで|保存しないで|消して)(ください|ね|ほしい)?\s*[。！!]?\s*$/],
  compartment: null,
  async answer(ctx) {
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const removed = await ctx.repo.clearConversations(ctx.tenantId, ctx.userId, since);
    await ctx.repo.appendAudit({
      id: randomUUID(), tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId,
      action: 'conversation.clear', targetType: 'conversation', targetId: 'recent',
      detail: { removed, scope: '直近 1 時間' }, occurredAt: new Date().toISOString(),
    });
    return {
      text: `直近 1 時間の会話を消しました（${removed} 件）。以後も残さないようにするには、個人設定の「記憶とデータ」で「会話を残す」を切ってください。`,
      evidence: [{ label: '消した会話', value: `${removed} 件` }],
      // 消してほしいという指示そのものも残さない
      keep: false,
    };
  },
};

/**
 * 「〜を覚えておいて」に応える（仕様書 第11.5.1節、ADR-0012）。
 *
 * @remarks
 * 推論を通さず、本人が言った一文をそのまま覚える。覚えないもの（学習の停止・対象外の言葉・
 * 認証情報らしき語・長すぎるもの）は覚えず、その理由を答える。監査ログに中身は残さない。
 */
const memoryRemember: DirectQuery = {
  id: 'memory-remember',
  label: '覚えておく',
  // 「〇〇を覚えておいて」「覚えて: 〇〇」のように、頼みの前か後ろに付いた定型だけに当てる
  patterns: [TRAILING, LEADING],
  // 「覚えないで」と「何を覚えてる？」は別の照会で扱う
  excludes: [DO_NOT_REMEMBER, MEMORY_LIST_ASK],
  compartment: null,
  async answer(ctx) {
    const settings = await ctx.repo.getUserSettings(ctx.tenantId, ctx.userId);
    const text = memoryTextOf(ctx.message);
    const refusal = refuseToRemember(text, settings.memory);
    if (refusal) return { text: refusalMessage(refusal), evidence: [] };

    const now = new Date().toISOString();
    const id = randomUUID();
    await ctx.repo.createMemory({
      id, tenantId: ctx.tenantId, userId: ctx.userId, text, source: 'secretary', createdAt: now,
    });
    // 覚えた中身は監査ログに入れない。記憶は本人のものである（第11.5.1節）
    await ctx.repo.appendAudit({
      id: randomUUID(), tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId,
      action: 'memory.create', targetType: 'memory', targetId: id, detail: { source: 'secretary' },
      occurredAt: now,
    });
    return {
      text: `覚えました: ${text}\n個人設定の「記憶とデータ」で、覚えていることの確認と削除ができます。`,
      evidence: [{ label: '覚えたこと', value: text }],
    };
  },
};

/**
 * 「〜は覚えないで」に応える。対象外の言葉として残す（仕様書 第11.5節「対象外の指定」）。
 */
const memoryForget: DirectQuery = {
  id: 'memory-forget',
  label: '覚えない指定',
  patterns: [DO_NOT_REMEMBER],
  compartment: null,
  async answer(ctx) {
    const settings = await ctx.repo.getUserSettings(ctx.tenantId, ctx.userId);
    const word = excludeWordOf(ctx.message);
    if (!word) {
      return { text: '何を覚えないでおくか分かりませんでした。「〜は覚えないで」の形でお伝えください。', evidence: [] };
    }
    const excludes = settings.memory.excludes.includes(word)
      ? settings.memory.excludes : [...settings.memory.excludes, word];
    await ctx.repo.saveUserSettings(ctx.tenantId, ctx.userId, 'memory', { ...settings.memory, excludes });
    await ctx.repo.appendAudit({
      id: randomUUID(), tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId,
      action: 'me.settings.update', targetType: 'user_settings', targetId: 'memory', detail: {},
      occurredAt: new Date().toISOString(),
    });
    return {
      text: `「${word}」は覚えないようにします。この指定は個人設定の「記憶とデータ」で変えられます。`,
      evidence: [{ label: '覚えない言葉', value: word }],
    };
  },
};

/**
 * 文字の大きさを頼む言い回し（仕様書 第6.1節・第10.9.2節）。頼みの頭に「文字」「字」が来るものだけを拾う。
 *
 * @remarks
 * 「スライドの文字を大きくして」「チラシの字を小さく」は書類への作業の頼みなので、頭が「文字」でないものは拾わない。
 * 「字が小さくて見にくい」は大きくしてほしいという意味として扱う。
 */
const TEXT_LEAD = String.raw`^\s*(?:(?:もう)?(?:少し|ちょっと|すこし|一段)\s*)?(?:画面の|表示の)?(?:文字|字|フォント)(?:の大きさ|のサイズ)?\s*(?:を|が|は)?\s*(?:もう)?(?:少し|ちょっと|すこし|一段)?\s*`;
const TEXT_BIGGER = [
  new RegExp(TEXT_LEAD + String.raw`(?:大きく|拡大)`),
  new RegExp(TEXT_LEAD + String.raw`(?:小さ|細か)くて\s*(?:見|読)(?:にく|づら)い`),
];
const TEXT_SMALLER = [
  new RegExp(TEXT_LEAD + String.raw`(?:小さく(?!て)|縮小)`),
  new RegExp(TEXT_LEAD + String.raw`大き(?:すぎ|過ぎ)`),
];
/** 「文字の大きさを標準に戻して」「字を元の大きさに」。標準（100%）に戻す。 */
const TEXT_RESET = [
  new RegExp(TEXT_LEAD + String.raw`(?:標準|元|もと|普通|ふつう|100\s*[%％])(?:の大きさ|のサイズ)?\s*に`),
];

/**
 * 「文字を大きくして」「字を小さく」「文字を標準に戻して」に応える。本人の文字の大きさを 10% ずつ変える・標準に戻す（仕様書 第6.1節、ADR-0122）。
 *
 * @remarks
 * 危険度は本人の表示の設定を変えるだけ（社外にも、ほかの人にも出ない）。変えた後の段を `display` で返し、画面がすぐに当てる。
 * いちばん端の段から先へは変えず、ブラウザの拡大を案内する。
 */
const textSize: DirectQuery = {
  id: 'text-size',
  label: '文字の大きさ',
  patterns: [...TEXT_RESET, ...TEXT_BIGGER, ...TEXT_SMALLER],
  compartment: null,
  async answer(ctx) {
    const settings = await ctx.repo.getUserSettings(ctx.tenantId, ctx.userId);
    const from = settings.display.textSize;
    const reset = TEXT_RESET.some((p) => p.test(ctx.message));
    const dir = TEXT_BIGGER.some((p) => p.test(ctx.message)) ? 1 : -1;
    const to = reset ? TEXT_SIZE_STANDARD : stepTextSize(from, dir);
    const label = (id: TextSize) => TEXT_SIZES.find((t) => t.id === id)?.label ?? `${id}%`;
    if (to === from) {
      return {
        text: reset ? `いまが標準の「${label(to)}」です。`
          : dir === 1
            ? `いまがいちばん大きい「${label(to)}」です。もっと大きくするときは、ブラウザの拡大をお使いください。`
            : `いまがいちばん小さい「${label(to)}」です。`,
        evidence: [],
      };
    }
    await ctx.repo.saveUserSettings(ctx.tenantId, ctx.userId, 'display', { ...settings.display, textSize: to });
    await ctx.repo.appendAudit({
      id: randomUUID(), tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId,
      action: 'me.settings.update', targetType: 'user_settings', targetId: 'display', detail: { textSize: to },
      occurredAt: new Date().toISOString(),
    });
    return {
      text: `文字の大きさを「${label(to)}」にしました。個人設定の「表示」でも変えられます。`,
      evidence: [],
      display: { textSize: to },
    };
  },
};

/** 「何を覚えてる？」に応える。本人の記憶だけを返す（仕様書 第11.5節）。 */
const memoryList: DirectQuery = {
  id: 'memory-list',
  label: '覚えていることの確認',
  patterns: [MEMORY_LIST_ASK],
  compartment: null,
  async answer(ctx) {
    const items = await ctx.repo.listMemories(ctx.tenantId, ctx.userId);
    if (items.length === 0) {
      return { text: 'いまは何も覚えていません。「〜を覚えておいて」とお伝えいただければ覚えます。', evidence: [] };
    }
    return {
      text: `${items.length} 件を覚えています。個人設定の「記憶とデータ」で削除できます。`,
      evidence: items.slice(0, 10).map((m) => ({ label: '覚えていること', value: m.text })),
    };
  },
};

const pendingApprovals: DirectQuery = {
  id: 'pending-approvals',
  label: '承認待ちの確認',
  patterns: [APPROVALS_ASK],
  readHint: '本人が判断する承認待ちの件数と一覧',
  compartment: null,
  async answer(ctx) {
    // 本人が判断できる承認だけ（承認トレイと同じ規則。ほかの人の業務の承認の中身を見せない。仕様書 第6.2.1節）
    const user = await ctx.repo.findUserById(ctx.tenantId, ctx.userId);
    const all = await ctx.repo.listPendingApprovals(ctx.tenantId);
    const decider = await withCompartments(ctx.repo, ctx.tenantId, all, { id: ctx.userId, roles: user?.roles ?? [] });
    const list = all.filter((a) => canDecide(a, decider));
    if (list.length === 0) {
      return { text: '承認待ちはありません。', evidence: [] };
    }
    return {
      text: `承認待ちが ${list.length} 件あります。`,
      evidence: list.slice(0, 5).map((a) => ({ label: '承認待ち', value: a.present })),
    };
  },
};

/** 直近の実行状況を返す。 */
const recentRuns: DirectQuery = {
  id: 'recent-runs',
  label: '実行状況の確認',
  // 「あれ、どうなった」は件数ではなく、覚えていることから答える（第10.7.3節）。ここでは拾わない
  patterns: [RUNS_ASK],
  readHint: '本人が頼んだ業務の、最近の実行の件数と状態。特定の頼みの結果の中身は答えられない',
  compartment: null,
  async answer(ctx) {
    // 本人が依頼した実行だけ（実行履歴の画面と同じ。ほかの人の実行は数えない）
    const runs = (await ctx.repo.listRunsWithJobs(ctx.tenantId, { limit: 5, requestedBy: ctx.userId })).map((r) => r.run);
    if (runs.length === 0) {
      return { text: 'まだ実行の履歴はありません。', evidence: [] };
    }
    const running = runs.filter((r) => r.status === 'running' || r.status === 'queued');
    const waiting = runs.filter((r) => r.status === 'awaiting_approval');
    return {
      text: `直近 ${runs.length} 件のうち、実行中 ${running.length} 件、承認待ち ${waiting.length} 件です。`,
      evidence: runs.map((r) => ({ label: r.id.slice(0, 8), value: r.status })),
    };
  },
};

/**
 * プロトタイプで用意する照会。
 *
 * @remarks
 * 並び順が判定の優先順である。「承認待ちの予定」のように複数に当たる場合、先のものが勝つ。
 * 予定・メール・タスクは接続口を経由するため、Google 未接続の間はダミーデータを返し、
 * 根拠にその旨を示す（仕様書 第10.9.2節の表）。
 */
export const DIRECT_QUERIES: DirectQuery[] = [
  conversationForget, memoryForget, memoryRemember, memoryList, textSize,
  pendingApprovals, schedule, unreadMail, todayTasks, recentRuns,
];
