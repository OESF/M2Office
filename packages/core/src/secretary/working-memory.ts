/**
 * @file 秘書の作業の記憶（いまの状況と 1 週間の記憶）を集め、段ごとの長さに収めて文にする（仕様書 第10.7.4節、ADR-0147）。
 *
 * 秘書は会話を覚えている（第10.7.3節）が、依頼を受け取って振り分ける入口と業務への依頼は、その記憶を見ずに働いていた。
 * ここでは、どの段でも使える形で次の 2 つを持つ。
 *
 * - **いまの状況**: 今日の直近のやり取りの逐語と、その前の今日の要約、話に出たもの（ID とリンク）、最後に頼んだ業務、開いている画面。
 *   今日のやり取りが少なければ、前に使った日の終わりのやり取りを続きとして足す
 * - **1 週間の記憶**: 本人が秘書と話した日の 7 日分（休みの日は数えない。Q-363）の、日ごとの記録
 *   （要約・頼んだ業務すべて・やり取りの要点・話に出たもの）。「月曜日に頼んだ」は、その日を先に渡す
 *
 * **話に出たもの**は、推論の文からではなく、道具の結果と画面の操作から決まりで拾う（{@link mentionsFromTools}）。
 * 集めたものは本人のもの（不変則 I-10）で、データであり指示ではない（不変則 I-6）。
 */

import type { AgentDefinition } from '@m2office/shared';
import type { Conversation, ConversationMention, Repository } from '../repository/types.js';
import { jstDay } from '../memory/learn.js';
import { jobLabel } from '../memory/work.js';

/** 1 週間の記憶に入れる、本人が使った日の数（今日を除く。Q-363）。 */
export const WEEK_DAYS = 7;
/** 使った日を探す範囲（日）。逐語の会話ログの保持期間と同じ（第11.9.6節）。 */
const WEEK_SCAN_DAYS = 28;
/** 1 日の記録の長さの上限（字。第10.7.4.1節）。 */
export const DAY_RECORD_MAX = 4_000;
/** 話に出たものを持つ数（新しいものから。第10.7.4.1節）。 */
export const MENTIONS_MAX = 50;
/** 段ごとの記憶の長さの上限（字。第10.7.4.4節、Q-364）。 */
export const MEMORY_BUDGET = {
  /** 層 3（秘書が答える）に渡す記憶の合計。 */
  full: 24_000,
  /** 層 2（業務を選ぶ推論）に渡す、いまの状況。 */
  route: 2_000,
  /** 業務に頼むときに渡す、いまの状況と指す日の記録。 */
  delegate: 6_000,
} as const;
/** 今日のやり取りが、この数より少なければ、前に使った日の終わりのやり取りを続きとして足す。 */
const CONTINUE_BELOW = 4;
/** 続きとして足す、前に使った日の終わりのやり取りの数。 */
const CONTINUE_TURNS = 4;
/** 1 週間の記憶で、1 回のやり取りを切る長さ（字）。 */
const WEEK_TURN_CHARS = 400;
/** 1 つの道具の結果から拾う、話に出たものの数。 */
const MENTIONS_PER_TOOL = 10;

/** 開いている画面（第10.7.4.3節）。画面から頼んだときだけある。音声と Chat には無い（Q-367）。 */
export interface ScreenContext {
  /** 画面の種類（`library`・`mail` など）。 */
  view: string;
  /** 画面の名前（「ナレッジの整理」など）。 */
  label?: string;
  /** 開いている 1 件。種類・ID・題名だけ（中身は送らない）。 */
  item?: { kind: string; id: string; title?: string };
}

/** 1 日の記録（1 週間の記憶の 1 日分）。 */
export interface DayRecord {
  /** 日本時間の `YYYY-MM-DD`。 */
  day: string;
  /** その日の会話の要約（秘書が書き足したもの）。 */
  summary: string;
  /** その日のやり取り（古い順。切ってある）。 */
  turns: Conversation[];
  /** その日に頼んだ業務（古い順の 1 行ずつ）。 */
  runs: string[];
}

