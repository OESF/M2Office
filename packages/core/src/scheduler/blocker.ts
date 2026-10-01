/**
 * @file 定時実行が次の回に動かない理由を決める。起動役（ワーカー）と管理者の「定時実行の一覧」が同じ判定を使う。
 *
 * 判定を 1 か所に置くのは、画面と起動役が食い違うと、動かないものを「動く」と見せてしまうため（仕様書 第6.6.8.2節）。
 *
 * @see 仕様書 第6.5.2.1節 許可がなくなったときの業務の扱い
 * @see 仕様書 第6.6.3.1節 ツールを 1 つずつ止める
 * @see 仕様書 第12.11.6.3節 利用者ごとの接続
 * @see 仕様書 第16.7.4節 利用範囲の適用
 */

import { canUseAgent, type AgentDefinition, type Schedule } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { ExtensionHub } from '../extensions/hub.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import { agentUsesGoogle } from '../retention/revocation.js';

/** 動かない理由を決めるのに要るもの。起動役の依存（`SchedulerDeps`）と同じ名前にそろえる。 */
export interface ScheduleChecks {
  repo: Repository;
  /** エージェント定義を解決する。自社専用の拡張機能はその会社でしか解決できない（仕様書 第12.10.3節）。 */
  resolveDefinition(
    agentId: string, version: number, tenantId: string,
  ): AgentDefinition | undefined | Promise<AgentDefinition | undefined>;
  /** その会社で業務エージェントを使えるか（拡張機能を導入しているか）。 */
  isAvailable?(tenantId: string, agentId: string): Promise<boolean>;
  /**
   * 業務が Google のツールを使うのに、対象者が Google と接続していないか（仕様書 第6.5.2.1節）。
   *
   * @remarks 見本の接続口で動かしている間は、接続が無くても動くため、常に `false` を返す。
   */
  missingGoogleConnection?(tenantId: string, userId: string, def: AgentDefinition): Promise<boolean>;
  /**
   * 管理者が止めたコネクタのツールのうち、その業務が使うもの（仕様書 第6.6.3.1節）。
   *
   * @returns 止まっているツールの名前。無ければ `null`
   */
  disabledToolOf?(tenantId: string, def: AgentDefinition): Promise<string | null>;
  /**
   * 業務が使う、利用者ごとに許可する会社の接続のうち、対象者がまだ接続していないもの（仕様書 第12.11.6.3節）。
   *
   * @returns 接続の名前。無ければ `null`
   */
  missingConnection?(tenantId: string, userId: string, def: AgentDefinition): Promise<string | null>;
}

/** 動かない理由の種類。起動役は種類によって本人への知らせを変える。 */
export type ScheduleBlockKind =
  | 'definition' | 'user' | 'agent-disabled' | 'tool-disabled' | 'not-installed'
  | 'access' | 'compartment' | 'google' | 'connection';

/** 定時実行が次の回に動かない理由。 */
export interface ScheduleBlock {
  kind: ScheduleBlockKind;
  /** 監査ログ（`schedule.skip`）に残す理由。種類ごとに決まった文。 */
  reason: string;
  /** 画面に出す理由。止めたツールや接続の名前を添える。 */
  label: string;
  /** 止めたツールの名前（`tool-disabled` のとき）。 */
  tool?: string;
  /** 接続していないサービスの名前（`connection` のとき）。 */
  connection?: string;
}

/** ツールが止められているために飛ばしたことを表す理由。 */
export const TOOL_DISABLED = '管理者がこの業務の使うツールを止めています';
/** Google と接続していないために飛ばしたことを表す理由。 */
export const GOOGLE_MISSING = '対象者が Google と接続していません';
/** 会社の接続に本人が接続していないために飛ばしたことを表す理由。 */
export const CONNECTION_MISSING = '対象者が業務の使うサービスと接続していません';

/**
 * 定時実行が次の回に動かない理由を返す。動くなら `block` は `null`。
 *
 * @param checks 判定に要るもの（起動役の依存と同じもの）
 * @param s 定時実行（会社・持ち主・業務と版だけを見る。有効かどうかは見ない）
 * @returns 解決した業務の定義（見つからなければ `undefined`）と、動かない理由
 * @remarks 見る順番は起動役がこれまで見てきた順のまま。止めたツールは拡張機能の未導入より先に見る
 */
