/**
 * @file マスター管理画面（仕様書 第23.8.15節、ADR-0078）。名前が `ops.` で始まるときだけ出す運営の画面。
 *
 * 会社一覧（CSV）・会社を作る・試用と稼働の切り替え・会社の詳細・サーバー全体の稼働状況・ローカルの形の機械・運営主体の設定・運営者・操作履歴（段 1）。
 * 業務の中身は出さない（件数・金額・状態だけ。第23.8.4節）。権限の判定は運営の API が行い、画面の出し分けは利便のため。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { copyText } from './clipboard.js';
import { NavItem, SideNavLayout, ThemeToggle, type IconName } from './nav.js';
import {
  opsApi, OpsApiError, TENANTS_CSV_URL, type MachineRow, type OperatorProfileView, type OperatorRole, type OperatorView, type OpsAuditRow, type OpsMe,
  type ServerStatusView, type TenantDetailView, type TenantRow,
} from './ops-api.js';

const STATUS_LABEL: Record<TenantRow['status'], string> = { trial: '試用', active: '稼働中', suspended: '停止', locked: '緊急停止', cancelled: '解約済み' };
const ROLE_LABEL: Record<OperatorRole, string> = { admin: '運営管理者', support: 'サポート', monitor: '監視' };
const FLAG_LABEL: Record<string, string> = {
  never: 'まだ届いていない', silent: '3 時間届いていない', 'part-down': '止まっている部分', 'backup-failed': '控えの失敗', 'offsite-failed': '社外の控えの失敗',
  'disk-low': '空きが少ない', 'cert-soon': '証明書の期限が近い', 'update-failed': '更新の失敗',
};
const ACTION_LABEL: Record<string, string> = {
  'ops.login': 'ログイン', 'ops.logout': 'ログアウト', 'tenant.create': '会社を作った', 'tenant.status': '状態を変えた',
  'machine.add': '機械を登録した', 'machine.remove': '機械を削除した', 'operator.add': '運営者を足した', 'operator.update': '運営者を変えた',
  'tenant.view': '会社の詳細を開いた', 'tenants.export': '会社一覧を書き出した', 'settings.operator': '運営主体の設定を変えた',
};

const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const bytes = (b: number | null) => (b === null ? '—' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const yen = (n: number) => `${Math.round(n).toLocaleString()} 円`;
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** 会社に付ける注意の印。 */
function attention(t: TenantRow, now = Date.now()): string[] {
  const out: string[] = [];
  if (t.runs30d >= 5 && t.runsFailed30d / t.runs30d >= 0.2) out.push('失敗が多い');
  if ((t.status === 'trial' || t.status === 'active') && (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) > 30 * 86_400_000)) out.push('30 日使われていない');
  if (t.usersActive > 0 && t.usersInvited === t.usersActive) out.push('まだ誰もログインしていない');
  return out;
}

/** マスター管理画面の入口。ログインの状態を確かめ、ログインか運営の画面を出す。 */
export function OpsRoot() {
  const [me, setMe] = useState<OpsMe | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready'>('loading');
  const load = useCallback(() => {
    opsApi.me().then((m) => { setMe(m); setState('ready'); }).catch(() => { setMe(null); setState('login'); });
  }, []);
  useEffect(() => { document.title = 'M2Office マスター管理'; load(); }, [load]);
  if (state === 'loading') return <p className="muted center">読み込み中…</p>;
  if (state === 'login' || !me) return <OpsLogin onLoggedIn={load} />;
  return <OpsConsole me={me} onLogout={() => { void opsApi.logout().catch(() => undefined).then(() => { setMe(null); setState('login'); }); }} />;
}

