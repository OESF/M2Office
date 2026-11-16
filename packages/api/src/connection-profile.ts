/**
 * @file 会社の接続のツールの役割と、接続の説明を作り直す（仕様書 第47.4.1節・第47.7節、ADR-0148）。
 *
 * 接続を登録したとき・鍵を入れたとき・「ツールを取り直す」のときに呼ぶ。
 * 推論がツールの説明から役割（読む・準備・見直し・確定・戻す）を決め、接続の説明（振り分けの候補に出すもの）を作る。
 * **危険度はここでは軽くしない。** 管理者が役割を見て「この役割で使う」としたときだけ、役割から危険度を決める（Q-368）。
 */

import {
  aiAvailable, presetRisk, profileConnectionSummary, profileToolRoles,
  type ConnectionPreset, type ConnectionProfile, type McpToolInfo, type TenantConnection, type ToolHint,
} from '@m2office/core';
import type { RiskLevel } from '@m2office/shared';
import type { AppDeps } from './context.js';

/** 危険度の初期値（読むだけの目印があれば read、型があれば型の決まり、無ければ external-send。第12.11.2節）。 */
function initialRisk(t: McpToolInfo, preset?: ConnectionPreset): RiskLevel {
  return t.readOnly === true ? 'read' : t.readOnly === undefined && preset ? presetRisk(preset, t.name) : 'external-send';
}

/**
 * 問い合わせたツールの一覧から、会社の接続のツールと説明を作る。
 *
 * @param prev いまの接続（取り直しのとき）。決めた危険度と、説明の変わらないツールの役割を残す
 * @remarks
 * 説明が変わったツールは、管理者が役割を見直すまで危険度を初期値に戻す（説明の書き換えで承認を外させない。第47.4.1節）。
 * 推論が使えなければ、名前と目印から役割を決める。危険度: read（推論に説明を渡すだけ）
 */
export async function profiledTools(
  deps: Pick<AppDeps, 'ai'>, tenantId: string, name: string, listed: McpToolInfo[], prev: TenantConnection | null, preset?: ConnectionPreset,
): Promise<{ tools: TenantConnection['tools']; profile: ConnectionProfile }> {
  const keep = prev?.tools ?? [];
  const tools: TenantConnection['tools'] = listed.map((t) => {
    const before = keep.find((k) => k.name === t.name);
    const description = t.description.trim() || `${t.name}（説明がありません）`;
    const same = !!before && before.description === description;
    return {
      name: t.name, description,
      ...(t.args ? { args: t.args } : {}),
      // 相手の引数の定義をそのまま持つ（第48.6節）
      ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
      // 説明の変わらないツールは、決めた危険度と役割を残す。変わったツールで役割を見ていたものは、初期値に戻す
      risk: before && (same || !before.roleReviewed) ? before.risk : initialRisk(t, preset),
      // 管理者が見た役割だけを残す。見ていない役割は、取り直すたびに決め直す（決め方を直したときに古い答えが残らないように）
      ...(same && before.role && before.roleReviewed ? {
        role: before.role, ...(before.roleReviewed ? { roleReviewed: true } : {}),
        ...(before.confirmArg ? { confirmArg: before.confirmArg } : {}), ...(before.warnings ? { warnings: before.warnings } : {}), ...(before.notes ? { notes: before.notes } : {}),
      } : {}),
    };
  });
  const need: ToolHint[] = tools.filter((t) => !t.role).map((t) => {
    const l = listed.find((x) => x.name === t.name)!;
    return {
      name: t.name, description: t.description,
      ...(l.readOnly !== undefined ? { readOnly: l.readOnly } : {}), ...(l.destructive !== undefined ? { destructive: l.destructive } : {}),
      ...(t.args ? { argNames: Object.keys(t.args.properties) } : {}),
    };
  });
  const llm = await deps.ai.llmFor(tenantId).catch(() => null);
  const usable = llm && aiAvailable(llm) ? llm : null;
  if (need.length > 0) {
    const roles = await profileToolRoles(usable, need);
    for (const r of roles) {
      const t = tools.find((x) => x.name === r.name);
      if (!t) continue;
      t.role = r.role;
      if (r.confirmArg) t.confirmArg = r.confirmArg;
      if (r.warnings) t.warnings = r.warnings;
      if (r.notes) t.notes = r.notes;
    }
  }
  const old = prev?.profile;
  const changed = need.length > 0 || tools.length !== keep.length;
  const summary = old?.summaryEdited || (old?.summary && !changed)
    ? { summary: old.summary, site: old.site }
    : await profileConnectionSummary(usable, name, tools.map((t) => ({ name: t.name, role: t.role!, description: t.description })));
  return {
    tools,
    profile: {
      summary: summary.summary, site: summary.site, generatedAt: new Date().toISOString(),
      reviewedAt: old?.reviewedAt ?? null, ...(old?.reviewedBy ? { reviewedBy: old.reviewedBy } : {}), ...(old?.summaryEdited ? { summaryEdited: true } : {}),
    },
  };
}
