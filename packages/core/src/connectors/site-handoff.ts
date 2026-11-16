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
import type { Run } from '@m2office/shared';
import { enqueueJob } from '../engine/enqueue.js';
import { childDidWork } from '../engine/run-engine.js';
import { siteConnectionAgentId } from './connection-agent.js';
import type { HandedFile } from './file-send.js';

/** 入れるサイトの設定の値から、MCP の接続の ID を引く（REST API の WordPress なら `null`）。 */
export function mcpSiteOf(site: string | undefined | null): string | null {
  return site && site.startsWith('mcp:') ? site.slice(4) : null;
}

/**
 * 業務の入力の、人に見せる短い頼みの名前（`request` が長い・本文を含むときに添える）。
 * 秘書の答え（キャンバスの「ご依頼」）は、これがあれば `request` の代わりに出す
 */
export const REQUEST_LABEL = 'requestLabel';

/** MCP のサイトに頼む口。コラムとお知らせの処理に渡す。 */
export type SiteHandOff = (
  who: { tenantId: string; userId: string }, connectionId: string, request: string,
  opts?: {
    /** 頼んだ業務の側の、結果を受け取る相手（親。第48.8節）。子が終わったら、その結果を返す */
    parent?: SiteHandOffParent;
    /**
     * 人に見せる短い頼み（秘書のキャンバスの「ご依頼」に出す）。`request` は相手の道具に渡す全文（本文の HTML を含む）なので、
     * そのまま見せると読めない。無ければ `request` を出す
     */
    label?: string;
    /** 承認を受けたファイル（コラムのカバー画像など）を子に預ける。子の会話の `files_send` で相手に送れる（第48.8.1節） */
    files?: HandedFile[];
  },
) => Promise<{ runId: string; siteName: string } | { error: string }>;

/** 子の結果を受け取る親（コラムかお知らせ）。 */
export interface SiteHandOffParent { kind: 'column' | 'announcement'; id: string }

/** 子の業務の入力から親を読む（無ければ `null`）。 */
export function handOffParentOf(input: Record<string, unknown>): SiteHandOffParent | null {
  const p = input['parent'] as { kind?: unknown; id?: unknown } | undefined;
  return p && (p.kind === 'column' || p.kind === 'announcement') && typeof p.id === 'string' ? { kind: p.kind, id: p.id } : null;
}

/**
 * MCP のサイトに頼む口を作る。
 *
 * @param agentsOf 会社で使える業務（サイトの業務が含まれるか）
 * @remarks 危険度: write-internal（業務を起こすだけ。サイトに見える変化は、その業務の承認の後）
 */
export function siteHandOff(repo: Repository, agentsOf: (tenantId: string) => Promise<AgentDefinition[]>): SiteHandOff {
  return async (who, connectionId, request, opts = {}) => {
    const { parent, label, files } = opts;
    const def = (await agentsOf(who.tenantId)).find((a) => a.id === siteConnectionAgentId(connectionId));
    if (!def) return { error: 'MCP でつないだサイトの業務を使えません（管理者が「接続 › コネクタ（MCP）」で役割を確かめていないか、サイトの更新を入れていません）' };
    const { runId } = await enqueueJob(repo, {
      tenantId: who.tenantId, requestedBy: who.userId, def, input: { request, ...(label ? { [REQUEST_LABEL]: label } : {}), ...(parent ? { parent } : {}), ...(files?.length ? { files } : {}) }, origin: 'secretary', actor: { type: 'user', id: who.userId },
    });
    return { runId, siteName: def.name.replace(/^サイトの直し案（(.*)）$/, '$1') };
  };
}

/** 子の結果を受け取る親の処理（コラムとお知らせ）。 */
export interface SiteHandOffParents {
  columns?: { siteResult(who: { tenantId: string; userId: string }, id: string, runId: string, done: boolean, reason: string | null): Promise<void> };
  announcements?: { siteResult(who: { tenantId: string; userId: string }, id: string, runId: string, done: boolean, reason: string | null): Promise<void> };
}

/**
 * 子の業務が終わったら、その結果を親に返す（仕様書 第48.8節「親と子」）。エンジンの `onFinished` から呼ぶ。
 *
 * @remarks
 * 業務が完了でも、相手の側で道具を 1 つも行っていなければ「入れられなかった」とする（道具を呼ばずに答えて終えたとき）。
 * 親でない業務（入力に `parent` が無い）では何もしない
 */
export async function siteChildFinished(
  repo: Pick<Repository, 'getJob' | 'listRunSteps'>, run: Run, outcome: 'completed' | 'failed' | 'cancelled', reason: string | null, parents: SiteHandOffParents,
): Promise<void> {
  const job = await repo.getJob(run.tenantId, run.jobId);
  const parent = job ? handOffParentOf(job.input) : null;
  if (!job || !parent) return;
  const done = outcome === 'completed' && childDidWork(await repo.listRunSteps(run.tenantId, run.id));
  const why = done ? null : outcome === 'completed' ? 'サイトの側で何も行いませんでした' : (reason ?? 'サイトに入れられませんでした');
  const who = { tenantId: run.tenantId, userId: job.requestedBy };
  if (parent.kind === 'column') await parents.columns?.siteResult(who, parent.id, run.id, done, why);
  else await parents.announcements?.siteResult(who, parent.id, run.id, done, why);
}