/** 話に出たもの 1 つと、出た時刻。 */
export type DatedMention = ConversationMention & { at: string };

/** 作業の記憶。{@link loadWorkingMemory} で集め、`*Text` で段ごとの文にする。 */
export interface WorkingMemory {
  /** 今日（日本時間の `YYYY-MM-DD`）。 */
  today: string;
  /** 今日のやり取り（古い順）。少なければ前の日の終わりのやり取りが先に付く（`continued`）。 */
  turns: Conversation[];
  /** 前に使った日の終わりのやり取りを、続きとして足したときの、その日。 */
  continuedFrom: string | null;
  /** 今日の要約（秘書が書き足したもの）。 */
  todaySummary: string;
  /** 話に出たもの（新しい順）。 */
  mentions: DatedMention[];
  /** 最後に頼んだ業務。 */
  lastWork: DatedMention | null;
  /** 開いている画面。 */
  screen: ScreenContext | null;
  /** 1 週間の記憶（今日を除く、使った日の新しい順）。 */
  week: DayRecord[];
  /** 依頼が指している日（「月曜日」「昨日」など）。 */
  referred: string[];
}

/**
 * 続きの頼み（「それも探して」「さっきのメールを開いて」「月曜日に頼んだ」）。
 *
 * @remarks これに当たり、いまの状況があるときは、決め打ちの照会（件数・予定など）より先に話の流れで読む（第10.7.4.2節）
 */
export const FOLLOW_UP = /それ(?!ぞれ)|そちら|さっき|先ほど|さきほど|(?:^|[^ぁ-ゖ])あの(?:件|メール|資料|人|会社|業務|仕事|話|ファイル|書類|結果)|(?:この|その)(?:メール|資料|件|ファイル|書類|人|会社|画面|ページ|リンク|結果|業務|仕事|契約|相手|案件|見積|予定|会議)|これ(?:の|を|は|も|に|で)|もう(?:1|一|ひと)(?:つ|件|回|度)|同じ(?:よう|く|もの)|ほかの(?:も|は)|(?:他|ほか)にも|続き|^(?:じゃあ|では|なら|あと)[、,]?|(?<!(?:来週|再来週|次|今度|今週)の?)(?:月|火|水|木|金|土|日)曜(?:日)?(?:に|の)|(?:昨日|きのう|おととい|一昨日)(?:の|に)|前に(?:頼|話|言)|も(?:探して|調べて|お願い)|のも(?:ある|探|調べ|見せ|お願い)|.も[。！？!?]?$/;

/**
 * 続きの頼みのときに当てない、決め打ちの照会（件数・予定・実行の状況など。第10.7.4.2節）。
 *
 * @remarks 「さっきの会話は残さないで」「覚えて」「文字を大きく」のような本人の指図は、続きの頼みでも当てる
 */
export const FOLLOW_UP_SKIPS = new Set(['calendar-range', 'mail-unread', 'tasks-today', 'pending-approvals', 'recent-runs']);

/** 依頼が続きの頼みか（{@link FOLLOW_UP}）。 */
export function followsUp(message: string): boolean {
  return FOLLOW_UP.test(message);
}

/**
 * 前に頼んだ仕事の様子を尋ねる問い（「金曜日に頼んだもの、どうなりました？」「月曜日の依頼の結果を教えて」。第10.7.4.1節）。
 *
 * @remarks 業務に頼み直さず、1 週間の記憶（頼んだ業務の記録）から答える
 */
export const PAST_WORK = /(?:頼んだ|お願いした|依頼した|の依頼)(?:仕事|もの|件|資料|の)?.{0,8}(?:どう|終わ|結果|でき|進み|済ん)/;

/** 開く・見せる・リンクを求める言い方（「さっきのメールを開いて」「その資料のリンク」）。 */
const OPEN_WORDS = /開いて|開きたい|開ける|見せて|リンク|どこ(?:に|だ|で|\?|？|$)|もう一度|もう1度/;
/** 話に出たものを指す言い方。 */
const POINT_BACK = /さっき|先ほど|さきほど|その|それ|あの|前の|見つけた/;
/** 開く頼みの言葉と、話に出たものの種類。 */
const OPEN_KINDS: [RegExp, ConversationMention['kind'][]][] = [
  [/作った(?:もの|資料|文書|スライド)|成果物/, ['artifact']],
  [/メール/, ['mail']],
  [/資料|書類|ファイル|契約書|文書/, ['library', 'drive', 'artifact']],
];

