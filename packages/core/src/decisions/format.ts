/**
 * @file 意思決定支援の役の発言の形（仕様書 第43.6.2節）。主張ごとに見出しの行（番号・種類・向けた主張・論点・根拠）を書いてから本文を書かせ、
 * 発言の終わりに要旨をまとめて書かせる。書かれるそばから流して見せるため、JSON ではなく行の形にする（第43.11.2節「発言の流し方」）。
 *
 * 形:
 * ```
 * 【A3-1｜反論｜対象 B2-2｜論点 客離れ｜根拠 材料 4・推測】
 * 本文…
 * 【A3-2｜新しい論点｜論点 競合｜根拠 材料 7】
 * 本文…
 * 要旨:
 * A3-1: 1 行の要旨
 * A3-2: 1 行の要旨
 * ```
 *
 * 読み取りは基盤が行い、崩れていたら呼び出し側が 1 回だけ書き直させる。向けた主張の番号が無い主張を指していたら、
 * 対象を外して「新しい論点」として残す（推測でつながりを作らない）。
 */

import { DECISION_CLAIM_KIND_LABELS, DECISION_LIMITS, type DecisionClaimKind } from '@m2office/shared';

/** 読み取った主張の 1 つ（状態などは後で付ける）。 */
export interface ParsedClaim {
  code: string;
  kind: DecisionClaimKind;
  target: string | null;
  issue: string;
  grounds: string[];
  body: string;
  gist: string;
}

/** 読み取りの結果。 */
export interface ParsedSpeech {
  claims: ParsedClaim[];
  /** 形が崩れていたところ（空なら崩れていない） */
  problems: string[];
}

const KIND_BY_LABEL = new Map<string, DecisionClaimKind>(
  (Object.entries(DECISION_CLAIM_KIND_LABELS) as [DecisionClaimKind, string][]).map(([k, label]) => [label, k]),
);

/** 見出しの行（`【…】`）か。 */
const HEADER = /^\s*【([^】\n]{1,300})】\s*$/;
/** 要旨の区切りの行。 */
const GIST_START = /^\s*要旨\s*[:：]\s*$/;
/** 要旨の行（`A3-1: …`）。 */
const GIST_LINE = /^\s*([AB]\d{1,2}-\d)\s*[:：]\s*(.+)$/;
/** 主張の番号。 */
export const CLAIM_CODE = /^(?:\d:)?(?:[AB]\d{1,2}-\d|人\d{1,3})$/;

/** 見出しの欄の区切り（全角・半角の縦線）。 */
const splitFields = (inside: string) => inside.split(/[｜|]/).map((f) => f.trim()).filter(Boolean);

/** 根拠の欄を、1 つずつに分ける（「材料 4・推測」→ ["材料 4", "推測"]）。 */
export function splitGrounds(text: string): string[] {
  return text.split(/[・、,，]/).map((g) => g.trim().replace(/\s+/g, ' ')).filter(Boolean)
    .map((g) => g.replace(/^材料\s*(\d+)$/, '材料 $1')).slice(0, 8);
}

