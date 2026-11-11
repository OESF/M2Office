/**
 * @file 機能ごとの学びを秘書の目に入れる（仕様書 第11.13.9節、ADR-0136。秘書の成長の段 6）。
 *
 * メールの学び（第9.5.1.1.2節）・よくやり取りする相手・メールのカテゴリー（第9.5.1.1.1節）を、それぞれの置き場に置いたまま読み、
 * 本人の像の材料（{@link profileMailMaterial}）と、秘書が答えるときの材料（{@link mailPeopleFor}）にする。覚えていることには写さない。
 *
 * メールの件名・一言・本文は渡さない（相手の名前かアドレス・分け方・通数・カテゴリーの名前だけ）。
 * 本人だけのもの（不変則 I-10）。材料はデータであり、指示として扱わせない（不変則 I-6）。
 */

import type { MailOwner, MailStore, MailThreadRow } from '../mail/store.js';
import { isActive, lessonAddress, type MailLessonRow } from '../mail/learning.js';
import { visibleCategories } from '../mail/categories.js';

/** 決まった値（第11.13.9節）。 */
export const FEATURE_LEARNING = {
  /** 本人の像に渡すメールで覚えた相手の数 */
  profilePeople: 20,
  /** 本人の像に渡すよくやり取りする相手の数 */
  profileFrequent: 10,
  /** よくやり取りする相手を数える日数 */
  frequentDays: 30,
  /** 答えるときに渡す、依頼に出てくる相手の数 */
  matched: 5,
  /** 答えるときにいつも渡す、本人が「大事」と直した相手の数 */
  important: 10,
} as const;

/** 読むのに使うメールの置き場。 */
export type MailLearningSource = Pick<MailStore, 'lessons' | 'categories' | 'threadsSince'>;

/** 分け方の言い方。 */
const TARGET: Record<string, string> = {
  important: '大事な相手', reply: '返事が要る', action: '対応が要る', read: '返事は要らない（目を通すだけ）', promo: '宣伝・お知らせでよい',
};

/** 差出人の表示名（「山田 太郎 <a@b>」→「山田 太郎」。無ければ空）。 */
export function mailDisplayName(from: string): string {
  const first = from.split(',')[0]!;
  const a = first.indexOf('<');
  const name = (a >= 0 ? first.slice(0, a) : '').replace(/"/g, '').trim();
  return name;
}

/** アドレスから表示名を引く表（スレッドの差出人から作る）。 */
function namesOf(threads: MailThreadRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const t of threads) {
    const name = mailDisplayName(t.from);
    const address = lessonAddress(t.from);
    if (name && address && !names.has(address)) names.set(address, name);
  }
  return names;
}

/** 振り分けの学び（相手ごと・ドメインごと）のうち、当てているもの。本人の直しを先に、新しいものから。 */
function peopleLessons(lessons: MailLessonRow[], now: Date): MailLessonRow[] {
  return lessons
    .filter((l) => l.kind === 'group' && (l.keyType === 'from' || l.keyType === 'domain') && TARGET[l.target] && isActive(l, now))
    .sort((a, b) => (a.source === b.source ? b.lastAt.localeCompare(a.lastAt) : a.source === 'told' ? -1 : 1));
}

/** 学び 1 つの言い方（「山田 太郎（yamada@…）からのメールは『大事な相手』（本人の直し）」）。 */
export function mailPersonLine(l: MailLessonRow, names: Map<string, string>): string {
  const name = l.keyType === 'from' ? names.get(l.keyValue) : undefined;
  const who = l.keyType === 'domain' ? `${l.keyValue} の人` : name ? `${name}（${l.keyValue}）` : l.keyValue;
  return `${who}からのメールは「${TARGET[l.target]}」（${l.source === 'told' ? '本人の直し' : 'ふだんの扱いから'}）`;
}

/** 本人の像に渡す、メールの材料。 */
export interface ProfileMailMaterial {
  /** メールで覚えた相手（{@link mailPersonLine} の形） */
  people: string[];
  /** よくやり取りする相手（名前かアドレスと通数） */
  frequent: { name: string; count: number }[];
  /** 並べているカテゴリーの名前 */
  categories: string[];
}

