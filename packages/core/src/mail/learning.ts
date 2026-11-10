/**
 * @file メールの学び（仕様書 第9.5.1.1.2節、ADR-0133）。本人の直しとふるまいから、相手ごとの傾向を覚える。
 *
 * - 本人の直し（`told`）: 1 回で覚える。差出人ごとの直しは、次から分け先をそのとおりにする
 * - ふるまい（`behavior`）: 同じ相手で 60 日の間に 3 回そろったら傾向にする（{@link isActive}）
 * - 重さ: 本人の直し ＞ ふるまいの傾向 ＞ AI の推し量り（{@link groupLessonFor}）
 * - 90 日当たらなかった傾向は消す。本人の直しと逆のふるまいが 3 回そろったら、直しを弱める
 *
 * **モデルは学習させない。** 覚えたことを次の推論に例として渡す（第11.9.3節の「システムの蓄積」）。
 * 学ぶのは本人の直しとふるまいだけで、メールの中身に書かれた文からは学ばない（不変則 I-6）。会社の知識には昇華しない。
 */

import { createHash } from 'node:crypto';
import { MAIL_GROUP_LABELS, type MailCategoryLesson } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { MailOwner, MailStore } from './store.js';

/** 何を学ぶか。 */
export type MailLessonKind = 'group' | 'category' | 'style';
/** 何に当てるか。 */
export type MailLessonKey = 'from' | 'domain' | 'subject';
/** 振り分けの分け先（`important` は「大事な相手」。宣伝にせず、目を通すだけの中で上に並べる）。 */
export type MailGroupTarget = 'reply' | 'action' | 'read' | 'promo' | 'important';

/** 覚えた傾向の 1 つ。 */
export interface MailLessonRow {
  id: string;
  kind: MailLessonKind;
  keyType: MailLessonKey;
  /** メールアドレス・ドメイン（小文字）か、件名の頭の決まった形。 */
  keyValue: string;
  /** 分け先（振り分け: {@link MailGroupTarget}。カテゴリー: 名前。書き方: `shorter`・`longer`）。 */
  target: string;
  source: 'told' | 'behavior';
  /** 本人の直しのときの件名（カテゴリーの例に使う）。 */
  subject: string;
  /** ふるまいがあった時刻（新しいものから 10 個まで）。 */
  hits: string[];
  firstAt: string;
  lastAt: string;
  /** 振り分けで最後に当てた時刻。 */
  usedAt: string;
}

/** 決まった値。 */
export const MAIL_LEARNING = {
  /** ふるまいを傾向にするまでの回数と日数。 */
  behaviorHits: 3,
  behaviorDays: 60,
  /** 当たらなかった傾向を消すまでの日数。 */
  forgetDays: 90,
  /** 1 回の振り分けの推論に渡す例の数。 */
  promptLessons: 30,
  /** 届いてから、この時間のうちに開いたら「大事」のふるまいとして数える。 */
  quickOpenMs: 60 * 60_000,
} as const;

/** ドメインにまとめない、個人向けのメールのドメイン。 */
export const PERSONAL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com', 'yahoo.co.jp', 'yahoo.com', 'icloud.com', 'me.com', 'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.jp', 'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp']);

/** メールアドレスを取り出す（「山田 <a@b>」→「a@b」。小文字）。 */
export function lessonAddress(from: string): string {
  return (bracketed(from) ?? from.split(',')[0]!).trim().toLowerCase();
}

/** 「山田 <a@b>」の <> の中（正規表現の `<([^>]+)>` は、< が長く続くと遅くなるので、文字で探す）。無ければ `null`。 */
export function bracketed(v: string): string | null {
  const a = v.indexOf('<');
  const b = a >= 0 ? v.indexOf('>', a + 1) : -1;
  return b > a + 1 ? v.slice(a + 1, b) : null;
}

/** ドメイン（無ければ空）。 */
export const domainOfAddress = (address: string) => address.includes('@') ? address.split('@')[1]!.trim().toLowerCase() : '';

/** 件名の頭の決まった形（「【定例】」「[お知らせ]」）。無ければ空。 */
export function subjectTag(subject: string): string {
  const m = /^\s*(?:(?:re|fw|fwd)\s*:\s*)*(【[^】]{1,20}】|\[[^\]]{1,20}\]|［[^］]{1,20}］)/i.exec(subject);
  return m ? m[1]! : '';
}