/** 文に出てくる材料の番号（「材料 3」）。 */
export function materialNumbers(grounds: string[]): number[] {
  const out: number[] = [];
  for (const g of grounds) {
    const m = /^材料 (\d+)$/.exec(g);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/**
 * 見出しの行を読む。
 *
 * @returns 読めなければ `null`
 */
export function parseHeader(line: string): Omit<ParsedClaim, 'body' | 'gist'> | null {
  const m = HEADER.exec(line);
  if (!m) return null;
  const fields = splitFields(m[1]!);
  if (fields.length < 2) return null;
  const code = fields[0]!.replace(/\s+/g, '');
  const kind = KIND_BY_LABEL.get(fields[1]!.replace(/\s+/g, ''));
  if (!kind) return null;
  let target: string | null = null;
  let issue = '';
  let grounds: string[] = [];
  for (const f of fields.slice(2)) {
    const t = /^(?:対象|→|↩)\s*(.+)$/.exec(f);
    if (t) { target = t[1]!.replace(/\s+/g, '').replace(/への.*$/, ''); continue; }
    const i = /^(?:論点|観点)\s*[:：]?\s*(.+)$/.exec(f);
    if (i) { issue = i[1]!.trim().slice(0, 40); continue; }
    const g = /^根拠\s*[:：]?\s*(.+)$/.exec(f);
    if (g) { grounds = splitGrounds(g[1]!); continue; }
  }
  return { code, kind, target, issue, grounds };
}

/**
 * 発言の全文から主張を読み取る。
 *
 * @param expectedPrefix この発言の主張の番号の頭（`A3-`）。番号が違えば、頭から順に振り直す
 * @param knownCodes すでにある主張の番号（向けた先が無い主張を指していたら、対象を外して新しい論点にする）
 */
export function parseSpeech(text: string, expectedPrefix: string, knownCodes: ReadonlySet<string>): ParsedSpeech {
  const problems: string[] = [];
  const claims: ParsedClaim[] = [];
  const gists = new Map<string, string>();
  let current: ParsedClaim | null = null;
  let inGists = false;
  const lines = text.split('\n');
  for (const line of lines) {
    if (GIST_START.test(line)) { inGists = true; current = null; continue; }
    if (inGists) {
      const g = GIST_LINE.exec(line);
      if (g) gists.set(g[1]!, g[2]!.trim().slice(0, 120));
      continue;
    }
    const h = parseHeader(line);
    if (h) {
      current = { ...h, body: '', gist: '' };
      claims.push(current);
      continue;
    }
    if (HEADER.test(line)) problems.push(`読めない見出し: ${line.trim().slice(0, 60)}`);
    if (current) current.body += (current.body ? '\n' : '') + line;
    else if (line.trim()) problems.push('見出しの前に本文がある');
  }
  if (claims.length === 0) problems.push('主張の見出しが無い');
  if (claims.length > DECISION_LIMITS.claimsMax) problems.push(`主張が ${DECISION_LIMITS.claimsMax} つを超えている`);
  claims.forEach((c, i) => {
    const expected = `${expectedPrefix}${i + 1}`;
    const originalCode = c.code;
    c.gist = (gists.get(originalCode) ?? gists.get(expected) ?? '').trim();
    if (c.code !== expected) c.code = expected;
    c.body = c.body.trim();
    if (!c.body) problems.push(`${expected} の本文が無い`);
    if (!c.gist) c.gist = firstLine(c.body);
    if (c.kind === 'new') {
      c.target = null;
    } else if (!c.target || !knownCodes.has(c.target)) {
      // 向けた先が無い主張を指していたら、対象を外して新しい論点として残す（推測でつながりを作らない）
      c.target = null;
      c.kind = 'new';
    }
  });
  return { claims: claims.slice(0, DECISION_LIMITS.claimsMax), problems };
}

/** 本文の最初の文（要旨が無いときの代わり）。 */
function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim())?.trim() ?? '';
  const end = line.search(/[。．]/);
  return (end > 0 ? line.slice(0, end + 1) : line).slice(0, 120);
}

/**
 * 判定の役の報告（見出しごとの文）を、見出しで分ける。見出しは `## 見立て` の形。
 *
 * @returns 見出しと本文の並び（見出しの無い前置きは捨てる）
 */
export function splitReport(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string } | null = null;
  for (const line of text.split('\n')) {
    const h = /^\s*#{2,3}\s*(.+?)\s*$/.exec(line);
    if (h) {
      current = { heading: h[1]!.slice(0, 40), body: '' };
      out.push(current);
      continue;
    }
    if (current) current.body += (current.body ? '\n' : '') + line;
  }
  for (const s of out) s.body = s.body.trim();
  return out.filter((s) => s.body);
}

/**
 * 判定の役が返した JSON を読む。前後の文や ```json の囲みがあっても、最初の `{` から最後の `}` までを読む。
 *
 * @returns 読めなければ `null`
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