/**
 * 本人の像の材料にする、メールの学び・よくやり取りする相手・カテゴリー（第11.13.9節「本人の像の材料」）。
 *
 * @returns 何も無ければ `null`（本人の像にメールの材料を使った印を付けない）
 */
export async function profileMailMaterial(store: MailLearningSource, o: MailOwner, now: Date): Promise<ProfileMailMaterial | null> {
  const since = new Date(now.getTime() - FEATURE_LEARNING.frequentDays * 86_400_000).toISOString();
  const [lessons, categories, threads] = await Promise.all([store.lessons(o), store.categories(o), store.threadsSince(o, since)]);
  const names = namesOf(threads);
  const people = peopleLessons(lessons, now).slice(0, FEATURE_LEARNING.profilePeople).map((l) => mailPersonLine(l, names));
  // 届いたメールの差出人を数える（返事待ちは本人が送ったものなので、送った相手で数える）
  const counts = new Map<string, number>();
  for (const t of threads) {
    const address = t.group === 'waiting' ? lessonAddress(t.sentTo || t.from) : lessonAddress(t.from);
    if (address) counts.set(address, (counts.get(address) ?? 0) + 1);
  }
  const frequent = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, FEATURE_LEARNING.profileFrequent)
    .map(([address, count]) => ({ name: names.get(address) ? `${names.get(address)}（${address}）` : address, count }));
  const shown = visibleCategories(categories, now).map((c) => c.name);
  if (!people.length && !frequent.length && !shown.length) return null;
  return { people, frequent, categories: shown };
}

/** 本人がメールで直したことのうち、いちばん新しい時刻（本人の像を作り直す理由にする）。無ければ `null`。 */
export async function lastMailCorrection(store: Pick<MailStore, 'lessons'>, o: MailOwner): Promise<string | null> {
  const told = (await store.lessons(o)).filter((l) => l.source === 'told').map((l) => l.lastAt).sort();
  return told.at(-1) ?? null;
}

/** 名前の言葉（2 文字以上）。「山田 太郎」→「山田」「太郎」「山田太郎」。 */
function nameWords(name: string): string[] {
  const parts = name.split(/[\s・　]+/).filter((p) => [...p].length >= 2);
  const joined = parts.join('');
  return [...new Set([...parts, ...(parts.length > 1 ? [joined] : [])])];
}

/**
 * 秘書が答えるときに渡す、メールで覚えている相手（第11.13.9節「答えるときの材料」）。推論は呼ばない。
 *
 * @returns 依頼の文に出てくる相手（名前・アドレス・ドメインが合うもの）を {@link FEATURE_LEARNING.matched} 件まで先に、
 * 本人が「大事」と直した相手を {@link FEATURE_LEARNING.important} 件まで（重なりは除く）
 */
export async function mailPeopleFor(store: MailLearningSource, o: MailOwner, message: string, now: Date): Promise<string[]> {
  const lessons = peopleLessons(await store.lessons(o), now);
  if (!lessons.length) return [];
  const threads = await store.threadsSince(o, new Date(now.getTime() - FEATURE_LEARNING.frequentDays * 86_400_000).toISOString());
  const names = namesOf(threads);
  const text = message.toLowerCase();
  const hit = (l: MailLessonRow) => {
    if (l.keyType === 'domain') return text.includes(l.keyValue);
    const local = l.keyValue.split('@')[0]!;
    const name = names.get(l.keyValue);
    return text.includes(l.keyValue) || (local.length >= 3 && text.includes(local)) || (!!name && nameWords(name).some((w) => message.includes(w)));
  };
  const matched = lessons.filter(hit).slice(0, FEATURE_LEARNING.matched);
  const important = lessons.filter((l) => l.source === 'told' && l.target === 'important' && !matched.includes(l)).slice(0, FEATURE_LEARNING.important);
  return [...matched, ...important].map((l) => mailPersonLine(l, names));
}
