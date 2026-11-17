/**
 * @file 業務が行ったこと・読んだものを、M2Office の記録から書く（仕様書 第49.7節、ADR-0150）。
 *
 * 「入れた」「送った」「読んだ」は、推論の答えの言い分で決めない。道具の呼び出しと、その成否は M2Office の記録に確かにある。
 * 推論は、していないことを「しました」と書くことがある（2026-11-16 に、画像を送れないまま「アイキャッチを設定しました」と書いた）。
 *
 * 業務の段は、道具を呼ぶたびに {@link recordCall} で 1 件を作り、段の出力の `record` に残す。
 * 利用者には、行えなかったことだけを {@link failedNoteText} で業務の言葉で伝える。記録そのものは管理者の画面で見る（{@link adminCallsOf}）。
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
  /** 管理者の画面に出す道具の言い方（接続なら「サービスの名前（相手の道具の名前）」、内蔵なら道具の説明の最初の文）。 */
  label: string;
  /** 接続の名前（利用者に、行えなかった操作をどの接続かで伝える）。内蔵の道具には無い。 */
  service?: string;
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
    ...(tool?.connection ? { service: tool.connection.name } : {}),
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

/**
 * 行えなかったこと（接続の業務の結果の最初に置く。第49.7節・Q-385。第 0.606.2 版）。
 *
 * 利用者の画面には、道具の名前・引数・成否の一覧のような M2Office の内部の記録を出さない（第 0.606.2 版。読んでも分からず、
 * 問い合わせのもとになるため）。記録そのものは段の出力の `record` に残り、管理者の画面の実行の詳細で見られる。
 * ただし、推論が行えなかったことを「しました」と書くことがあるため（2026-11-16 に、画像を送れないまま「アイキャッチを設定しました」と書いた）、
 * **行えなかったことだけ**は、M2Office が記録から、業務の言葉で答えの最初に書く。理由の文（相手の返した技術的な文）は出さない。
 *
 * @returns Markdown。行えなかったことが無ければ空
 */
export function failedNoteText(calls: RecordedCall[], files: RecordedFile[] = []): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    if (!changesState(c.risk) || c.ok) continue;
    const line = c.service ? `- 「${c.service}」での操作を行えませんでした` : '- 操作の一部を行えませんでした';
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  for (const f of files) if (!f.delivered) lines.push(`- 「${f.purpose}」を送れていません`);
  return lines.length ? ['**行えなかったことがあります**', ...lines].join('\n') : '';
}

/**
 * 管理者の画面に出す、段の呼び出しの記録（第6.2.4節・第49.7節。第 0.606.2 版）。
 *
 * 道具の言い方・成否・見える状態を変えたか・行えなかった理由だけを返す。**指したもの（引数）と印は返さない**
 * （頼みや相手のデータの中身が入るため。管理者は実行の中身を見ない。不変則 I-10）。
 */
export function adminCallsOf(output: unknown): { label: string; ok: boolean; changes: boolean; reason?: string }[] {
  return recordsOfSteps([{ output }]).map((c) => ({
    label: c.label, ok: c.ok, changes: changesState(c.risk), ...(c.reason ? { reason: c.reason } : {}),
  }));
}
