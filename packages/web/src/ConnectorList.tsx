/**
 * @file 管理者ページ「接続 › コネクタ（MCP）」。会社の接続を登録し、道具の危険度と入り切りを決める（仕様書 第6.6.3.0節、ADR-0037）。
 *
 * コネクタは拡張機能の一部ではなく、道具を供給する会社の資源である。秘書・公式の業務・拡張機能のどれからでも使う。
 */

import { useCallback, useEffect, useState } from 'react';
import { api, describeError, type ConnectorCheck, type McpConnectionView } from './api.js';
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
  const load = useCallback(() => {
    api.admin.mcpConnections()
      .then((r) => { setItems(r.items); setRisks(r.risks); })
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
    await api.admin.addMcpConnection({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
    setUrl('');
    setName('');
  }, '登録できませんでした');

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
    const ok = window.confirm(impact.agents.length === 0
      ? `接続「${c.name}」を消します。よろしいですか。`
      : `接続「${c.name}」を消します。次の業務が使えなくなります。\n${names}\n\nよろしいですか。`);
    if (!ok) return;
    await api.admin.deleteMcpConnection(c.id);
  }, '消せませんでした');

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
        <div className="form-grid">
          <div className="field span-3"><label>接続先の URL</label>
            <input value={url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setUrl(e.target.value)} /></div>
          <div className="field span-2"><label>名前</label>
            <input value={name} placeholder="空なら URL から" onChange={(e) => setName(e.target.value)} /></div>
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
                <div className="muted small">{c.originText}・<code>{c.url}</code></div>
              </div>
            </div>
            {c.description && <p className="small">{c.description}</p>}
            <table className="table small">
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
            </table>
            {c.usedBy.length > 0 && <p className="muted small">使う業務: {c.usedBy.map((a) => a.name).join('、')}</p>}
            <div className="row small">
              <button className="btn small ghost" disabled={st === 'busy'} onClick={() => void check(c)}>
                {st === 'busy' ? '確認しています…' : '接続を確認'}
              </button>
              <button className="btn small ghost" disabled={busy === `${c.id}/refresh`}
                onClick={() => void run(`${c.id}/refresh`, () => api.admin.refreshMcpConnection(c.id), '取り直せませんでした')}>
                道具を取り直す
              </button>
              <button className="btn small ghost danger" disabled={busy === `${c.id}/delete`} onClick={() => void remove(c)}>消す</button>
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
