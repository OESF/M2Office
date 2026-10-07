/**
 * @file 音声の秘書の固有名詞の聞き違えを直す（仕様書 第10.5.9節）。
 *
 * 音声の仕組み（Gemini Live）には言葉を登録する口が無い。そこで、本人に関わる固有名詞（社内の人の名前・よく使う名刺の会社と人・
 * 会社の名前・本人が前に直した言葉）を、聞き取りの手がかりとして音声の会話の始めの指示に入れる。聞き取った依頼に、手がかりの読みと
 * 同じかなが入っていれば、その書き方に直して進め、答えに「〇〇のことと受け取りました」と添える（聞き返さない。ADR-0028）。
 * 本人が「〇〇じゃなくて△△」と直したら、その組を本人の設定に「聞き違え」として残し、次から使う。
 */

import type { Repository } from '../repository/types.js';

/** 手がかりの言葉の数の上限（多すぎると音声の応答が遅くなる）。 */
export const VOICE_WORDS_MAX = 200;
/** 覚える聞き違えの数の上限。 */
export const MISHEARS_MAX = 50;

/** 手がかりの言葉（書き方と、分かれば読み）。 */
export interface VoiceWord {
  term: string;
  /** カタカナの読み（分からなければ空）。 */
  reading: string;
}

/** 本人が直した聞き違え。 */
export interface Mishear {
  heard: string;
  meant: string;
}

/** ひらがなをカタカナにし、空白を除く。 */
export function toKatakana(s: string): string {
  return s.normalize('NFKC').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s　・]/g, '');
}

/** 手がかりの言葉を集めるのに要るもの。 */
export interface VoiceWordsDeps {
  repo: Pick<Repository, 'listUsers' | 'getUserSettings' | 'getTenantSettings'>;
  /** 本人が見られる名刺の相手（新しい順）。名刺管理を使っていなければ無し。 */
  contacts?(tenantId: string, userId: string): Promise<{ name: string; nameKana: string; company: string }[]>;
}

/**
 * 本人に関わる固有名詞を集める（社内の人・会社の名前・よく使う名刺の会社と人・本人が直した言葉）。
 *
 * @remarks 姓と名が空白で分かれていれば、姓だけの書き方と読みも足す（「山田さん」と呼ぶことが多いため）
 */
export async function voiceWords(deps: VoiceWordsDeps, tenantId: string, userId: string): Promise<VoiceWord[]> {
  const out = new Map<string, VoiceWord>();
  const add = (term: string, reading = '') => {
    const t = term.trim();
    if (!t || t.length > 40 || out.has(t)) return;
    out.set(t, { term: t, reading: toKatakana(reading) });
  };
  const person = (name: string, kana: string) => {
    add(name, kana);
    const n = name.trim().split(/[\s　]+/);
    const k = kana.trim().split(/[\s　]+/);
    if (n.length >= 2 && k.length === n.length) add(n[0]!, k[0]!);
  };
  const [me, settings, users] = await Promise.all([
    deps.repo.getUserSettings(tenantId, userId), deps.repo.getTenantSettings(tenantId), deps.repo.listUsers(tenantId),
  ]);
  for (const m of me.secretary.mishears ?? []) add(m.meant);
  add(settings.company.shortName ?? '');
  add(settings.company.legalName ?? '');
  for (const u of users.filter((x) => x.status === 'active').slice(0, 100)) {
    const kana = (await deps.repo.getUserSettings(tenantId, u.id).catch(() => null))?.profile.furigana ?? '';
    person(u.displayName, kana);
  }
  for (const c of (await deps.contacts?.(tenantId, userId).catch(() => []) ?? []).slice(0, 60)) {
    person(c.name, c.nameKana);
    add(c.company);
  }
  return [...out.values()].slice(0, VOICE_WORDS_MAX);
}

/** 音声の会話の始めの指示に入れる 1 行（言葉が無ければ空）。 */
export function voiceWordsLine(words: VoiceWord[]): string {
  if (!words.length) return '';
  return `聞き取りの手がかり（社内の人・取引先・会社の言葉）: ${words.map((w) => w.term).join('、')}。これらに似た音が聞こえたら、この書き方として扱い、handle_request にもこの書き方で渡します。`;
}

/**
 * 聞き取った依頼の、手がかりの読みと同じかな・前に直された聞き違えを、正しい書き方に直す。
 *
 * @remarks 読みが 3 字に満たない言葉は直さない（ふつうの言葉と取り違えるため）。すでに正しい書き方があれば直さない
 * @returns 直した文と、直した組
 */
export function correctHeard(text: string, words: VoiceWord[], mishears: Mishear[] = []): { text: string; corrected: { from: string; to: string }[] } {
  let out = text;
  const corrected: { from: string; to: string }[] = [];
  for (const m of mishears) {
    if (m.heard && m.heard !== m.meant && out.includes(m.heard)) {
      out = out.split(m.heard).join(m.meant);
      corrected.push({ from: m.heard, to: m.meant });
    }
  }
  // 長い読みから見る（「ヤマダタロウ」を「ヤマダ」より先に）
  for (const w of [...words].filter((x) => x.reading.length >= 3).sort((a, b) => b.reading.length - a.reading.length)) {
    if (out.includes(w.term)) continue;
    const hira = w.reading.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    for (const form of [w.reading, hira]) {
      if (out.includes(form)) {
        out = out.split(form).join(w.term);
        corrected.push({ from: form, to: w.term });
        break;
      }
    }
  }
  return { text: out, corrected };
}

/** 「〇〇じゃなくて△△」（本人が聞き違えを直した）。 */
const CORRECTION = /^\s*[「『]?(.{1,20}?)[」』]?(?:じゃなくて|ではなくて|でなく)[「『]?(.{1,20}?)[」』]?(?:です|だよ|だ|ね|さん)?[。．.!！]?\s*$/;

/** 聞き違えを直す言い方なら、その組（見分けられなければ `null`）。 */
export function mishearOf(message: string): Mishear | null {
  const m = CORRECTION.exec(message.normalize('NFKC'));
  if (!m) return null;
  const heard = m[1]!.trim();
  const meant = m[2]!.trim();
  return heard && meant && heard !== meant ? { heard, meant } : null;
}

/** 覚えている聞き違えに足す（同じ聞き違えは置き換え、古いものから捨てる）。 */
export function addMishear(list: Mishear[], m: Mishear): Mishear[] {
  return [...list.filter((x) => x.heard !== m.heard), m].slice(-MISHEARS_MAX);
}