export async function scheduleBlocker(
  checks: ScheduleChecks, s: Pick<Schedule, 'tenantId' | 'userId' | 'agentId' | 'agentVersion'>,
): Promise<{ def: AgentDefinition | undefined; block: ScheduleBlock | null }> {
  const { repo } = checks;
  const def = await checks.resolveDefinition(s.agentId, s.agentVersion, s.tenantId);
  const fixed = (kind: ScheduleBlockKind, reason: string): ScheduleBlock => ({ kind, reason, label: reason });
  if (!def) return { def, block: fixed('definition', '定義が見つかりません') };

  const user = await repo.findUserById(s.tenantId, s.userId);
  if (!user || user.status !== 'active') return { def, block: fixed('user', '対象者が利用できません') };
  const settings = await repo.getTenantSettings(s.tenantId);
  if (settings.agents.disabled.includes(def.id)) return { def, block: fixed('agent-disabled', '管理者がこの業務を無効にしています') };
  // 管理者が止めたツールを使う業務は動かせない（仕様書 第6.6.3.1節）
  const tool = checks.disabledToolOf ? await checks.disabledToolOf(s.tenantId, def) : null;
  if (tool) return { def, block: { kind: 'tool-disabled', reason: TOOL_DISABLED, label: `管理者がこの業務の使うツール（${tool}）を止めています`, tool } };
  if (checks.isAvailable && !(await checks.isAvailable(s.tenantId, def.id))) {
    return { def, block: fixed('not-installed', 'この業務の拡張機能が導入されていません') };
  }
  // 利用範囲から外れた人の定時実行は起動しない（仕様書 第16.7.4節）
  if (!canUseAgent(settings.access, def.id, s.userId, await repo.listUserGroupIds(s.tenantId, s.userId))) {
    return { def, block: fixed('access', '対象者がこの業務の利用範囲の外です') };
  }
  if (def.compartment && !(await repo.listUserCompartments(s.tenantId, s.userId)).includes(def.compartment)) {
    return { def, block: fixed('compartment', '対象者がこの業務の権限区画に割り当てられていません') };
  }
  // 許可がない間は飛ばす。設定は残し、接続し直せば次から起動する（仕様書 第6.5.2.1節）
  if (checks.missingGoogleConnection && (await checks.missingGoogleConnection(s.tenantId, s.userId, def))) {
    return { def, block: fixed('google', GOOGLE_MISSING) };
  }
  // 会社の接続も同じ。接続するまで飛ばす（第12.11.6.3節）
  const connection = checks.missingConnection ? await checks.missingConnection(s.tenantId, s.userId, def) : null;
  if (connection) {
    return { def, block: { kind: 'connection', reason: CONNECTION_MISSING, label: `対象者が「${connection}」と接続していません`, connection } };
  }
  return { def, block: null };
}

/**
 * 拡張機能と接続口から、判定に要るものを組み立てる。ワーカー（起動役）と API（管理者の一覧）が同じものを使う。
 *
 * @param deps 永続化・拡張機能・接続口
 * @remarks Google は本物の接続口で動かしている会社だけを見る。見本の接続口では接続が無くても動くため
 */
export function scheduleChecks(deps: {
  repo: Repository; hub: ExtensionHub; connector: Pick<WorkspaceConnector, 'sourceFor'>;
}): ScheduleChecks {
  const { repo, hub, connector } = deps;
  return {
    repo,
    resolveDefinition: async (id, version, tenantId) => (await hub.forTenant(tenantId)).resolve(id, version),
    isAvailable: async (tenantId, agentId) => (await hub.forTenant(tenantId)).isAvailable(agentId),
    missingGoogleConnection: async (tenantId, userId, def) => {
      if (connector.sourceFor(tenantId) !== 'google') return false;
      if (!agentUsesGoogle(def, (await hub.forTenant(tenantId)).registry)) return false;
      return !(await repo.getGoogleConnection(tenantId, userId));
    },
    disabledToolOf: async (tenantId, def) => {
      const { disabledTools } = await hub.forTenant(tenantId);
      return def.tools.find((name) => disabledTools.has(name)) ?? null;
    },
    missingConnection: async (tenantId, userId, def) => {
      const { connections } = await hub.forTenant(tenantId);
      for (const x of connections.filter((c) => c.auth.type === 'oauth' && def.tools.some((n) => n.startsWith(`${c.id}.`)))) {
        if (!(await repo.getUserConnection(tenantId, userId, x.id))) return x.name;
      }
      return null;
    },
  };
}
