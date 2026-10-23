/**
 * @file 動いている環境の欄（仕様書 第8.6.7.1節）。ローカルの形は管理者ページの「機械」のいちばん上、クラウドの形は運営の画面の「稼働状況」に置く。
 *
 * M2Office の版・API とワーカーの Node.js（段階とサポートの終わり・セキュリティの修正）・PostgreSQL・OS と CPU・メモリー・動いている形・推論・起動してからの時間。
 * 外へは見に行かない。取れなかった値は「取得できなかった」と出す（推測で埋めない）。M2Medical の同じ欄（Machine.tsx の RuntimeCard）を写した。
 */

import { useCallback, useEffect, useState } from 'react';
import { NODE_STAGE_LABELS, type NodeSecurityNotice, type NodeSupport, type RuntimeEnvironment, type RuntimeProcess } from '@m2office/shared';

const NONE = <span className="muted">取得できなかった</span>;

/** バイトを 2 の累乗で数えて GB で表す（8 GB を 8.0 GB と出す）。 */
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** 「2027-04-30」を「2027 年 4 月 30 日」に。 */
const dayText = (d: string) => { const [y, m, dd] = d.split('-'); return `${y} 年 ${Number(m)} 月 ${Number(dd)} 日`; };

/** 起動してからの時間（「3 日 4 時間」「5 時間 12 分」）。 */
function uptime(from: string, now: number): string {
  const min = Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  return d > 0 ? `${d} 日 ${h} 時間` : h > 0 ? `${h} 時間 ${min % 60} 分` : `${min} 分`;
}

/** Node.js の版と段階・サポートの終わり。 */
function NodeText({ n }: { n: NodeSupport }) {
  const line = n.major !== null ? `${n.major} 系${n.codename ? `〈${n.codename}〉` : ''}` : null;
  return (
    <>
      {n.version}
      <span className="small muted">（{[line, NODE_STAGE_LABELS[n.stage], n.end ? `サポートは ${dayText(n.end)}まで` : null].filter(Boolean).join('・')}）</span>
      {n.expired ? <span className="badge danger">サポートが終わっています</span> : n.warn ? <span className="badge warn">更新が要ります</span> : null}
      {n.insecure && n.secure && <span className="badge danger">セキュリティの修正があります（{n.secure} 以上）</span>}
    </>
  );
}

/** 1 つの処理（API かワーカー）の Node.js。 */
function ProcessNode({ p, other }: { p: RuntimeProcess | null; other?: RuntimeProcess | null }) {
  if (!p) return NONE;
  return (
    <>
      <NodeText n={p.node} />
      {other && other.node.version !== p.node.version && <span className="badge warn">API と違う版</span>}
      {p.stale && <span className="badge warn">知らせが止まっています</span>}
    </>
  );
}

/** セキュリティの修正の知らせの文（どの部分が古いかも出す）。ダッシュボードと同じ文。 */
export function nodeSecurityText(n: NodeSecurityNotice): string {
  const name = { api: 'API', worker: 'ワーカー' } as const;
  const secure = [...new Set(n.map((x) => x.secure))].join('・');
  return `セキュリティの修正があります（${secure} 以上に更新してください）。古い版で動いているもの: ${n.map((x) => `${name[x.role]}（${x.version}）`).join('・')}`;
}

/**
 * 動いている環境の欄。
 *
 * @param load 環境を読む口（管理者ページは `/admin/machine/runtime`、運営は `/ops/runtime`）
 */
export function RuntimeCard({ load }: { load: () => Promise<RuntimeEnvironment> }) {
  const [env, setEnv] = useState<RuntimeEnvironment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => { load().then((e) => { setEnv(e); setError(null); }).catch(() => setError('動いている環境を読み込めませんでした')); }, [load]);
  useEffect(() => { read(); const t = window.setInterval(read, 60_000); return () => clearInterval(t); }, [read]);
  if (error) return <div className="card"><h3>動いている環境</h3><p className="error">{error}</p></div>;
  if (!env) return null;
  const now = Date.now();
  const m = env.machine;
  const versionDiffers = env.api?.version && env.worker?.version && env.api.version !== env.worker.version;
  return (
    <div className="card runtime-card">
      <h3>動いている環境</h3>
      {env.nodeWarn && (
        <p className={env.nodeWarn.expired ? 'error' : 'warn-msg'}>
          {env.nodeWarn.expired
            ? `Node.js（${env.nodeWarn.version}）のサポートが終わっています。すぐに新しい LTS の版へ更新してください`
            : `Node.js の更新が要ります（${env.nodeWarn.version} のサポートは ${env.nodeWarn.end ? dayText(env.nodeWarn.end) : '近く'}まで）`}
        </p>
      )}
      {env.nodeSecurity && <p className="error">{nodeSecurityText(env.nodeSecurity)}</p>}
      <dl className="kv">
        <dt>M2Office の版</dt>
        <dd>{env.api?.version ?? env.worker?.version ?? NONE}{versionDiffers && <span className="badge warn">ワーカーは {env.worker!.version}</span>}</dd>
        <dt>Node.js（API）</dt><dd><ProcessNode p={env.api} /></dd>
        <dt>Node.js（ワーカー）</dt><dd><ProcessNode p={env.worker} other={env.api} /></dd>
        <dt>PostgreSQL</dt><dd>{env.postgres ?? NONE}</dd>
        <dt>OS と CPU</dt>
        <dd>{m && (m.os || m.arch) ? [m.os, m.arch, m.cpu, m.cores ? `${m.cores} コア` : null].filter(Boolean).join('・') : NONE}</dd>
        <dt>メモリー</dt>
        <dd>{m?.memTotal ? <>{gb(m.memTotal)}{m.memFree !== null && <span className="small muted">（使える量 {gb(m.memFree)}）</span>}</> : NONE}</dd>
        <dt>動いている形</dt>
        <dd>{env.deployment === 'onsite' ? 'ローカルの形' : 'クラウドの形'}{env.debug && <span className="badge warn">デバッグモード</span>}</dd>
        <dt>推論</dt><dd>{env.inference ?? NONE}</dd>
        <dt>起動してからの時間</dt>
        <dd>
          API {env.api ? uptime(env.api.startedAt, now) : '取得できなかった'}
          ・ワーカー {env.worker ? uptime(env.worker.startedAt, now) : '取得できなかった'}
        </dd>
      </dl>
    </div>
  );
}
