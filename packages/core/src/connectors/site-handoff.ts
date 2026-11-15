/**
 * @file コラムの作成・お知らせの作成が、MCP でつないだサイトに入れるとき、そのサイトの業務に頼む（仕様書 第47.6節・第47.7節、ADR-0148）。
 *
 * コラムとお知らせは、入れるサイトを設定で決める（`webColumns.site`・`announcements.site`）。
 * REST API の WordPress なら、いままでどおり M2Office が書き込む。MCP のサイトなら、承認の後に、
 * そのサイトの業務（サイトの更新の付属の業務「サイトの直し案（サイトの名前）」）に、入れる中身を渡して頼む。
 * そのサイトの業務は相手の道具で下書きを作り、公開まで頼まれたときは、相手の見直しの結果を見せて、もう一度承認を求める（案 A）。
 *
 * @remarks
 * 頼む業務は、元の業務を頼んだ本人として起こし、秘書が起こした業務と同じに扱う（会話の中で承認でき、終わったら秘書が伝える。第47.5節）。
 */

import type { AgentDefinition } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { enqueueJob } from '../engine/enqueue.js';
import { siteConnectionAgentId } from './connection-agent.js';

/** 入れるサイトの設定の値から、MCP の接続の ID を引く（REST API の WordPress なら `null`）。 */
export function mcpSiteOf(site: string | undefined | null): string | null {
  return site && site.startsWith('mcp:') ? site.slice(4) : null;
}

/** MCP のサイトに頼む口。コラムとお知らせの処理に渡す。 */
export type SiteHandOff = (who: { tenantId: string; userId: string }, connectionId: string, request: string) => Promise<{ runId: string; siteName: string } | { error: string }>;

/**
 * MCP のサイトに頼む口を作る。
 *
 * @param agentsOf 会社で使える業務（サイトの業務が含まれるか）
 * @remarks 危険度: write-internal（業務を起こすだけ。サイトに見える変化は、その業務の承認の後）
 */
export function siteHandOff(repo: Repository, agentsOf: (tenantId: string) => Promise<AgentDefinition[]>): SiteHandOff {
  return async (who, connectionId, request) => {
    const def = (await agentsOf(who.tenantId)).find((a) => a.id === siteConnectionAgentId(connectionId));
    if (!def) return { error: 'MCP でつないだサイトの業務を使えません（管理者が「接続 › コネクタ（MCP）」で役割を確かめていないか、サイトの更新を入れていません）' };
    const { runId } = await enqueueJob(repo, {
      tenantId: who.tenantId, requestedBy: who.userId, def, input: { request }, origin: 'secretary', actor: { type: 'user', id: who.userId },
    });
    return { runId, siteName: def.name.replace(/^サイトの直し案（(.*)）$/, '$1') };
  };
}
