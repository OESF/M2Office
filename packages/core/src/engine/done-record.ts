/**
 * @file 業務が行ったこと・読んだものを、M2Office の記録から書く（仕様書 第49.7節、ADR-0150）。
 *
 * 「入れた」「送った」「読んだ」は、推論の答えの言い分で決めない。道具の呼び出しと、その成否は M2Office の記録に確かにある。
 * 推論は、していないことを「しました」と書くことがある（2026-11-16 に、画像を送れないまま「アイキャッチを設定しました」と書いた）。
 *
 * 業務の段は、道具を呼ぶたびに {@link recordCall} で 1 件を作り、段の出力の `record` に残す。
 * 結果を人に伝えるときは、{@link doneRecordText}（行ったこと）か {@link readsText}（読んだもの）で書く。
 * どちらも、言葉の意味を読まない。道具の危険度と、結果の形（失敗の印・番号・URL）だけを見る（第49.4節「形を読む」）。
 */

import type { RiskLevel } from '@m2office/shared';
import type { Tool } from '../tools/registry.js';

/** 呼び出し 1 件の記録。 */
export interface RecordedCall {
  /** 道具の名前（M2Office の中の名前）。 */
  name: string;
  risk: RiskLevel;
  /** 接続の道具の役割（第47.4.1節）。あれば行ったことの言い方に使う。 */
  role?: 'read' | 'prepare' | 'review' | 'commit' | 'undo';
  /** 人に見せる道具の言い方（接続なら「サービスの名前（相手の道具の名前）」、内蔵なら道具の説明の最初の文）。 */
  label: string;
  /** 指したもの（引数のうち、短い文字と数）。 */
  target: string;
  /** 行えたか。 */
  ok: boolean;
  /** 行えなかった理由。 */
  reason?: string;
  /** 相手が返した印（番号・URL）。 */
  marks?: string[];
}

/** 預けたファイルを送った記録（第48.8.1節）。 */
export interface RecordedFile { purpose: string; delivered: boolean }

/** 見える状態を変える危険度（第49.7節「記録するもの」）。 */
const CHANGES: ReadonlySet<RiskLevel> = new Set<RiskLevel>(['draft', 'write-internal', 'external-send', 'financial']);

/** 見える状態を変える呼び出しか。 */
export const changesState = (risk: RiskLevel): boolean => CHANGES.has(risk);

/** 危険度ごとの「行ったこと」の言い方。 */
const DONE_VERBS: Record<string, string> = {
  draft: '下書きを作りました',
  'write-internal': '書き込みました',
  'external-send': '送りました',
  financial: 'お金に関わる操作をしました',
};

/** 接続の道具の役割ごとの言い方（役割があれば、危険度より先に使う）。 */
const ROLE_VERBS: Record<string, string> = {
  prepare: '準備しました',
  commit: '行いました',
  undo: '元に戻しました',
};

const TARGET_MAX = 60;

/** 人に見せる道具の言い方。 */
function labelOf(tool: Pick<Tool, 'name' | 'helpText' | 'connection'> | undefined, name: string): string {
  if (tool?.connection) return `${tool.connection.name}（${tool.connection.tool}）`;
  const help = tool?.helpText?.split('。')[0]?.trim();
  return help || name;
}

/** 指したもの。引数のうち、短い文字と数だけを「名前: 値」で 3 つまで並べる（本文のような長い文字は出さない）。 */
function targetOf(args: Record<string, unknown>, labels?: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (parts.length >= 3) break;
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (!s || s.length > TARGET_MAX || s.includes('\n')) continue;
    parts.push(`${labels?.[k] ?? k}: ${s}`);
  }
  return parts.join('、');
}

/**
 * 道具の結果の失敗の理由（失敗でなければ `null`）。
 *
 * @remarks
 * 道具は失敗を `{ error }` か `{ available: false, reason }` で返す（例外にしない）。
 * 接続の相手が JSON で `success: false`・`ok: false`・`error` を返したときも失敗とみなす（形を読む）
 */
export function failureOf(recorded: unknown): string | null {
  const x = recorded as { error?: unknown; result?: { available?: unknown; reason?: unknown; error?: unknown; text?: unknown } } | null;
  if (!x) return null;
  if (typeof x.error === 'string') return x.error;
  const r = x.result;
  if (r && typeof r.error === 'string') return r.error;
  if (r && r.available === false) return typeof r.reason === 'string' ? r.reason : '行えませんでした';
  const body = r && typeof r.text === 'string' ? parseJson(r.text) : null;
  if (body && (body['success'] === false || body['ok'] === false)) return typeof body['message'] === 'string' ? body['message'] : '相手が行えなかったと返しました';
  if (body && typeof body['error'] === 'string' && body['error']) return body['error'];
  return null;
}

function parseJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 印として拾う URL の形。 */
// @wordlist 形を読む（第49.4節）
const URL_SHAPE = /https:\/\/[^\s"'<>）)]{1,300}/;

/**
 * 相手が返した印（番号と URL）。
 *
 * @remarks
 * 形だけを見る（第49.4節）。結果の JSON の上の段の、名前が `id` か `_id`・`Id` で終わる項目の値（数か短い文字）と、
 * 最初の https の URL。中の段は見ない（関係の無い番号を拾わないため）
 */
export function marksOf(recorded: unknown): string[] {
  const r = (recorded as { result?: unknown } | null)?.result as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return [];
  const body = typeof r['text'] === 'string' ? parseJson(r['text']) ?? {} : r;
  const marks: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (marks.length >= 2) break;
    if (!/^id$|_id$|[a-z]Id$/.test(k)) continue;
    if (typeof v === 'number' || (typeof v === 'string' && v.length > 0 && v.length <= 40)) marks.push(`${k}: ${v}`);
  }
  const text = typeof r['text'] === 'string' ? r['text'] : JSON.stringify(body);
  const url = URL_SHAPE.exec(text)?.[0];
  if (url) marks.push(url);
  return marks;
}

/**
 * 呼び出し 1 件の記録を作る。
 *
 * @param recorded エンジンが包んだ結果（`{ name, risk, result }` か `{ error }`）
 */
export function recordCall(
  call: { name: string; args: Record<string, unknown> }, recorded: unknown,
  tool: Pick<Tool, 'name' | 'risk' | 'helpText' | 'connection'> | undefined,
): RecordedCall {
  const reason = failureOf(recorded);
  const marks = reason === null && tool && changesState(tool.risk) ? marksOf(recorded) : [];
  return {
    name: call.name, risk: tool?.risk ?? 'read', ...(tool?.connection?.role ? { role: tool.connection.role } : {}), label: labelOf(tool, call.name),
    target: targetOf(call.args, tool?.connection?.labels), ok: reason === null,
    ...(reason !== null ? { reason: reason.slice(0, 200) } : {}),
    ...(marks.length ? { marks } : {}),
  };
}

/** 段の出力から記録を集める（段の出力の `record`）。 */
export function recordsOfSteps(steps: { output: unknown }[]): RecordedCall[] {
  return steps.flatMap((s) => {
    const r = (s.output as { record?: unknown } | null)?.record;
    return Array.isArray(r) ? r as RecordedCall[] : [];
  });
}

/** 読んだもの 1 行（同じ道具と指したものは 1 つにまとめる）。 */
function readLines(calls: RecordedCall[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of calls) {
    if (changesState(c.risk) || !c.ok) continue;
    const line = c.target ? `${c.label}（${c.target}）` : c.label;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/**
 * 行ったこと（接続の業務の結果の最初に置く。第49.7節・Q-385）。
 *
 * @returns Markdown。見える状態を変えた呼び出しと成否・印、預けたファイル、読んだもの。
 * 見える状態を変えた呼び出しが無ければ、そう書く
 */
export function doneRecordText(calls: RecordedCall[], files: RecordedFile[] = []): string {
  const lines: string[] = [];
  for (const c of calls) {
    if (!changesState(c.risk)) continue;
    const what = `${c.label}${c.target ? `（${c.target}）` : ''}`;
    lines.push(c.ok
      ? `- ${(c.role && ROLE_VERBS[c.role]) ?? DONE_VERBS[c.risk] ?? '行いました'}: ${what}${c.marks?.length ? ` — ${c.marks.join('、')}` : ''}`
      : `- 行えませんでした: ${what} — ${c.reason ?? '理由が分かりません'}`);
  }
  for (const f of files) lines.push(f.delivered ? `- 渡したファイルを送りました: ${f.purpose}` : `- 渡したファイルを送れていません: ${f.purpose}`);
  if (!calls.some((c) => changesState(c.risk) && c.ok) && !files.some((f) => f.delivered)) lines.unshift('- 見える状態を変える操作は、行っていません');
  const reads = readLines(calls);
  if (reads.length) lines.push(`- 読んだもの: ${reads.slice(0, 8).join('・')}${reads.length > 8 ? ` ほか ${reads.length - 8} 件` : ''}`);
  return ['**行ったこと**（M2Office の記録）', ...lines].join('\n');
}

/**
 * 読んだもの（調べものの答えの後ろに、出典と同じように添える。第49.7節）。
 *
 * @returns Markdown。読んだものが無ければ空
 */
export function readsText(calls: RecordedCall[]): string {
  const reads = readLines(calls);
  if (reads.length === 0) return '';
  return ['**読んだもの**（M2Office の記録）', ...reads.slice(0, 10).map((l) => `- ${l}`), ...(reads.length > 10 ? [`- ほか ${reads.length - 10} 件`] : [])].join('\n');
}