/** 傾向の ID（同じ種類・当て先・分け先・出どころなら同じ ID）。 */
export function lessonId(kind: MailLessonKind, keyType: MailLessonKey, keyValue: string, target: string, source: 'told' | 'behavior'): string {
  return `ml-${createHash('sha256').update([kind, keyType, keyValue, target, source].join('\u0000')).digest('hex').slice(0, 24)}`;
}

/** 60 日のうちのふるまいの回数。 */
const recentHits = (l: MailLessonRow, now: Date) => l.hits.filter((h) => now.getTime() - Date.parse(h) <= MAIL_LEARNING.behaviorDays * 86_400_000).length;

/**
 * 当てる傾向か。本人の直しはいつも当てる。ふるまいは 60 日に 3 回そろったら（書き方は 1 回で）。
 */
export function isActive(l: MailLessonRow, now: Date): boolean {
  if (l.source === 'told') return true;
  return recentHits(l, now) >= (l.kind === 'style' ? 1 : MAIL_LEARNING.behaviorHits);
}

/**
 * 本人の直しが、逆のふるまいで弱まっているか（直しの後に、違う分け先のふるまいが 3 回そろった）。弱まった直しは、決めつけずに例として渡す。
 */
export function isWeakened(told: MailLessonRow, lessons: MailLessonRow[]): boolean {
  if (told.source !== 'told' || told.kind !== 'group') return false;
  return lessons.some((b) => b.source === 'behavior' && b.kind === 'group' && b.keyType === told.keyType && b.keyValue === told.keyValue
    && b.target !== told.target && b.hits.filter((h) => h > told.lastAt).length >= MAIL_LEARNING.behaviorHits);
}

/** 振り分けの傾向で、この 1 通に当たるもの。 */
export interface GroupLesson {
  lesson: MailLessonRow;
  target: MailGroupTarget;
  /** 本人の直しで、弱まっていない（分け先をそのとおりにする）。 */
  fixed: boolean;
}

/**
 * 1 通に当たる振り分けの傾向を選ぶ。重さは、本人の直し（アドレス ＞ ドメイン ＞ 件名の形）＞ ふるまい（アドレス ＞ ドメインのまとめ ＞ 件名の形）。
 *
 * @param ownDomain 本人の会社のドメイン（ドメインにまとめない）
 */
export function groupLessonFor(lessons: MailLessonRow[], from: string, subject: string, ownDomain: string, now: Date): GroupLesson | null {
  const address = lessonAddress(from);
  const domain = domainOfAddress(address);
  const tag = subjectTag(subject);
  const groups = lessons.filter((l) => l.kind === 'group' && isActive(l, now));
  const keyed = (source: 'told' | 'behavior', keyType: MailLessonKey, value: string) =>
    value ? groups.filter((l) => l.source === source && l.keyType === keyType && l.keyValue === value).sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0] : undefined;
  const pick = (l: MailLessonRow | undefined, fixed: boolean): GroupLesson | null => (l ? { lesson: l, target: l.target as MailGroupTarget, fixed: fixed && !isWeakened(l, lessons) } : null);
  const domainOk = !!domain && !PERSONAL_DOMAINS.has(domain) && domain !== ownDomain.toLowerCase();
  const told = pick(keyed('told', 'from', address), true) ?? (domainOk ? pick(keyed('told', 'domain', domain), true) : null) ?? pick(keyed('told', 'subject', tag), true);
  if (told) return told;
  const own = pick(keyed('behavior', 'from', address), false);
  if (own) return own;
  if (domainOk) {
    // 同じドメインの 2 つ以上のアドレスで同じ傾向なら、ドメインにまとめて当てる
    const same = groups.filter((l) => l.source === 'behavior' && l.keyType === 'from' && domainOfAddress(l.keyValue) === domain);
    const byTarget = new Map<string, MailLessonRow[]>();
    for (const l of same) byTarget.set(l.target, [...(byTarget.get(l.target) ?? []), l]);
    const best = [...byTarget.values()].filter((xs) => new Set(xs.map((x) => x.keyValue)).size >= 2).sort((a, b) => b.length - a.length)[0];
    if (best) return pick(best[0], false);
  }
  return pick(keyed('behavior', 'subject', tag), false);
}

/** 分け先の言い方。 */
export const targetLabel = (t: string) => (t === 'important' ? '大事な相手' : MAIL_GROUP_LABELS[t as keyof typeof MAIL_GROUP_LABELS] ?? t);

/**
 * 振り分けの推論に足す、本人の傾向の決まり（当たるものだけ。30 件まで）。
 *
 * @param hits 1 通ずつの当たった傾向（推論に渡す順）
 */
