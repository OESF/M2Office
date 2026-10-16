/**
 * @file システムログを見る・ダウンロードする画面と、証拠保全（仕様書 第16.10.4節・第16.10.5節）。
 *
 * ローカルの形の管理者ページ「機械」と、クラウドの形のマスター管理画面で同じ部品を使い、読み書きの口（{@link LogSource}）だけを差し替える。
 * 運営の画面では会社で絞れ、全体の証拠保全ができる。ローカルの形では機械のログのファイルもダウンロードできる。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { EvidenceView, SystemLogDigestView, SystemLogLineView, SystemLogPage, SystemLogQuery } from './api.js';

/** 読み書きの口。 */
export interface LogSource {
  load(q: SystemLogQuery): Promise<SystemLogPage>;
  digests(q: SystemLogQuery): Promise<{ items: SystemLogDigestView[] }>;
  exportLogs(q: SystemLogQuery, format: 'jsonl' | 'csv'): void | Promise<void>;
  /** 運営の画面だけ: 会社の選択肢。 */
  tenants?: { id: string; name: string }[];
  /** ローカルの形だけ: 機械のログのファイル。 */
  files?: { list(): Promise<{ items: { name: string; size: number; updatedAt: string }[]; configured: boolean }>; download(name: string): void | Promise<void> };
  evidence: {
    list(): Promise<{ items: EvidenceView[] }>;
    create(tenantId: string | null, reason: string, days: number): Promise<unknown>;
    download(id: string): void | Promise<void>;
    remove?(id: string, reason: string): Promise<unknown>;
    canCreate: boolean;
  };
  /** 失敗の文にする。 */
  describe(err: unknown, fallback: string): string;
}