/**
 * 「さっきのメールを開いて」「その資料のリンク」に、話に出たもののどれを出すか（第10.7.4.2節「入口の前」）。推論を使わない。
 *
 * @returns いちばん新しく話に出たその種類のもの（同じやり取りで出たものはすべて。リンクのあるものだけ）。当たらなければ `null`
 * @remarks 探す・作る・送る頼みは当てない（業務に頼む）
 */
export function mentionsToOpen(m: WorkingMemory, message: string): DatedMention[] | null {
  if (!OPEN_WORDS.test(message) || !POINT_BACK.test(message) || /探して|調べて|作って|送って|返信/.test(message)) return null;
  const kinds = OPEN_KINDS.find(([re]) => re.test(message))?.[1];
  if (!kinds) return null;
  const hits = m.mentions.filter((x) => kinds.includes(x.kind) && x.url);
  if (!hits.length) return null;
  return hits.filter((x) => x.at === hits[0]!.at);
}

/** 開いている 1 件を指す言い方（「この資料の要点は？」「これの期限は？」）。 */
const POINTS_TO_OPEN = /^(?:この|これ)|この(?:資料|メール|件|契約|相手|ファイル|書類|文書)|これ(?:の|を|は|に|で|と|って)/;

/**
 * 開いている資料・メールを指す頼みか（第10.7.4.3節）。中身を読まないと答えられないので、調べものに回す（推論が中身を作らないように）。
 *
 * @returns 指していれば開いている 1 件
 */
export function openItemRequest(m: WorkingMemory, message: string): NonNullable<ScreenContext['item']> | null {
  const item = m.screen?.item;
  if (!item || !['資料', 'library', 'mail'].includes(item.kind)) return null;
  return POINTS_TO_OPEN.test(message.trim()) ? item : null;
}

/** 作業の記憶に、続きを読む材料があるか（今日か前の日のやり取り・話に出たもの・開いている画面）。 */
export function hasContext(m: WorkingMemory): boolean {
  return m.turns.length > 0 || m.mentions.length > 0 || !!m.screen?.item;
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 日付（`YYYY-MM-DD`）の曜日。 */
function weekdayOf(day: string): string {
  return WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
}

/** 日付を足し引きする。 */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 本人のタイムゾーンでの今日（`YYYY-MM-DD`）。知らないタイムゾーンは日本時間で読む。 */
function localDay(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: timeZone || 'Asia/Tokyo' }).format(now);
  } catch {
    return jstDay(now).day;
  }
}

/**
 * 依頼が指している日を、本人のタイムゾーンで日付に直す（「月曜日」「昨日の午後」「先週の金曜」「3 日前」「11 月 10 日」。第10.7.4.1節）。
 *
 * @returns 指している日（`YYYY-MM-DD`）。これからの日（「来週の月曜」「明日」）は含めない
 *
 * @remarks 曜日だけのときは、今日を含めて直近のその曜日にする（月曜日に「月曜日に頼んだ」と言えば今日）
 */
