import type { Repository } from '../repository/types.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import { addDays, jst, ymd } from '../connectors/mock.js';

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
  /** 根拠。サッシパネルに表示する（仕様書 第6.2節）。 */
  evidence: { label: string; value: string }[];
}

/** 照会ではなく作業の依頼であることを示す言い回し。 */
const ACTION_WORDS = /調整|入れて|作って|作成|下書き|返信|起票|まとめ|送って|共有/;

/** 接続口の値の出どころを根拠の 1 行目に示す。ダミーを本物と取り違えないため。 */
function sourceNote(connector: WorkspaceConnector): { label: string; value: string }[] {
  return connector.source === 'mock'
    ? [{ label: '出どころ', value: 'ダミーデータ（Google 未接続）' }]
    : [];
}

const hm = (iso: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
const md = (iso: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' })
    .format(new Date(iso));

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
  patterns: [/予定|スケジュール/],
  excludes: [ACTION_WORDS],
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
        text: next ? `次の予定は ${md(next.start)} ${hm(next.start)} からの「${next.title}」です。`
          : `${range.label}、この後の予定はありません。`,
        evidence: [...sourceNote(ctx.connector),
          ...(next ? [{ label: hm(next.start), value: `${next.title}（${next.location ?? '場所未設定'}）` }] : [])],
      };
    }
    if (events.length === 0) {
      return { text: `${range.label}の予定はありません。`, evidence: sourceNote(ctx.connector) };
    }
    return {
      text: `${range.label}の予定は ${events.length} 件です。`,
      evidence: [...sourceNote(ctx.connector), ...events.map((e) => ({
        label: range.label === '今日' ? hm(e.start) : `${md(e.start)} ${hm(e.start)}`,
        value: e.title,
      }))],
    };
  },
};

/** 未読メールの件数を返す。 */
const unreadMail: DirectQuery = {
  id: 'mail-unread',
  label: '未読メールの確認',
  patterns: [/メール|受信/],
  excludes: [ACTION_WORDS],
  compartment: null,
  async answer(ctx) {
    const items = await ctx.connector.mail.list({ tenantId: ctx.tenantId, userId: ctx.userId }, { limit: 50 });
    const unread = items.filter((m) => m.unread);
    return {
      text: unread.length === 0 ? '未読のメールはありません。' : `未読のメールが ${unread.length} 件あります。`,
      evidence: [...sourceNote(ctx.connector),
        ...unread.slice(0, 5).map((m) => ({ label: m.from.replace(/\s*<.*>$/, ''), value: m.subject }))],
    };
  },
};

/** 今日が期限のタスクと、期限を過ぎたタスクを返す。 */
const todayTasks: DirectQuery = {
  id: 'tasks-today',
  label: '今日のタスク',
  patterns: [/タスク|ToDo|やること/i],
  excludes: [ACTION_WORDS],
  compartment: null,
  async answer(ctx) {
    const items = await ctx.connector.tasks.list({ tenantId: ctx.tenantId, userId: ctx.userId }, {});
    const endOfToday = Date.parse(jst(addDays(ymd(new Date()), 1), 0));
    const due = items.filter((t) => t.due && Date.parse(t.due) < endOfToday);
    const overdue = due.filter((t) => Date.parse(t.due!) < Date.now());
    return {
      text: due.length === 0
        ? '今日が期限のタスクはありません。'
        : `今日までのタスクが ${due.length} 件あります（うち期限切れ ${overdue.length} 件）。`,
      evidence: [...sourceNote(ctx.connector),
        ...due.map((t) => ({ label: overdue.includes(t) ? '期限切れ' : '今日', value: t.title }))],
    };
  },
};

/** 承認待ちの件数と一覧を返す。 */
const pendingApprovals: DirectQuery = {
  id: 'pending-approvals',
  label: '承認待ちの確認',
  patterns: [/承認/, /確認すること/],
  compartment: null,
  async answer(ctx) {
    const list = await ctx.repo.listPendingApprovals(ctx.tenantId);
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
  patterns: [/実行/, /状況/, /進捗/, /どうなった/],
  compartment: null,
  async answer(ctx) {
    const runs = await ctx.repo.listRuns(ctx.tenantId, 5);
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
  pendingApprovals, schedule, unreadMail, todayTasks, recentRuns,
];