const RANGES = [{ label: '直近 1 時間', ms: 3_600_000 }, { label: '直近 24 時間', ms: 86_400_000 }, { label: '直近 7 日', ms: 7 * 86_400_000 }, { label: '直近 28 日', ms: 28 * 86_400_000 }];
const LEVEL_CHOICES = [{ label: 'すべて', levels: [] as string[] }, { label: '警告とエラー', levels: ['warn', 'error'] }, { label: 'エラーだけ', levels: ['error'] }];
const LEVEL_LABEL: Record<string, string> = { error: 'エラー', warn: '警告', info: '情報' };
const STATUS_LABEL: Record<EvidenceView['status'], string> = { pending: '待っています', building: '作っています', ready: '保全しました', failed: '作れませんでした', deleted: '削除しました' };
const KIND_LABEL: Record<EvidenceView['createdKind'], string> = { user: '管理者', operator: '運営', system: '自動（不正の兆しの見張り）' };

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { hour12: false });
const bytes = (n: number | null) => (n === null ? '—' : n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const YEAR_MS = 365 * 86_400_000;

/** システムログと証拠保全。 */
export function SystemLogs({ source }: { source: LogSource }) {
  const [range, setRange] = useState(0);
  const [level, setLevel] = useState(0);
  const [service, setService] = useState('');
  const [q, setQ] = useState('');
  const [tenant, setTenant] = useState('');
  const [page, setPage] = useState<SystemLogPage | null>(null);
  const [rows, setRows] = useState<SystemLogLineView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [digests, setDigests] = useState<SystemLogDigestView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback((): SystemLogQuery => {
    const to = new Date();
    return {
      from: new Date(to.getTime() - RANGES[range]!.ms).toISOString(), to: to.toISOString(),
      levels: LEVEL_CHOICES[level]!.levels, service, q: q.trim(), ...(source.tenants ? { tenant } : {}),
    };
  }, [range, level, service, q, tenant, source.tenants]);

  const show = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const qq = query();
      const r = await source.load(qq);
      setPage(r);
      setRows(r.items);
      setDigests(null);
      // 日ごとの改ざんの確かめ（7 日まで）。失敗しても行は出す
      source.digests(qq).then((d) => setDigests(d.items)).catch(() => setDigests([]));
    } catch (e) {
      setError(source.describe(e, 'システムログを読めませんでした'));
    } finally {
      setBusy(false);
    }
  }, [query, source]);
  useEffect(() => { void show(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const more = async () => {
    if (!page?.next) return;
    setBusy(true);
    try {
      const r = await source.load({ ...query(), from: page.range.from, to: page.range.to, before: page.next.before, beforeId: page.next.beforeId });
      setPage(r);
      setRows((cur) => [...cur, ...r.items]);
    } catch (e) {
      setError(source.describe(e, '続きを読めませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const download = async (format: 'jsonl' | 'csv') => {
    setError(null);
    try { await source.exportLogs(query(), format); } catch (e) { setError(source.describe(e, 'ダウンロードできませんでした')); }
  };
  const tenantName = (id: string | null) => (id ? source.tenants?.find((t) => t.id === id)?.name ?? id : '仕組み');

  return (
    <>
      <div className="card">
        <h3>システムログ</h3>
        <div className="log-toolbar">
          <label className="log-filter">期間
            <select value={range} onChange={(e) => setRange(Number(e.target.value))}>{RANGES.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}</select>
          </label>
          <label className="log-filter">レベル
            <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>{LEVEL_CHOICES.map((l, i) => <option key={l.label} value={i}>{l.label}</option>)}</select>
          </label>
          <label className="log-filter">プロセス
            <select value={service} onChange={(e) => setService(e.target.value)}>
              <option value="">すべて</option><option value="api">API</option><option value="worker">ワーカー</option>{source.tenants && <option value="ops">運営</option>}
            </select>
          </label>
          {source.tenants && (
            <label className="log-filter">会社
              <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
                <option value="">すべて</option><option value="system">仕組み（会社に属さない）</option>
                {source.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <label className="log-filter grow">言葉
            <input value={q} placeholder="例: 失敗" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void show(); }} />
          </label>
          <button className="btn small" disabled={busy} onClick={() => void show()}>表示</button>
          <button className="btn ghost small" onClick={() => void download('jsonl')}>ダウンロード（JSON）</button>
          <button className="btn ghost small" onClick={() => void download('csv')}>ダウンロード（CSV）</button>
        </div>
        {error && <p className="error">{error}</p>}
        {digests && digests.length > 0 && (
          <p className="small">
            改ざんの確かめ: {digests.map((d) => <span key={d.day} className={`badge ${d.intact === false ? 'warn' : 'ok'}`} title={`${d.rows} 行 / ${d.sha256}`}>{d.day.slice(5)} {d.intact === false ? '合いません' : '合っています'}</span>)}
          </p>
        )}
        <div className="table-scroll"><table className="table">
          <thead><tr><th>時刻</th><th>レベル</th><th>プロセス</th>{source.tenants && <th>会社</th>}<th>文</th></tr></thead>
          <tbody>
            {rows.map((l) => (
              <Fragment key={l.id}>
                <tr className="clickable" onClick={() => setOpen(open === l.id ? null : l.id)}>
                  <td className="nowrap">{when(l.at)}</td>
                  <td><span className={`badge ${l.level === 'error' ? 'warn' : l.level === 'warn' ? 'caution' : ''}`}>{LEVEL_LABEL[l.level] ?? l.level}</span></td>
                  <td>{l.service}</td>
                  {source.tenants && <td>{tenantName(l.tenantId)}</td>}
                  <td>{l.msg}</td>
                </tr>
                {open === l.id && (
                  <tr><td colSpan={source.tenants ? 5 : 4}>
                    <pre className="small">{JSON.stringify({ tenantId: l.tenantId, userId: l.userId, requestId: l.requestId, runId: l.runId, ...l.fields }, null, 2)}</pre>
                  </td></tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && !busy && <tr><td colSpan={source.tenants ? 5 : 4} className="muted">この条件のログはありません</td></tr>}
          </tbody>
        </table></div>
        {page?.next && <button className="btn ghost small" disabled={busy} onClick={() => void more()}>続きを読む</button>}
      </div>
      {source.files && <MachineLogFiles files={source.files} describe={source.describe} />}
      <Evidence source={source} />
    </>
  );
}

/** ローカルの形の機械のログのファイル（標準出力のファイル・入れ替えた世代・入口のアクセスログ）。 */
function MachineLogFiles({ files, describe }: { files: NonNullable<LogSource['files']>; describe: LogSource['describe'] }) {
  const [items, setItems] = useState<{ name: string; size: number; updatedAt: string }[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { files.list().then((r) => { setItems(r.items); setConfigured(r.configured); }).catch((e) => setError(describe(e, '読めませんでした'))); }, [files, describe]);
  return (
    <div className="card">
      <h3>機械のログのファイル</h3>
      {error && <p className="error">{error}</p>}
      {!configured && <p className="muted">ログの置き場が設定されていません（M2O_LOG_DIR）</p>}
      {items && items.length > 0 && (
        <div className="table-scroll"><table className="table">
          <thead><tr><th>ファイル</th><th>大きさ</th><th>更新</th><th /></tr></thead>
          <tbody>{items.map((f) => (
            <tr key={f.name}><td>{f.name}</td><td>{bytes(f.size)}</td><td>{when(f.updatedAt)}</td>
              <td><button className="btn ghost small" onClick={() => void Promise.resolve(files.download(f.name)).catch((e) => setError(describe(e, 'ダウンロードできませんでした')))}>ダウンロード</button></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

/** 証拠保全の一覧と、保全する。 */
function Evidence({ source }: { source: LogSource }) {
  const ev = source.evidence;
  const [items, setItems] = useState<EvidenceView[] | null>(null);
  const [form, setForm] = useState(false);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(28);
  const [tenant, setTenant] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { ev.list().then((r) => setItems(r.items)).catch((e) => setError(source.describe(e, '読めませんでした'))); }, [ev, source]);
  useEffect(() => { load(); const t = window.setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const create = async () => {
    setError(null);
    try {
      await ev.create(source.tenants ? tenant || null : null, reason.trim(), days);
      setForm(false);
      setReason('');
      setNote('保全を始めました。できあがると一覧に出ます');
      load();
    } catch (e) {
      setError(source.describe(e, '保全を始められませんでした'));
    }
  };
  const remove = async (p: EvidenceView) => {
    const why = window.prompt('削除する理由を書いてください');
    if (!why?.trim() || !ev.remove) return;
    try { await ev.remove(p.id, why.trim()); load(); } catch (e) { setError(source.describe(e, '削除できませんでした')); }
  };

  return (
    <div className="card">
      <h3>証拠保全</h3>
      {ev.canCreate && !form && <button className="btn small" onClick={() => { setForm(true); setNote(null); }}>証拠保全</button>}
      {form && (
        <div className="log-form">
          {source.tenants && (
            <label className="field">会社
              <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
                <option value="">全体（すべての会社）</option>
                {source.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <label className="field">期間
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={28}>直近 28 日</option><option value={7}>直近 7 日</option><option value={1}>直近 1 日</option></select>
          </label>
          <label className="field">理由（必須）
            <textarea value={reason} maxLength={300} placeholder="例: 見覚えのないログインの知らせが続いたため" onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn small" disabled={!reason.trim()} onClick={() => void create()}>保全する</button>
            <button className="btn ghost small" onClick={() => setForm(false)}>キャンセル</button>
          </div>
        </div>
      )}
      {note && <p className="ok-msg small">{note}</p>}
      {error && <p className="error">{error}</p>}
      {items && items.length > 0 && (
        <div className="table-scroll"><table className="table">
          <thead><tr><th>日時</th>{source.tenants && <th>範囲</th>}<th>期間</th><th>理由</th><th>誰が</th><th>状態</th><th>大きさ</th><th>SHA-256</th><th /></tr></thead>
          <tbody>{items.map((p) => (
            <tr key={p.id}>
              <td className="nowrap">{when(p.createdAt)}</td>
              {source.tenants && <td>{p.scope === 'all' ? '全体' : source.tenants.find((t) => t.id === p.tenantId)?.name ?? p.tenantId}</td>}
              <td className="nowrap">{p.rangeFrom.slice(0, 10)}〜{p.rangeTo.slice(0, 10)}</td>
              <td>{p.reason}</td>
              <td>{KIND_LABEL[p.createdKind]}</td>
              <td><span className={`badge ${p.status === 'ready' ? 'ok' : p.status === 'failed' ? 'warn' : ''}`}>{STATUS_LABEL[p.status]}</span>{p.failure && <span className="small muted"> {p.failure}</span>}</td>
              <td>{bytes(p.size)}</td>
              <td className="small mono" title={p.sha256 ?? ''}>{p.sha256 ? `${p.sha256.slice(0, 12)}…` : '—'}</td>
              <td className="nowrap">
                {p.status === 'ready' && <button className="btn ghost small" onClick={() => void Promise.resolve(ev.download(p.id)).catch((e) => setError(source.describe(e, 'ダウンロードできませんでした')))}>ダウンロード</button>}
                {ev.remove && p.status !== 'deleted' && Date.parse(p.createdAt) < Date.now() - YEAR_MS && <button className="btn danger small" onClick={() => void remove(p)}>削除</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {items && items.length === 0 && <p className="muted small">まだ保全していません</p>}
    </div>
  );
}