export function groupLessonRule(hits: (GroupLesson | null)[]): string {
  const lines = hits.map((h, i) => (h ? `- i=${i}: ${targetLabel(h.target)}（${h.lesson.source === 'told' ? '本人の直し' : '本人のふだんの扱い'}）` : '')).filter(Boolean).slice(0, MAIL_LEARNING.promptLessons);
  if (!lines.length) return '';
  return [
    '本人の傾向（本人の直しは従う。ふだんの扱いは参考にする。ただし本文がはっきり返事や手続きを求めていれば本文を先にする。「大事な相手」は promo にしない）:',
    ...lines,
  ].join('\n');
}

/** カテゴリーの直しを、カテゴリーの決まりに渡す例の形にする（新しいものから）。 */
export function categoryLessonsOf(lessons: MailLessonRow[]): MailCategoryLesson[] {
  return lessons.filter((l) => l.kind === 'category' && l.source === 'told').sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .map((l) => ({ from: l.keyValue, subject: l.subject, category: l.target }));
}

/** 書き方の傾向（同じ相手か同じ会社への下書きを、本人がいつも短く・長く直すか）。 */
export function styleFor(lessons: MailLessonRow[], to: string, now: Date): 'shorter' | 'longer' | null {
  const address = lessonAddress(to);
  const domain = domainOfAddress(address);
  const style = lessons.filter((l) => l.kind === 'style' && isActive(l, now));
  const hit = style.find((l) => l.keyType === 'from' && l.keyValue === address) ?? style.find((l) => l.keyType === 'domain' && l.keyValue === domain);
  return hit ? hit.target as 'shorter' | 'longer' : null;
}

