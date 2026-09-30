/**
 * @file 管理者ページ「接続 › コネクタ（MCP）」。会社の接続を登録し、道具の危険度と入り切りを決める（仕様書 第6.6.3.0節、ADR-0037）。
 *
 * コネクタは拡張機能の一部ではなく、道具を供給する会社の資源である。秘書・公式の業務・拡張機能のどれからでも使う。
 * 認証の要る接続（Slack など）は、認証情報を登録し、管理者が自分で接続して確かめてから道具を取り直す（仕様書 第12.11.6.2節）。
 */

import { useCallback, useEffect, useState } from 'react';
import { api, describeError, type ConnectionPresetView, type ConnectorCheck, type McpConnectionView } from './api.js';
import { PageTitle } from './help.js';

/** 会社の接続の一覧と追加。 */
export function ConnectorList() {
  const [items, setItems] = useState<McpConnectionView[] | null>(null);
  const [risks, setRisks] = useState<{ value: string; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, ConnectorCheck | 'busy'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [authType, setAuthType] = useState<'none' | 'oauth' | 'api_key'>('none');
  const [presets, setPresets] = useState<ConnectionPresetView[]>([]);
  const load = useCallback(() => {
    api.admin.mcpConnections()
      .then((r) => { setItems(r.items); setRisks(r.risks); setPresets(r.presets ?? []); })
      .catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);

  /** 失敗を画面に出して、一覧を読み直す。 */
  const run = async (key: string, fn: () => Promise<unknown>, failed: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(describeError(e, failed));
    } finally {
      setBusy(null);
    }
  };

  const add = () => run('add', async () => {
    await api.admin.addMcpConnection({ url: url.trim(), auth: authType, ...(name.trim() ? { name: name.trim() } : {}) });
    setUrl('');
    setName('');
  }, '登録できませんでした');

  /** よく使うサービスの型から登録する（第12.11.6.7節）。 */
  const addPreset = (p: ConnectionPresetView) => run(`preset/${p.id}`, () => api.admin.addMcpConnection({ preset: p.id }), '登録できませんでした');

  /** 道具を止めるときは、使えなくなる業務を先に示す（第6.6.3.1節）。 */
  const toggle = (c: McpConnectionView, tool: string, enabled: boolean) => run(`${c.id}/${tool}`, async () => {
    if (!enabled) {
      const impact = await api.admin.mcpToolImpact(c.id, tool);
      const names = impact.agents.map((a) => `・${a.name}`).join('\n');
      const ok = window.confirm(impact.agents.length === 0
        ? `道具「${tool}」を止めます。いま止まる業務はありません。止めてよろしいですか。`
        : `道具「${tool}」を止めます。次の業務が使えなくなります。\n${names}\n`
          + (impact.schedules > 0 ? `\nこれらの定時実行 ${impact.schedules} 件も、次の回から飛ばします。\n` : '')
          + '\n止めてよろしいですか。');
      if (!ok) return;
    }
    await api.admin.setMcpToolEnabled(c.id, tool, enabled);
  }, enabled ? '戻せませんでした' : '止められませんでした');

  /** 消すときは、使えなくなる業務を先に示す（第12.11.0節）。 */
  const remove = (c: McpConnectionView) => run(`${c.id}/delete`, async () => {
    const impact = await api.admin.mcpConnectionImpact(c.id);
    const names = impact.agents.map((a) => `・${a.name}`).join('\n');
    const people = impact.connectedUsers > 0 ? `\n接続している ${impact.connectedUsers} 人の許可も消えます。` : '';
    const ok = window.confirm(impact.agents.length === 0
      ? `接続「${c.name}」を消します。${people}よろしいですか。`
      : `接続「${c.name}」を消します。次の業務が使えなくなります。\n${names}\n${people}\nよろしいですか。`);
    if (!ok) return;
    await api.admin.deleteMcpConnection(c.id);
  }, '削除できませんでした');

  const check = async (c: McpConnectionView) => {
    setChecks((x) => ({ ...x, [c.id]: 'busy' }));
    const res = await api.admin.checkMcpConnection(c.id).catch((e): ConnectorCheck => ({ ok: false, error: describeError(e) }));
    setChecks((x) => ({ ...x, [c.id]: res }));
  };

  return (
    <>
      <PageTitle trail={['接続', 'コネクタ（MCP）']} help={{
        article: 'admin-connectors',
        text: '外部のサービス（MCP サーバ）への接続です。秘書・業務・拡張機能のどれからでも使えます。',
      }} />
      {error && <p className="error">{error}</p>}
      <div className="card">
        {presets.length > 0 && (
          <div className="row small preset-row">
            {presets.filter((p) => !items?.some((c) => c.id === p.id)).map((p) => (
              <button key={p.id} className="btn small ghost" title={p.description} disabled={busy === `preset/${p.id}`}
                onClick={() => void addPreset(p)}>{p.name}を追加</button>
            ))}
          </div>
        )}
        <div className="form-grid">
          <div className="field span-3"><label>接続先の URL</label>
            <input value={url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setUrl(e.target.value)} /></div>
          <div className="field span-2"><label>名前</label>
            <input value={name} placeholder="空なら URL から" onChange={(e) => setName(e.target.value)} /></div>
          <div className="field span-2"><label>認証</label>
            <select value={authType} onChange={(e) => setAuthType(e.target.value as typeof authType)}>
              <option value="none">認証なし</option>
              <option value="oauth">利用者ごとに許可（OAuth）</option>
              <option value="api_key">会社の鍵</option>
            </select></div>
        </div>
        <button className="btn small" disabled={!url.trim() || busy === 'add'} onClick={() => void add()}>
          {busy === 'add' ? '問い合わせています…' : '追加'}
        </button>
      </div>
      {!items && !error && <p className="muted">読み込み中…</p>}
      {items && items.length === 0 && <p className="muted">コネクタはまだありません</p>}
      {items?.map((c) => {
        const st = checks[c.id];
        return (
          <div key={c.id} className="card ext-card">
            <div className="ext-row">
              <div>
                <strong>{c.name}</strong> <span className="muted small">{c.id}</span>
                <div className="muted small">{c.originText}・{c.authState.text}・<code>{c.url}</code></div>
              </div>
            </div>
            {c.description && <p className="small">{c.description}</p>}
            {c.authState.type !== 'none' && <AuthSettings conn={c} onSaved={load} onError={setError} />}
            {c.tools.length === 0 && <p className="muted small">道具はまだありません</p>}
            {c.tools.length > 0 && <table className="table small">
              <thead><tr><th>道具</th><th>危険度</th><th>使う</th></tr></thead>
              <tbody>
                {c.tools.map((t) => {
                  const provided = st && st !== 'busy' && st.ok ? st.tools.find((x) => x.name === t.name)?.provided : undefined;
                  return (
                    <tr key={t.name}>
                      <td title={t.description}>
                        <code>{t.name}</code>
                        {provided === false && <span className="status failed">提供なし</span>}
                        <div className="muted small">{t.description}</div>
                      </td>
                      <td>
                        <select value={t.risk} disabled={busy === `${c.id}/risk`}
                          onChange={(e) => void run(`${c.id}/risk`, () => api.admin.updateMcpConnection(c.id, { tools: [{ name: t.name, risk: e.target.value }] }), '変えられませんでした')}>
                          {risks.map((r) => <option key={r.value} value={r.value}>{r.text}</option>)}
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" checked={t.enabled} disabled={busy === `${c.id}/${t.name}`}
                          aria-label={`${t.name}を使う`} onChange={(e) => void toggle(c, t.name, e.target.checked)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>}
            {c.usedBy.length > 0 && <p className="muted small">使う業務: {c.usedBy.map((a) => a.name).join('、')}</p>}
            <div className="row small">
              <button className="btn small ghost" disabled={st === 'busy'} onClick={() => void check(c)}>
                {st === 'busy' ? '確認しています…' : '接続を確認'}
              </button>
              <button className="btn small ghost" disabled={busy === `${c.id}/refresh`}
                onClick={() => void run(`${c.id}/refresh`, () => api.admin.refreshMcpConnection(c.id), '取り直せませんでした')}>
                道具を取り直す
              </button>
              <button className="btn small ghost danger" disabled={busy === `${c.id}/delete`} onClick={() => void remove(c)}>削除</button>
              {st && st !== 'busy' && (st.ok
                ? <span className="ok-inline">接続できました（提供のある道具 {st.tools.filter((t) => t.provided).length} ／ {st.tools.length}）</span>
                : <span className="error">接続できませんでした: {st.error}</span>)}
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * 認証の要る接続の設定（仕様書 第12.11.6.2節・第12.11.6.6節）。秘密の値は登録したかだけを示し、中身は出さない。
 *
 * @remarks
 * `oauth`: 戻り先の URL と求める権限を示し、クライアント ID とシークレットを登録する。管理者が自分で接続して確かめ、
 * そのあと「道具を取り直す」で道具が並ぶ。クライアント ID を替えると、接続している全員の許可が消える。
 * `api_key`: 会社の鍵を登録すると、その鍵で道具を問い合わせる。
 */
function AuthSettings({ conn, onSaved, onError }: {
  conn: McpConnectionView; onSaved: () => void; onError: (m: string | null) => void;
}) {
  const st = conn.authState;
  const [clientId, setClientId] = useState(st.type === 'oauth' ? st.clientId : '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const save = async () => {
    setBusy(true);
    onError(null);
    setNote(null);
    try {
      if (st.type === 'oauth') {
        if (st.clientId && clientId.trim() !== st.clientId && st.connectedUsers > 0
          && !window.confirm(`クライアント ID を替えると、接続している ${st.connectedUsers} 人の許可が使えなくなります。替えてよろしいですか。`)) return;
        const r = await api.admin.setMcpCredentials(conn.id, { clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) });
        setNote(r.reset ? `登録しました。${r.reset} 人の許可を消しました` : '登録しました');
      } else {
        const r = await api.admin.setMcpCredentials(conn.id, { apiKey: secret.trim() });
        setNote(r.warning ?? `登録しました（道具 ${r.tools ?? 0} 件）`);
      }
      setSecret('');
      onSaved();
    } catch (e) {
      onError(describeError(e, '登録できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  /** 管理者が自分で接続して確かめる（第12.11.6.2節 手順 4）。戻ってきたら「道具を取り直す」。 */
  const connectSelf = async () => {
    try {
      location.href = (await api.connectConnection(conn.id)).url;
    } catch (e) {
      onError(describeError(e, '接続を始められませんでした'));
    }
  };

  if (st.type === 'api_key') {
    return (
      <div className="auth-settings">
        <div className="form-grid">
          <div className="field span-4"><label>会社の鍵（{st.header}）</label>
            <input type="password" autoComplete="off" value={secret} placeholder={st.keySet ? '登録済み（変えるときだけ入れる）' : ''}
              onChange={(e) => setSecret(e.target.value)} /></div>
        </div>
        <div className="row small">
          <button className="btn small" disabled={busy || !secret.trim()} onClick={() => void save()}>登録</button>
          {note && <span className="ok-inline">{note}</span>}
        </div>
      </div>
    );
  }
  if (st.type !== 'oauth') return null;
  return (
    <div className="auth-settings">
      <div className="field"><label>戻り先の URL</label>
        <div className="copy-row small">
          <input readOnly value={st.redirectUri} onFocus={(e) => e.target.select()} />
          <button className="btn small ghost" onClick={() => {
            void navigator.clipboard?.writeText(st.redirectUri).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
          }}>{copied ? '写しました' : '写す'}</button>
        </div>
      </div>
      <details className="small">
        <summary>{st.preset ? `${st.preset.name}の側で行うこと` : '相手のサービスで行うこと'}（権限 {st.scopes.length} 件）</summary>
        {st.preset && <ol>{st.preset.setup.map((s) => <li key={s}>{s}</li>)}</ol>}
        <p><code>{st.scopes.join(' ')}</code></p>
        {st.preset && <p className="muted">出典: {st.preset.source}（{st.preset.checkedAt} 確認）</p>}
      </details>
      <div className="form-grid">
        <div className="field span-3"><label>クライアント ID</label>
          <input value={clientId} autoComplete="off" onChange={(e) => setClientId(e.target.value)} /></div>
        <div className="field span-3"><label>クライアント シークレット</label>
          <input type="password" autoComplete="off" value={secret} placeholder={st.secretSet ? '登録済み（変えるときだけ入れる）' : ''}
            onChange={(e) => setSecret(e.target.value)} /></div>
      </div>
      <div className="row small">
        <button className="btn small" disabled={busy || !clientId.trim() || (!st.secretSet && !secret.trim())} onClick={() => void save()}>登録</button>
        <button className="btn small ghost" disabled={!st.ready} onClick={() => void connectSelf()}>自分で接続して確かめる</button>
        <span className="muted">接続している人 {st.connectedUsers} 人</span>
        {note && <span className="ok-inline">{note}</span>}
      </div>
    </div>
  );
}