export function referredDays(message: string, now: Date = new Date(), timeZone = 'Asia/Tokyo'): string[] {
  const today = localDay(now, timeZone);
  const m = message.normalize('NFKC');
  const out = new Set<string>();
  if (/今日|本日|今朝|けさ/.test(m)) out.add(today);
  if (/昨日|きのう|昨晩|昨夜/.test(m)) out.add(addDays(today, -1));
  if (/一昨日|おととい/.test(m)) out.add(addDays(today, -2));
  for (const x of m.matchAll(/(\d{1,2})日前/g)) out.add(addDays(today, -Number(x[1])));
  const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
  for (const x of m.matchAll(/(先週|先々週|来週|再来週|次の|今度の|今週)?の?([月火水木金土日])曜/g)) {
    const which = x[1] ?? '';
    if (/来週|再来週|次の|今度の/.test(which)) continue;
    const dow = WEEKDAY.indexOf(x[2] as (typeof WEEKDAY)[number]);
    if (which === '先週' || which === '先々週') {
      // 週は月曜から数える。今週の月曜から 1 週（2 週）戻した週の、その曜日
      const monday = addDays(today, -((todayDow + 6) % 7));
      out.add(addDays(monday, (which === '先週' ? -7 : -14) + ((dow + 6) % 7)));
    } else {
      const back = (todayDow - dow + 7) % 7;
      out.add(addDays(today, -back));
    }
  }
  for (const x of m.matchAll(/(\d{1,2})月(\d{1,2})日|(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    const month = Number(x[1] ?? x[3]);
    const date = Number(x[2] ?? x[4]);
    if (month < 1 || month > 12 || date < 1 || date > 31) continue;
    let day = `${today.slice(0, 4)}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
    // これからの日付は去年のものとして読む（過去を振り返る問いのため）
    if (day > today) day = `${Number(today.slice(0, 4)) - 1}${day.slice(4)}`;
    out.add(day);
  }
  return [...out].filter((d) => d <= today).sort().reverse();
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * 道具の結果から、話に出たものを拾う（第10.7.4.1節）。推論の文からは作らない。
 *
 * @param tools 実行の段の `output.tools`（`{ name, result }` の並び）
 * @returns 拾ったもの（道具ごとに {@link MENTIONS_PER_TOOL} 件まで）
 */
export function mentionsFromTools(tools: unknown[]): ConversationMention[] {
  const out: ConversationMention[] = [];
  for (const t of tools) {
    const name = str((t as { name?: unknown } | null)?.name);
    const result = (t as { result?: unknown } | null)?.result as Record<string, unknown> | null | undefined;
    if (!name || !result || typeof result !== 'object') continue;
    const items = Array.isArray(result['items']) ? (result['items'] as Record<string, unknown>[]) : [];
    if (name === 'gmail.search') {
      for (const i of items.slice(0, MENTIONS_PER_TOOL)) {
        const subject = str(i['subject']) || '（件名なし）';
        const who = [str(i['from']), str(i['date']).slice(0, 10)].filter(Boolean).join('、');
        out.push({ kind: 'mail', title: who ? `${subject}（${who}）` : subject, id: str(i['threadId']) || str(i['id']), ...(str(i['url']) ? { url: str(i['url']) } : {}) });
      }
    } else if (name === 'gmail.get') {
      const mail = result['mail'] as Record<string, unknown> | undefined;
      if (mail) out.push({ kind: 'mail', title: str(mail['subject']) || '（件名なし）', id: str(mail['threadId']) || str(mail['id']) });
    } else if (name === 'library.search') {
      for (const i of items.slice(0, MENTIONS_PER_TOOL)) {
        out.push({ kind: 'library', title: str(i['title']) || '資料', id: str(i['id']), ...(str(i['path']) ? { url: str(i['path']) } : {}) });
      }
    } else if (name === 'library.read') {
      const item = result['item'] as Record<string, unknown> | undefined;
      if (item) out.push({ kind: 'library', title: str(item['title']) || '資料', id: str(item['id']), ...(str(item['path']) ? { url: str(item['path']) } : {}) });
    } else if (name === 'drive.search') {
      for (const i of items.slice(0, MENTIONS_PER_TOOL)) {
        out.push({ kind: 'drive', title: str(i['name']) || 'ファイル', id: str(i['id']), ...(str(i['url']) ? { url: str(i['url']) } : {}) });
      }
    }
  }
  return dedupe(out);
}

/** 同じものを 1 つにする（種類と ID、無ければ題名で見る）。先のものを残す。 */
function dedupe<T extends ConversationMention>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const key = `${m.kind}:${m.id || m.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 終わった実行から、話に出たもの（道具が見つけたもの・作ったもの）を拾う（第10.7.4.1節）。
 *
 * @remarks 読めなければ空（伝えることは止めない）
 */
export async function mentionsOfRun(repo: Repository, tenantId: string, runId: string): Promise<ConversationMention[]> {
  try {
    const steps = await repo.listRunSteps(tenantId, runId);
    const tools = steps.flatMap((s) => {
      const t = (s.output as { tools?: unknown } | null)?.tools;
      return Array.isArray(t) ? t : [];
    });
    const artifacts = await Promise.resolve().then(() => repo.listArtifacts(tenantId, runId)).catch(() => []);
    const made: ConversationMention[] = artifacts.map((a) => {
      const link = /^開く: (\S+)/m.exec(a.body)?.[1];
      return { kind: 'artifact', title: a.title, id: a.id, ...(link ? { url: link } : {}) };
    });
    return dedupe([...made, ...mentionsFromTools(tools)]);
  } catch {
    return [];
  }
}

/** 開いている 1 件を、話に出たものにする（「この資料」が指すもの）。 */
export function screenMention(screen: ScreenContext | null | undefined): ConversationMention | null {
  if (!screen?.item?.id) return null;
  const label = screen.label || screen.view;
  return { kind: 'screen', title: `${label}${screen.item.title ? `の「${screen.item.title}」` : `の 1 件（${screen.item.kind}）`}`, id: screen.item.id };
}

/** 秘書の外で持つ、会話を残さない人のその日のやり取り（Q-366）。 */
export type TransientTurns = Conversation[];

/**
 * 作業の記憶を集める（第10.7.4.1節）。
 *
 * @param opts.keep 会話を残している人か。残していない人は、その日の間だけ秘書が持つやり取り（`transient`）だけを使い、1 週間の記憶は作らない（Q-366）
 * @param opts.transient 会話を残さない人の、その日のやり取り
 * @param opts.screen 開いている画面
 * @param opts.timeZone 本人のタイムゾーン（日付で振り返るため）
 *
 * @remarks 1 つが読めなくても集めたものは返す（記憶が欠けても、秘書が使えなくなるよりよい）
 */
export async function loadWorkingMemory(
  repo: Repository, tenantId: string, userId: string, message: string, agents: AgentDefinition[],
  opts: { now?: Date; keep: boolean; transient?: TransientTurns; screen?: ScreenContext | null; timeZone?: string },
): Promise<WorkingMemory> {
  const now = opts.now ?? new Date();
  const today = jstDay(now);
  const safe = <T>(read: () => Promise<T[]> | undefined): Promise<T[]> => Promise.resolve().then(read).then((x) => x ?? []).catch(() => []);
  const referred = referredDays(message, now, opts.timeZone);
  const screen = opts.screen ?? null;
  if (!opts.keep) {
    const turns = (opts.transient ?? []).filter((c) => !c.createdAt || c.createdAt >= today.from);
    return finish({ today: today.day, turns, continuedFrom: null, todaySummary: '', week: [], screen, referred, olderMentions: [] });
  }
  const since = new Date(now.getTime() - WEEK_SCAN_DAYS * 86_400_000).toISOString();
  const [todayRows, days, digests] = await Promise.all([
    safe(() => repo.listConversationsOfDay(tenantId, userId, today)),
    safe(() => repo.listConversationDays?.(tenantId, userId, since)),
    safe(() => repo.listConversationDigests(tenantId, userId, WEEK_SCAN_DAYS + 2)),
  ]);
  // 使った日の 7 日分（今日を除く）と、依頼が指している日（28 日の内で話した日）
  const used = days.filter((d) => d < today.day);
  const weekDays = [...new Set([...used.slice(0, WEEK_DAYS), ...referred.filter((d) => used.includes(d))])].sort().reverse();
  const oldest = weekDays.at(-1);
  const [weekRows, work] = oldest ? await Promise.all([
    safe(() => repo.listConversationsBetween?.(tenantId, userId, jstDay(new Date(`${oldest}T12:00:00+09:00`)).from, today.from, WEEK_TURN_CHARS)),
    safe(() => repo.listRunsWithJobs(tenantId, { limit: 200, requestedBy: userId })),
  ]) : [[], []];
  const dayOf = dayOfIso;
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? '業務';
  const STATUS: Record<string, string> = { queued: '待ち', running: '実行中', awaiting_approval: '承認待ち', completed: '完了', failed: '失敗', cancelled: '中止', expired: '期限切れ' };
  const summaryOf = new Map(digests.filter((d) => d.compartment === null).map((d) => [d.day, d.summary]));
  const week: DayRecord[] = weekDays.map((day) => ({
    day,
    summary: summaryOf.get(day) ?? '',
    turns: weekRows.filter((c) => dayOf(c.createdAt) === day),
    runs: work
      .filter(({ run }) => dayOf(run.startedAt) === day)
      .reverse()
      .map(({ run, job }) => {
        const label = jobLabel(job.input ?? {});
        return `${hhmm(run.startedAt)} ${nameOf(job.agentId)}${label ? `「${label}」` : ''} — ${STATUS[run.status] ?? run.status}（実行 ID: ${run.id}）`;
      }),
  }));
  // 今日のやり取りが少なければ、前に使った日の終わりのやり取りを続きとして足す（「前の作業日の続き」）
  const prev = week[0];
  const carry = todayRows.length < CONTINUE_BELOW && prev ? prev.turns.slice(-CONTINUE_TURNS) : [];
  return finish({
    today: today.day,
    turns: [...carry, ...todayRows],
    continuedFrom: carry.length ? prev!.day : null,
    todaySummary: summaryOf.get(today.day) ?? '',
    week, screen, referred,
    olderMentions: weekRows,
  });
}

/** 話に出たものと最後に頼んだ業務をそろえて、作業の記憶にする。 */
function finish(m: Omit<WorkingMemory, 'mentions' | 'lastWork'> & { olderMentions: Conversation[] }): WorkingMemory {
  const { olderMentions, ...rest } = m;
  const dated = (rows: Conversation[]) => rows.flatMap((c) => (c.mentions ?? []).map((x) => ({ ...x, at: c.createdAt })));
  const fromTurns = dated([...olderMentions, ...m.turns]).sort((a, b) => b.at.localeCompare(a.at));
  const opened = screenMention(m.screen);
  const mentions = dedupe([...(opened ? [{ ...opened, at: new Date().toISOString() }] : []), ...fromTurns]).slice(0, MENTIONS_MAX);
  const lastWork = fromTurns.find((x) => x.kind === 'run') ?? null;
  return { ...rest, mentions, lastWork };
}

/** 時刻（日本時間の `HH:MM`）。読めなければ空。 */
function hhmm(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t + 9 * 3_600_000).toISOString().slice(11, 16);
}

/** 日本時間の日付（`YYYY-MM-DD`）。読めなければ空。 */
function dayOfIso(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : jstDay(new Date(t)).day;
}

/** 月日（`MM/DD`）。読めなければ空。 */
function mmdd(iso: string): string {
  return dayOfIso(iso).slice(5).replace('-', '/');
}

const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** 話に出たもの 1 行。 */
function mentionLine(x: DatedMention): string {
  const KIND: Record<string, string> = { mail: 'メール', library: '資料', artifact: '作ったもの', run: '頼んだ業務', drive: 'ドライブのファイル', screen: '開いている画面' };
  const when = `${mmdd(x.at)} ${hhmm(x.at)}`.trim();
  return `- [${KIND[x.kind] ?? x.kind}] ${x.title}${x.id ? `（ID: ${x.id}）` : ''}${x.url ? ` ${x.url}` : ''}${when ? `（${when}）` : ''}`;
}

/** 行の並びを、上限の字数に収める。収まらなければ `dropFrom` の側から落とす。 */
function fitLines(lines: string[], max: number, dropFrom: 'start' | 'end'): string[] {
  const out = [...lines];
  let total = out.reduce((n, l) => n + l.length + 1, 0);
  while (out.length > 0 && total > max) {
    const removed = dropFrom === 'start' ? out.shift()! : out.pop()!;
    total -= removed.length + 1;
  }
  return out;
}

/**
 * いまの状況を文にする（第10.7.4.2節）。
 *
 * @param max 字数の上限。超えたら、古い逐語 → 今日の要約 → 古い話に出たものの順に落とす
 * @param opts.turns 逐語で渡すやり取りの数の上限
 * @param opts.mentions 話に出たものの数の上限
 * @param opts.turnChars 1 回のやり取りを切る長さ
 */
export function situationText(m: WorkingMemory, max: number, opts: { turns?: number; mentions?: number; turnChars?: number } = {}): string {
  const head: string[] = [];
  if (m.screen) {
    const item = m.screen.item ? `。開いている 1 件: ${m.screen.item.kind}${m.screen.item.title ? `「${m.screen.item.title}」` : ''}（ID: ${m.screen.item.id}）` : '';
    head.push(`- 開いている画面: ${m.screen.label || m.screen.view}${item}`);
  }
  if (m.lastWork) head.push(`- 最後に頼んだ業務: ${m.lastWork.title}（${mmdd(m.lastWork.at)} ${hhmm(m.lastWork.at)}）`);
  if (m.referred.length) head.push(`- 依頼が指している日: ${m.referred.map((d) => `${d}（${weekdayOf(d)}）`).join('、')}`);
  const mentionLines = m.mentions.slice(0, opts.mentions ?? MENTIONS_MAX).map(mentionLine);
  const turnChars = opts.turnChars ?? 600;
  const turnLines = m.turns.slice(-(opts.turns ?? 12)).map((c) => {
    const day = dayOfIso(c.createdAt);
    const when = day === m.today || !day ? hhmm(c.createdAt) : `${mmdd(c.createdAt)} ${hhmm(c.createdAt)}`;
    return `- ${when ? `${when} ` : ''}依頼: ${cut(c.message ?? '', turnChars)}\n  答え: ${cut(c.reply ?? '', turnChars)}`;
  });
  const summary = m.todaySummary ? cut(m.todaySummary, 2_000) : '';
  if (!head.length && !mentionLines.length && !turnLines.length && !summary) return '';

  const title = '## いまの状況（「さっきの」「それ」「この」は、まずここから探す）';
  const build = (mentions: string[], sum: string, turns: string[]) => [
    title, ...head,
    ...(mentions.length ? ['### 話に出たもの（新しい順。開くときは ID とリンクを使う）', ...mentions] : []),
    ...(sum ? ['### 今日のここまでの要約', sum] : []),
    ...(turns.length ? [`### 直近のやり取り（古い順${m.continuedFrom ? `。先頭は前に使った日 ${m.continuedFrom} の続き` : ''}）`, ...turns] : []),
  ].join('\n');
  let text = build(mentionLines, summary, turnLines);
  if (text.length <= max) return text;
  // 古い逐語から落とす（新しい 2 回は残す）
  const fixed = [title, ...head].join('\n').length + 200;
  const turnsKept = fitLines(turnLines, Math.max(max - fixed - (summary.length + mentionLines.join('\n').length), 0), 'start');
  const turns = turnsKept.length >= 2 ? turnsKept : turnLines.slice(-2);
  text = build(mentionLines, summary, turns);
  if (text.length <= max) return text;
  // 次に今日の要約を短くする
  const sum = cut(summary, Math.max(max - fixed - mentionLines.join('\n').length - turns.join('\n').length, 0));
  text = build(mentionLines, sum.length > 20 ? sum : '', turns);
  if (text.length <= max) return text;
  // 最後に古い話に出たものを落とす
  const mentions = fitLines(mentionLines, Math.max(max - fixed - turns.join('\n').length, 0), 'end');
  text = build(mentions, '', turns);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 1 日の記録を文にする（上限の字数に収める。要約 → 頼んだ業務 → 話に出たもの → やり取りの順に残す）。 */
function dayText(r: DayRecord, max: number, referred: boolean): string {
  const head = `### ${r.day}（${weekdayOf(r.day)}）${referred ? '← 依頼が指している日' : ''}`;
  const summary = r.summary ? `要約: ${cut(r.summary, Math.min(1_200, Math.floor(max / 3)))}` : '';
  const runs = r.runs.length ? ['頼んだ業務:', ...r.runs.map((x) => `- ${x}`)] : [];
  const mentions = dedupe(r.turns.flatMap((c) => (c.mentions ?? []).map((x) => ({ ...x, at: c.createdAt })))).slice(0, 15).map(mentionLine);
  const fixed = [head, summary].join('\n').length + 1;
  const runLines = fitLines(runs, Math.floor((max - fixed) * 0.35), 'end');
  const mentionLines = fitLines(mentions.length ? ['話に出たもの:', ...mentions] : [], Math.floor((max - fixed) * 0.2), 'end');
  const rest = max - fixed - runLines.join('\n').length - mentionLines.join('\n').length - 20;
  // やり取りは、1 回の長さを日の量に合わせて縮める（多い日ほど 1 回は短く）
  const per = r.turns.length ? Math.max(60, Math.min(WEEK_TURN_CHARS, Math.floor(rest / r.turns.length / 2) - 20)) : 0;
  const turnLines = fitLines(
    r.turns.map((c) => `- ${hhmm(c.createdAt)} 依頼: ${cut(c.message, per)} → 答え: ${cut(c.reply, per)}`),
    Math.max(rest, 0), 'start',
  );
  const text = [head, summary, ...runLines, ...mentionLines, ...(turnLines.length ? ['やり取り（古い順）:', ...turnLines] : [])].filter(Boolean).join('\n');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 1 週間の記憶を文にする（第10.7.4.1節）。依頼が指している日を先に、1 日 {@link DAY_RECORD_MAX} 字まで渡す。
 *
 * @param max 字数の上限。超えたら古い日から落とす（指している日は残す）
 * @param onlyReferred 指している日だけを渡す（業務に頼むとき）
 */
export function weekText(m: WorkingMemory, max: number, onlyReferred = false): string {
  const referred = m.week.filter((d) => m.referred.includes(d.day));
  const others = onlyReferred ? [] : m.week.filter((d) => !m.referred.includes(d.day));
  if (!referred.length && !others.length) return '';
  const title = '## 1 週間の記憶（本人が秘書と話した日の 7 日分。新しい日から。「〇曜日に頼んだ」はここから探す）';
  let left = max - title.length - 1;
  const parts: string[] = [];
  for (const d of referred) {
    if (left < 200) break;
    const t = dayText(d, Math.min(DAY_RECORD_MAX, left), true);
    parts.push(t);
    left -= t.length + 1;
  }
  // ほかの日は、残りを日の数で分ける（新しい日から。収まらない古い日は落とす）
  for (const [i, d] of others.entries()) {
    if (left < 200) break;
    const share = Math.min(DAY_RECORD_MAX, Math.floor(left / (others.length - i)));
    if (share < 200) break;
    const t = dayText(d, share, false);
    parts.push(t);
    left -= t.length + 1;
  }
  return parts.length ? [title, ...parts].join('\n') : '';
}

/**
 * 業務を選ぶ推論（層 2）に渡す、いまの状況（第10.7.4.2節）。{@link MEMORY_BUDGET.route} 字まで。
 *
 * @returns 渡すものが無ければ空
 */
export function routeSituation(m: WorkingMemory): string {
  return situationText(m, MEMORY_BUDGET.route, { turns: 3, mentions: 5, turnChars: 200 });
}

/**
 * 業務に頼むときに渡す、いまの状況と、依頼が指している日の記録（第10.7.4.2節）。{@link MEMORY_BUDGET.delegate} 字まで。
 *
 * @returns 渡すものが無ければ空
 */
export function delegateContext(m: WorkingMemory): string {
  const week = weekText(m, Math.floor(MEMORY_BUDGET.delegate * 0.4), true);
  const situation = situationText(m, MEMORY_BUDGET.delegate - week.length - 2, { turns: 6, mentions: 15, turnChars: 800 });
  return [situation, week].filter(Boolean).join('\n\n');
}