/** 運営者のログイン（Google だけ。開発では運営者を選ぶ）。 */
function OpsLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof opsApi.providers>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { opsApi.providers().then(setProviders).catch((e) => setError(errText(e, '読み込めませんでした'))); }, []);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ticket = q.get('ticket');
    const result = q.get('login');
    if (ticket || result) history.replaceState(null, '', location.pathname);
    if (ticket) {
      setBusy(true);
      opsApi.exchange(ticket).then(onLoggedIn).catch(() => setError('ログインできませんでした。もう一度お試しください。')).finally(() => setBusy(false));
      return;
    }
    if (result === 'denied') setError('このアカウントは運営者として登録されていません。');
    if (result === 'failed') setError('ログインできませんでした。もう一度お試しください。');
  }, [onLoggedIn]);
  const google = async () => {
    setBusy(true);
    try { location.href = (await opsApi.googleLoginUrl()).url; } catch (e) { setError(errText(e, 'ログインを始められませんでした')); setBusy(false); }
  };
  const dev = async (email: string) => {
    setBusy(true);
    try { await opsApi.devLogin(email); onLoggedIn(); } catch (e) { setError(errText(e, 'ログインできませんでした')); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <div className="card login-card">
        <h1>M2Office</h1>
        <p className="lead">マスター管理</p>
        <button className="btn google" disabled={!providers?.google.enabled || busy} onClick={() => void google()}>{busy ? '…' : 'Google アカウントでログイン'}</button>
        {providers?.dev.enabled && (
          <div className="dev-login">
            <h3>開発用ログイン</h3>
            {providers.dev.operators.map((o) => (
              <button key={o.email} className="btn ghost wide" disabled={busy} onClick={() => void dev(o.email)}>
                {o.displayName}<span className="sub">{o.email}（{ROLE_LABEL[o.role]}）</span>
              </button>
            ))}
            {providers.dev.operators.length === 0 && <p className="muted small">運営者がいません（npm run ops:operator で作る）</p>}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

type OpsPage = 'tenants' | 'server' | 'machines' | 'operators' | 'audit' | 'settings';
const PAGES: { id: OpsPage; label: string; icon: IconName }[] = [
  { id: 'tenants', label: '会社一覧', icon: 'company' },
  { id: 'server', label: '稼働状況', icon: 'usage' },
  { id: 'machines', label: 'ローカルの形の機械', icon: 'dashboard' },
  { id: 'operators', label: '運営者', icon: 'users' },
  { id: 'audit', label: '操作履歴', icon: 'audit' },
  { id: 'settings', label: '設定', icon: 'settings' },
];

/** 印のある機械の数（左のメニューと会社一覧の要約で知らせる。運営の画面からは社外に送らない）。5 分ごとに読み直す。 */
function useFlaggedMachines(): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    const load = () => { opsApi.machines().then((r) => setN(r.machines.filter((m) => m.flags.length > 0).length)).catch(() => setN(null)); };
    load();
    const t = window.setInterval(load, 300_000);
    return () => clearInterval(t);
  }, []);
  return n;
}

/** 運営の画面の枠。 */
function OpsConsole({ me, onLogout }: { me: OpsMe; onLogout: () => void }) {
  const [page, setPage] = useState<OpsPage>('tenants');
  const flagged = useFlaggedMachines();
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">M2Office マスター管理</span>
        <span className="spacer" />
        <ThemeToggle />
        <span className="badge">{me.operator.displayName}（{ROLE_LABEL[me.operator.role]}）</span>
        <button className="btn ghost small" onClick={onLogout}>ログアウト</button>
      </header>
      <SideNavLayout extraClass="no-talk" nav={<>{PAGES.map((p) => <NavItem key={p.id} icon={p.icon} label={p.label} hint={p.id === 'machines' && flagged ? `印 ${flagged}` : ''} active={page === p.id} onClick={() => setPage(p.id)} />)}</>}>
        <main className="canvas">
          {page === 'tenants' && <Tenants me={me} flagged={flagged} onMachines={() => setPage('machines')} />}
          {page === 'server' && <Server />}
          {page === 'settings' && <Settings me={me} />}
          {page === 'machines' && <Machines me={me} />}
          {page === 'operators' && <Operators me={me} />}
          {page === 'audit' && <Audit />}
        </main>
      </SideNavLayout>
    </div>
  );
}

type SortKey = 'name' | 'subdomain' | 'status' | 'createdAt' | 'lastUsedAt' | 'runs30d' | 'aiCostMonth' | 'filesBytes';

