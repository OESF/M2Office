/**
 * @file 業務のまとまり（仕様書 第6.7.4.2.1節、ADR-0061）。ダッシュボードの「業務の状態」とヘルプの木（第6.10.7節）が同じものを使う。
 *
 * 拡張機能の業務はその拡張機能、公式の業務は分野（`category`）でまとめる。分野の名前が無い公式の業務は、その業務だけのまとまり。
 * ダッシュボードは、さらに仕事の分野（`agentArea`。第 0.292.0 版、ADR-0075）でまとめる。
 */

import { AGENT_GROUP_LABELS, agentAreaOf, type AgentDefinition } from '@m2office/shared';
import type { TenantExtensions } from '@m2office/core';

/**
 * 業務のまとまりを返す。
 *
 * @returns `ext:<拡張機能の ID>`・`cat:<分野>`・`agent:<業務の ID>` の ID と、まとまりの名前
 */
export function agentGroup(view: TenantExtensions, def: AgentDefinition): { id: string; name: string } {
  const ext = view.entryOf(def.id)?.pkg;
  if (ext) return { id: `ext:${ext.manifest.id}`, name: ext.manifest.name };
  const label = AGENT_GROUP_LABELS[def.category];
  return label ? { id: `cat:${def.category}`, name: label } : { id: `agent:${def.id}`, name: def.name };
}

/**
 * ダッシュボードの「業務の状態」の囲み（第6.7.4.2.1節、ADR-0075）。仕事の分野（メール・予定と会議・問い合わせと会員など）でまとめる。
 * 取り込んだスキルは名前と説明から「調べもの」「資料の作成」に入れ、どれでもなければ {@link agentGroup} のまとまり（その拡張機能）にする。
 *
 * @returns `area:<分野>` か {@link agentGroup} の ID と、名前
 */
export function agentArea(view: TenantExtensions, def: AgentDefinition): { id: string; name: string } {
  return agentAreaOf(def.category, view.entryOf(def.id)?.pkg.manifest.id ?? null, def) ?? agentGroup(view, def);
}