/** 日本時間のその週の月曜日（`YYYY-MM-DD`）。 */
export function weekOf(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  const day = (jst.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** 1 つの傾向の言い方（「記憶とデータ」と秘書の答えに出す）。 */
export function describeLesson(l: MailLessonRow): string {
  const who = l.keyType === 'subject' ? `件名が「${l.keyValue}」で始まるメール` : l.keyType === 'domain' ? `${l.keyValue} からのメール` : `${l.keyValue} からのメール`;
  const how = l.source === 'told' ? '（あなたの直し）' : `（ふだんの扱いから。${l.hits.length} 回）`;
  if (l.kind === 'category') return `${who}は「${l.target || 'カテゴリーなし'}」${how}`;
  if (l.kind === 'style') return `${l.keyValue} への返事の下書きは、${l.target === 'shorter' ? '短めに' : '詳しめに'}書く${how}`;
  return `${who}は「${targetLabel(l.target)}」${how}`;
}

/** 学びを記録するのに使うもの。 */
export interface MailLearnerDeps {
  store: MailStore;
  repo: Pick<Repository, 'getUserSettings'>;
}

/**
 * 学びを記録する（見回りと画面の処理が使う）。本人が「覚えることを許す」を切っていれば、新しく覚えない（覚えたものは使い続ける）。
 */
export class MailLearner {
  constructor(private readonly deps: MailLearnerDeps) {}

  /** 新しく覚えてよいか（個人設定の「記憶とデータ」の「覚えることを許す」。第6.5.4節）。 */
  async enabled(o: MailOwner): Promise<boolean> {
    return (await this.deps.repo.getUserSettings(o.tenantId, o.userId).catch(() => null))?.memory.learning !== false;
  }

  /**
   * ふるまいを 1 回数える（同じ相手で 60 日に 3 回そろったら傾向になる）。件名の頭に決まった形があれば、その形でも数える。
   *
   * @param miss 振り分けの外れとして週の数に足すか（「返事が要る」を返事せずに片付けた・「目を通すだけ」に返事をした）
   */
  async behavior(o: MailOwner, from: string, subject: string, target: MailGroupTarget, now: Date, miss = false): Promise<void> {
    if (miss) await this.deps.store.addWeek(o, weekOf(now), { misses: 1 });
    if (!(await this.enabled(o))) return;
    const address = lessonAddress(from);
    if (!address.includes('@')) return;
    const keys: [MailLessonKey, string][] = [['from', address]];
    const tag = subjectTag(subject);
    if (tag) keys.push(['subject', tag]);
    const all = await this.deps.store.lessons(o);
    for (const [keyType, keyValue] of keys) {
      const id = lessonId('group', keyType, keyValue, target, 'behavior');
      const cur = all.find((l) => l.id === id);
      const at = now.toISOString();
      await this.deps.store.saveLesson(o, cur
        ? { ...cur, hits: [at, ...cur.hits].slice(0, 10), lastAt: at }
        : { id, kind: 'group', keyType, keyValue, target, source: 'behavior', subject: '', hits: [at], firstAt: at, lastAt: at, usedAt: at });
    }
  }

  /**
   * 本人の直しを覚える（1 回で覚える。同じ当て先の、違う分け先の直しは置き換える）。週の「直した回数」に足す。
   */
  async teach(o: MailOwner, kind: MailLessonKind, keyType: MailLessonKey, keyValue: string, target: string, now: Date, subject = ''): Promise<void> {
    await this.deps.store.addWeek(o, weekOf(now), { corrections: 1 });
    if (!(await this.enabled(o)) || !keyValue) return;
    const value = keyType === 'subject' ? keyValue : keyValue.toLowerCase();
    const all = await this.deps.store.lessons(o);
    for (const l of all) {
      // カテゴリーの直しは、同じ相手・同じ件名ごとに 1 つ。振り分けと書き方の直しは、同じ当て先ごとに 1 つ
      const same = l.kind === kind && l.source === 'told' && l.keyType === keyType && l.keyValue === value && (kind !== 'category' || l.subject === subject);
      if (same) await this.deps.store.deleteLesson(o, l.id);
    }
    const at = now.toISOString();
    const id = kind === 'category' ? lessonId(kind, keyType, `${value}\u0000${subject}`, '', 'told') : lessonId(kind, keyType, value, target, 'told');
    await this.deps.store.saveLesson(o, { id, kind, keyType, keyValue: value, target, source: 'told', subject, hits: [], firstAt: at, lastAt: at, usedAt: at });
  }

  /** カテゴリーをまとめた・名前を変えたとき、直した例の名前を付け替える。 */
  async renameCategory(o: MailOwner, from: string, to: string): Promise<void> {
    for (const l of await this.deps.store.lessons(o)) {
      if (l.kind === 'category' && l.target === from) await this.deps.store.saveLesson(o, { ...l, target: to });
    }
  }

  /** 振り分けで当てた傾向に、当てた時刻を付ける（90 日当たらなければ消すため）。 */
  async used(o: MailOwner, lessons: MailLessonRow[], now: Date): Promise<void> {
    const at = now.toISOString();
    for (const l of lessons) if (l.usedAt.slice(0, 10) !== at.slice(0, 10)) await this.deps.store.saveLesson(o, { ...l, usedAt: at });
  }

  /** 90 日当たらなかった傾向を消す。 */
  async forget(o: MailOwner, now: Date): Promise<number> {
    return this.deps.store.forgetLessons(o, new Date(now.getTime() - MAIL_LEARNING.forgetDays * 86_400_000).toISOString());
  }

  /**
   * 書き方の直しの向きを覚える（下書きを大きく短く・長く直して送ったとき）。
   */
  async style(o: MailOwner, to: string, draft: string, sent: string, now: Date): Promise<void> {
    if (!draft.trim() || !sent.trim() || !(await this.enabled(o))) return;
    const ratio = sent.trim().length / draft.trim().length;
    const target = ratio < 0.7 ? 'shorter' : ratio > 1.4 ? 'longer' : null;
    const address = lessonAddress(to);
    if (!target || !address.includes('@')) return;
    const at = now.toISOString();
    for (const l of await this.deps.store.lessons(o)) {
      if (l.kind === 'style' && l.keyType === 'from' && l.keyValue === address) await this.deps.store.deleteLesson(o, l.id);
    }
    await this.deps.store.saveLesson(o, {
      id: lessonId('style', 'from', address, target, 'behavior'), kind: 'style', keyType: 'from', keyValue: address, target, source: 'behavior',
      subject: '', hits: [at], firstAt: at, lastAt: at, usedAt: at,
    });
  }
}

/** 学びの進み具合（今週と先週の、直した回数と振り分けの外れ）。 */
export interface LearningProgress {
  thisWeek: { corrections: number; misses: number };
  lastWeek: { corrections: number; misses: number } | null;
}

/** 学びの進み具合を読む（週次ブリーフに 1 行で伝える。第9.5.1.1.2節「進み具合」）。 */
export async function learningProgressOf(store: Pick<MailStore, 'weeks'>, o: MailOwner, now: Date): Promise<LearningProgress> {
  const weeks = await store.weeks(o, 2);
  const of = (w: string) => weeks.find((x) => x.week === w);
  const t = of(weekOf(now));
  const l = of(weekOf(new Date(now.getTime() - 7 * 86_400_000)));
  return { thisWeek: { corrections: t?.corrections ?? 0, misses: t?.misses ?? 0 }, lastWeek: l ? { corrections: l.corrections, misses: l.misses } : null };
}