/** 会社一覧（要約・検索・状態の絞り込み・並べ替え）と、会社を作る。 */
function Tenants({ me, flagged, onMachines }: { me: OpsMe; flagged: number | null; onMachines: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | TenantRow['status'] | 'attention'>('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'createdAt', desc: true });
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => { opsApi.tenants().then((r) => setRows(r.tenants)).catch((e) => setError(errText(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    const list = (rows ?? []).filter((t) => (!words || `${t.name} ${t.subdomain} ${t.workspaceDomain ?? ''}`.toLowerCase().includes(words))
      && (!status || (status === 'attention' ? attention(t).length > 0 : t.status === status)));
    const val = (t: TenantRow) => t[sort.key] ?? '';
    return [...list].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (sort.desc ? -1 : 1));
  }, [rows, q, status, sort]);

  const totals = useMemo(() => {
    const all = rows ?? [];
    const by = (s: TenantRow['status']) => all.filter((t) => t.status === s).length;
    const runs30 = all.reduce((n, t) => n + t.runs30d, 0);
    const failed30 = all.reduce((n, t) => n + t.runsFailed30d, 0);
    return {
      count: all.length, active: by('active'), trial: by('trial'), stopped: by('suspended') + by('locked'), cancelled: by('cancelled'),
      runsToday: all.reduce((n, t) => n + t.runsToday, 0), runs30, failRate: runs30 ? Math.round((failed30 / runs30) * 1000) / 10 : 0,
      ai: all.reduce((n, t) => n + t.aiCostMonth, 0), attention: all.filter((t) => attention(t).length > 0).length,
    };
  }, [rows]);

  const head = (key: SortKey, label: string, num = false) => (
    <th className={num ? 'num' : undefined} style={{ cursor: 'pointer' }} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
      {label}{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
    </th>
  );
  const toggle = (t: TenantRow) => {
    const to = t.status === 'trial' ? 'active' : 'trial';
    if (!confirm(`${t.name} を「${STATUS_LABEL[to]}」にしますか？`)) return;
    opsApi.setTenantStatus(t.id, to).then(load).catch((e) => setError(errText(e, '変えられませんでした')));
  };

  if (openId) return <TenantDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;
  return (
    <>
      <h2>会社一覧</h2>
      {error && <p className="error">{error}</p>}
      <div className="stats">
        <div className="stat"><span>会社</span><strong>{totals.count}</strong><span>稼働中 {totals.active} ／ 試用 {totals.trial} ／ 停止 {totals.stopped} ／ 解約 {totals.cancelled}</span></div>
        <div className="stat"><span>業務の実行（今日 ／ 30 日）</span><strong>{totals.runsToday.toLocaleString()} ／ {totals.runs30.toLocaleString()}</strong><span>失敗 {totals.failRate}%</span></div>
        <div className="stat"><span>今月の AI の費用</span><strong>{yen(totals.ai)}</strong><span>概算</span></div>
        <div className="stat"><span>注意</span><strong>{totals.attention}</strong></div>
        {!!flagged && <div className="stat" style={{ cursor: 'pointer' }} onClick={onMachines}><span>印のある機械</span><strong>{flagged}</strong></div>}
      </div>
      <div className="field" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="会社名・サブドメイン・ドメインで探す" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={{ width: 'auto' }}>
          <option value="">すべての状態</option>
          {(Object.keys(STATUS_LABEL) as TenantRow['status'][]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          <option value="attention">注意のある会社</option>
        </select>
        {me.can['tenant.create'] && !creating && <button className="btn small" onClick={() => setCreating(true)}>会社を作る</button>}
        <a className="btn ghost small" href={TENANTS_CSV_URL} download>CSV で書き出す</a>
      </div>
      {creating && <CreateTenant onClose={() => setCreating(false)} onCreated={load} />}
      {rows && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table ops-table">
            <thead>
              <tr>
                {head('name', '会社名')}{head('subdomain', 'サブドメイン')}{head('status', '状態')}
                <th className="num">利用者（利用中 ／ 未ログイン）</th><th className="num">30 日に使った人</th>
                {head('lastUsedAt', '最後に使った')}{head('runs30d', '実行（今日 ／ 30 日）', true)}<th className="num">失敗</th>
                <th className="num">会話（30 日）</th>{head('aiCostMonth', '今月の AI', true)}{head('filesBytes', '保存', true)}
                <th className="num">拡張機能</th><th className="num">Google の接続</th><th>注意</th><th />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td><a className="link" href="#" onClick={(e) => { e.preventDefault(); setOpenId(t.id); }}>{t.name}</a></td>
                  <td><a className="link" href={`${location.protocol}//${location.host.replace(/^ops\./, `${t.subdomain}.`)}/`} target="_blank" rel="noreferrer">{t.subdomain}</a></td>
                  <td><span className={`badge ${t.status === 'active' ? 'ok' : t.status === 'trial' ? '' : 'warn'}`}>{STATUS_LABEL[t.status]}</span></td>
                  <td className="num">{t.usersActive} ／ {t.usersInvited}</td>
                  <td className="num">{t.users30d}</td>
                  <td>{when(t.lastUsedAt)}</td>
                  <td className="num">{t.runsToday} ／ {t.runs30d}</td>
                  <td className="num">{t.runs30d ? `${Math.round((t.runsFailed30d / t.runs30d) * 100)}%` : '—'}</td>
                  <td className="num">{t.conversations30d}</td>
                  <td className="num">{yen(t.aiCostMonth)}</td>
                  <td className="num">{bytes(t.filesBytes)}</td>
                  <td className="num">{t.extensions}</td>
                  <td className="num">{t.googleConnections}</td>
                  <td>{attention(t).map((a) => <span key={a} className="badge warn">{a}</span>)}</td>
                  <td>{me.can['tenant.status'] && (t.status === 'trial' || t.status === 'active') && (
                    <button className="btn ghost small" onClick={() => toggle(t)}>{t.status === 'trial' ? '稼働にする' : '試用に戻す'}</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="muted">当てはまる会社はありません</p>}
        </div>
      )}
    </>
  );
}

/** 会社を作る。作ったら、最初の管理者に渡すログインの URL と案内の文を出す（運営者が自分で渡す。Q-213）。 */
function CreateTenant({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ subdomain: '', name: '', domain: '', admin: '', status: 'trial' as 'trial' | 'active' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ loginUrl: string; welcome: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = () => {
    setBusy(true); setError(null);
    opsApi.createTenant(f).then((r) => { setDone(r); onCreated(); }).catch((e) => setError(errText(e, '作れませんでした'))).finally(() => setBusy(false));
  };
  if (done) {
    return (
      <div className="card">
        <h3>作りました</h3>
        <p><a className="link" href={done.loginUrl} target="_blank" rel="noreferrer">{done.loginUrl}</a></p>
        <div className="field"><label>最初の管理者に渡す案内</label><textarea readOnly value={done.welcome} rows={7} /></div>
        <button className="btn small" onClick={() => void copyText(done.welcome).then(setCopied)}>{copied ? '写しました' : '案内を写す'}</button>{' '}
        <button className="btn ghost small" onClick={onClose}>閉じる</button>
      </div>
    );
  }
  return (
    <div className="card">
      <h3>会社を作る</h3>
      <div className="field"><label>会社名</label><input value={f.name} onChange={set('name')} /></div>
      <div className="field"><label>サブドメイン（英小文字・数字・ハイフン、3 文字以上）</label><input value={f.subdomain} onChange={set('subdomain')} /></div>
      <div className="field"><label>Google Workspace のドメイン</label><input value={f.domain} onChange={set('domain')} placeholder="example.co.jp" /></div>
      <div className="field"><label>最初の管理者のメールアドレス</label><input value={f.admin} onChange={set('admin')} /></div>
      <div className="field"><label>状態</label>
        <select value={f.status} onChange={set('status')}><option value="trial">試用</option><option value="active">稼働中</option></select>
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn small" disabled={busy} onClick={submit}>作る</button>{' '}
      <button className="btn ghost small" onClick={onClose}>キャンセル</button>
    </div>
  );
}

/** ローカルの形の機械（稼働の知らせ。第8.6.8節）。 */
function Machines({ me }: { me: OpsMe }) {
  const [rows, setRows] = useState<MachineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const load = useCallback(() => { opsApi.machines().then((r) => setRows(r.machines)).catch((e) => setError(errText(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const add = () => {
    opsApi.addMachine(name.trim()).then((r) => { setIssued({ id: r.machine.id, token: r.token }); setName(''); load(); }).catch((e) => setError(errText(e, '登録できませんでした')));
  };
  const remove = (m: MachineRow) => {
    if (!confirm(`${m.name} を削除しますか？この機械からの知らせは受け取らなくなります。`)) return;
    opsApi.removeMachine(m.id).then(load).catch((e) => setError(errText(e, '削除できませんでした')));
  };
  const ok = (v: boolean | null | undefined) => (v === null || v === undefined ? '—' : v ? '○' : '×');
  return (
    <>
      <h2>ローカルの形の機械</h2>
      {error && <p className="error">{error}</p>}
      {me.can['machine.manage'] && (
        <div className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input placeholder="呼び名" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
          <button className="btn small" disabled={!name.trim()} onClick={add}>登録する</button>
        </div>
      )}
      {issued && (
        <div className="card">
          <h3>導入のときに setup.sh へ入れる値（鍵はいまだけ出します）</h3>
          <dl className="kv">
            <dt>運営の受け口</dt><dd><code>{`${location.origin}/v1/ops/heartbeat`}</code></dd>
            <dt>鍵</dt><dd><code>{issued.token}</code></dd>
            <dt>機械の番号</dt><dd><code>{issued.id}</code></dd>
          </dl>
          <button className="btn ghost small" onClick={() => setIssued(null)}>閉じる</button>
        </div>
      )}
      {rows && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table ops-table">
            <thead><tr><th>呼び名</th><th>版</th><th>最後の知らせ</th><th>データベース ／ ワーカー ／ 入口 ／ ローカル AI</th><th>控え ／ 戻せるか ／ 社外</th><th className="num">データの空き</th><th className="num">証明書</th><th>印</th><th /></tr></thead>
            <tbody>
              {rows.map((m) => {
                const r = m.report;
                return (
                  <tr key={m.id}>
                    <td>{m.name}<div className="small muted">{m.id}</div></td>
                    <td>{r?.version ?? '—'}</td>
                    <td>{when(m.lastAt)}</td>
                    <td>{r ? `${ok(r.parts.database)} ／ ${ok(r.parts.worker)} ／ ${ok(r.parts.entrance)} ／ ${ok(r.parts.localAi)}` : '—'}</td>
                    <td>{r ? `${r.backup.configured ? ok(r.backup.lastOk) : '—'} ／ ${ok(r.backup.restoreOk)} ／ ${r.backup.offsite?.configured ? ok(r.backup.offsite.lastOk) : '—'}` : '—'}</td>
                    <td className="num">{r && r.disk.dataFree !== null ? `${bytes(r.disk.dataFree)}${r.disk.dataTotal ? `（${Math.round((r.disk.dataFree / r.disk.dataTotal) * 100)}%）` : ''}` : '—'}</td>
                    <td className="num">{r?.cert.daysLeft !== null && r?.cert.daysLeft !== undefined ? `あと ${r.cert.daysLeft} 日` : '—'}</td>
                    <td>{m.flags.map((f) => <span key={f} className="badge warn">{FLAG_LABEL[f] ?? f}</span>)}</td>
                    <td>{me.can['machine.manage'] && <button className="btn ghost small" onClick={() => remove(m)}>削除</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="muted">登録した機械はありません</p>}
        </div>
      )}
    </>
  );
}

/** 運営者（追加・ロールの変更・無効化）。 */
function Operators({ me }: { me: OpsMe }) {
  const [rows, setRows] = useState<OperatorView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ email: '', displayName: '', role: 'support' as OperatorRole });
  const manage = me.can['operator.manage'];
  const load = useCallback(() => { opsApi.operators().then((r) => setRows(r.operators)).catch((e) => setError(errText(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); }, [load]);
  const run = (p: Promise<unknown>, fallback: string) => { setError(null); p.then(load).catch((e) => setError(errText(e, fallback))); };
  return (
    <>
      <h2>運営者</h2>
      {error && <p className="error">{error}</p>}
      {manage && (
        <div className="field" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input placeholder="メールアドレス" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ maxWidth: 260 }} />
          <input placeholder="名前" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} style={{ maxWidth: 180 }} />
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as OperatorRole })} style={{ width: 'auto' }}>
            {(Object.keys(ROLE_LABEL) as OperatorRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <button className="btn small" disabled={!f.email.trim()} onClick={() => { run(opsApi.addOperator(f), '足せませんでした'); setF({ email: '', displayName: '', role: 'support' }); }}>足す</button>
        </div>
      )}
      {rows && (
        <table className="table">
          <thead><tr><th>名前</th><th>メールアドレス</th><th>ロール</th><th>状態</th><th>最後のログイン</th><th /></tr></thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>{o.displayName}</td><td>{o.email}</td>
                <td>{manage && o.id !== me.operator.id
                  ? <select value={o.role} onChange={(e) => run(opsApi.updateOperator(o.id, { role: e.target.value as OperatorRole }), '変えられませんでした')}>
                    {(Object.keys(ROLE_LABEL) as OperatorRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  : ROLE_LABEL[o.role]}</td>
                <td><span className={`badge ${o.status === 'active' ? 'ok' : 'warn'}`}>{o.status === 'active' ? '有効' : '無効'}</span></td>
                <td>{when(o.lastLoginAt)}</td>
                <td>{manage && o.id !== me.operator.id && (
                  <button className="btn ghost small" onClick={() => run(opsApi.updateOperator(o.id, { status: o.status === 'active' ? 'disabled' : 'active' }), '変えられませんでした')}>
                    {o.status === 'active' ? '無効にする' : '有効にする'}
                  </button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** 運営の操作履歴。 */
function Audit() {
  const [rows, setRows] = useState<OpsAuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { opsApi.audit().then((r) => setRows(r.entries)).catch((e) => setError(e instanceof OpsApiError ? e.message : '読み込めませんでした')); }, []);
  return (
    <>
      <h2>操作履歴</h2>
      {error && <p className="error">{error}</p>}
      {rows && (
        <table className="table">
          <thead><tr><th>日時</th><th>運営者</th><th>操作</th><th>対象</th><th>内容</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{when(a.occurredAt)}</td><td>{a.operatorEmail ?? a.operatorId}</td><td>{ACTION_LABEL[a.action] ?? a.action}</td>
                <td>{a.targetId}</td><td className="small muted">{Object.entries(a.detail).map(([k, v]) => `${k}: ${String(v)}`).join('、')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** 会社の詳細（概要・利用状況・稼働・シート・履歴）。業務の中身は出さない。 */
function TenantDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<{ detail: TenantDetailView; opsHistory: OpsAuditRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { opsApi.tenantDetail(id).then(setData).catch((e) => setError(errText(e, '読み込めませんでした'))); }, [id]);
  const d = data?.detail;
  const rate = (f: number, n: number) => (n ? `${Math.round((f / n) * 1000) / 10}%` : '—');
  return (
    <>
      <p><a className="link" href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← 会社一覧</a></p>
      {error && <p className="error">{error}</p>}
      {d && (
        <>
          <h2>{d.tenant.name}</h2>
          <div className="card">
            <h3>概要</h3>
            <dl className="kv">
              <dt>サブドメイン</dt><dd>{d.tenant.subdomain}</dd>
              <dt>Workspace のドメイン</dt><dd>{d.tenant.workspaceDomain ?? '—'}</dd>
              <dt>状態</dt><dd>{STATUS_LABEL[d.tenant.status]}</dd>
              <dt>作った日時</dt><dd>{when(d.tenant.createdAt)}</dd>
              <dt>先方の管理者</dt><dd>{d.seats.filter((s) => s.email).map((s) => `${s.displayName}（${s.email}）`).join('、') || '—'}</dd>
            </dl>
          </div>
          <div className="card">
            <h3>利用状況</h3>
            <table className="table">
              <thead><tr><th>月</th><th className="num">実行</th><th className="num">失敗</th><th className="num">会話</th><th className="num">AI の費用</th><th className="num">1 日に使った人の最多</th></tr></thead>
              <tbody>
                <tr><td>{d.currentMonth.month}（今月）</td><td className="num">{d.currentMonth.runs}</td><td className="num">{rate(d.currentMonth.failed, d.currentMonth.runs)}</td>
                  <td className="num">{d.currentMonth.conversations}</td><td className="num">{yen(Number(d.currentMonth.aiCost))}</td><td className="num">—</td></tr>
                {[...d.months].reverse().map((m) => (
                  <tr key={m.month}><td>{m.month}</td><td className="num">{m.runs}</td><td className="num">{rate(m.failed, m.runs)}</td>
                    <td className="num">{m.conversations}</td><td className="num">{yen(Number(m.aiCost))}</td><td className="num">{m.usersMax}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>稼働</h3>
            <dl className="kv">
              <dt>失敗（30 日）</dt><dd>{d.health.failed30d} 件 ／ {d.health.runs30d} 件（{rate(d.health.failed30d, d.health.runs30d)}）</dd>
              <dt>承認の滞留</dt><dd>{d.health.approvalsPending} 件{d.health.approvalsOldest ? `（最も古い ${when(d.health.approvalsOldest)}）` : ''}</dd>
              <dt>Google の接続</dt><dd>{d.health.googleConnections}</dd>
              <dt>失敗した業務（30 日）</dt><dd>{d.health.failedAgents.map((f) => `${f.agentId} ${f.count} 件`).join('、') || 'ありません'}</dd>
            </dl>
            {d.health.targets.length > 0 && (
              <table className="table">
                <thead><tr><th>接続先（24 時間）</th><th className="num">成功</th><th className="num">失敗</th><th className="num">平均の速さ</th><th>最後の失敗</th></tr></thead>
                <tbody>{d.health.targets.map((t) => (
                  <tr key={t.target}><td>{t.target}</td><td className="num">{t.ok}</td><td className="num">{t.fail}</td><td className="num">{t.avgMs === null ? '—' : `${t.avgMs} ms`}</td><td>{t.lastError ?? '—'}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
          <div className="card">
            <h3>シート（{d.seats.filter((s) => s.status === 'active').length} 人）</h3>
            <table className="table">
              <thead><tr><th>氏名</th><th>ロール</th><th>状態</th><th>最後に使った</th></tr></thead>
              <tbody>{d.seats.map((s, i) => (
                <tr key={i}><td>{s.displayName}</td><td>{s.roles.join('・')}</td><td>{s.status === 'active' ? '利用中' : '停止'}</td><td>{when(s.lastUsedAt)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="card">
            <h3>履歴</h3>
            <table className="table">
              <thead><tr><th>日時</th><th>操作</th><th>内容</th></tr></thead>
              <tbody>
                {[...d.history.map((h) => ({ at: h.occurredAt, what: ACTION_LABEL[h.action] ?? h.action, detail: h.detail })),
                  ...(data?.opsHistory ?? []).filter((a) => a.action !== 'tenant.view').map((a) => ({ at: a.occurredAt, what: `${ACTION_LABEL[a.action] ?? a.action}（${a.operatorEmail ?? a.operatorId}）`, detail: a.detail }))]
                  .sort((a, b) => (a.at < b.at ? 1 : -1))
                  .map((h, i) => <tr key={i}><td>{when(h.at)}</td><td>{h.what}</td><td className="small muted">{Object.entries(h.detail).map(([k, v]) => `${k}: ${String(v)}`).join('、')}</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/** サーバー全体の稼働状況。1 分ごとに読み直す。 */
function Server() {
  const [s, setS] = useState<ServerStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { opsApi.server().then((r) => setS(r.status)).catch((e) => setError(errText(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const rate = (f: number, n: number) => (n ? `${Math.round((f / n) * 1000) / 10}%` : '—');
  const lastWorker = s?.workers[0]?.at ?? null;
  const workerOk = !!lastWorker && Date.now() - Date.parse(lastWorker) < 3 * 60_000;
  const group: Record<string, string> = { ai: 'AI', google: 'Google', mcp: '会社の接続（MCP）' };
  return (
    <>
      <h2>稼働状況</h2>
      {error && <p className="error">{error}</p>}
      {s && (
        <>
          <div className="stats">
            <div className="stat"><span>待ち行列</span><strong>{s.queue.queued}</strong><span>{s.queue.oldestQueuedAt ? `最も古い ${when(s.queue.oldestQueuedAt)}` : '待ちなし'}・動いている {s.queue.running}・承認待ち {s.queue.awaitingApproval}</span></div>
            <div className="stat"><span>実行（1 時間 ／ 今日）</span><strong>{s.runs.hour} ／ {s.runs.today}</strong><span>失敗 {rate(s.runs.hourFailed, s.runs.hour)} ／ {rate(s.runs.todayFailed, s.runs.today)}</span></div>
            <div className="stat"><span>ワーカー</span><strong><span className={`badge ${workerOk ? 'ok' : 'warn'}`}>{workerOk ? '動いています' : '応答がありません'}</span></strong><span>最後の応答 {when(lastWorker)}</span></div>
            <div className="stat"><span>遅れている定時実行</span><strong>{s.schedulesLate}</strong></div>
            <div className="stat"><span>AI の費用（今日 ／ 今月）</span><strong>{yen(Number(s.ai.today))} ／ {yen(Number(s.ai.month))}</strong><span>前の月の同じ時期 {yen(Number(s.ai.lastMonthSamePeriod))}</span></div>
            <div className="stat"><span>データベース</span><strong>{bytes(Number(s.database.bytes))}</strong><span>接続 {s.database.connections}</span></div>
            <div className="stat"><span>ファイルの置き場</span><strong>{bytes(Number(s.filesBytes))}</strong></div>
          </div>
          <table className="table">
            <thead><tr><th>外部の接続（24 時間）</th><th className="num">成功</th><th className="num">失敗</th><th className="num">失敗の割合</th><th className="num">平均の速さ</th></tr></thead>
            <tbody>{s.targets.map((t) => (
              <tr key={t.group}><td>{group[t.group] ?? t.group}</td><td className="num">{t.ok}</td><td className="num">{t.fail}</td><td className="num">{rate(t.fail, t.ok + t.fail)}</td><td className="num">{t.avgMs === null ? '—' : `${t.avgMs} ms`}</td></tr>
            ))}</tbody>
          </table>
          {s.workers.length > 1 && <p className="muted small">ワーカー: {s.workers.map((w) => `${w.id}（${when(w.at)}）`).join('、')}</p>}
        </>
      )}
    </>
  );
}

/** 運営主体の設定（法人名・所在地・Web・問い合わせの窓口）。運営管理者だけが変えられる。 */
function Settings({ me }: { me: OpsMe }) {
  const [p, setP] = useState<OperatorProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const edit = me.can['settings.manage'];
  useEffect(() => { opsApi.operatorProfile().then((r) => setP(r.profile)).catch((e) => setError(errText(e, '読み込めませんでした'))); }, []);
  const save = () => {
    if (!p) return;
    setError(null); setSaved(false);
    opsApi.setOperatorProfile(p).then((r) => { setP(r.profile); setSaved(true); }).catch((e) => setError(errText(e, '保存できませんでした')));
  };
  const field = (k: keyof OperatorProfileView, label: string) => (
    <div className="field"><label>{label}</label><input value={p?.[k] ?? ''} disabled={!edit} onChange={(e) => p && setP({ ...p, [k]: e.target.value })} /></div>
  );
  return (
    <>
      <h2>設定</h2>
      {error && <p className="error">{error}</p>}
      {p && (
        <div className="card">
          <h3>運営主体</h3>
          {field('nameJa', '法人名')}
          {field('nameEn', '法人名（英語）')}
          {field('address', '所在地')}
          {field('web', 'Web')}
          {field('contact', '問い合わせの窓口')}
          {edit && <button className="btn small" onClick={save}>保存する</button>}
          {saved && <p className="ok-msg small">保存しました</p>}
        </div>
      )}
    </>
  );
}
