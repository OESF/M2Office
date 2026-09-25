/**
 * @file 管理者ページ「接続 › コネクタ（MCP）」。導入済みの拡張機能が宣言するコネクタを見渡す確認の画面（仕様書 第6.6.3.0節）。
 *
 * 設定（導入・有効と無効・ツールの入り切り）は「拡張機能」の画面で行う。ここは状態を変えない。
 */

import { useEffect, useState } from 'react';
import { RISK_ORDER, type RiskLevel } from '@m2office/shared';
import { api, describeError, type ConnectorCheck, type ExtensionView } from './api.js';
import { PageTitle } from './help.js';

/** 一覧の 1 行。コネクタと、それを宣言した拡張機能。 */
interface Row {
  extension: ExtensionView;
  connector: ExtensionView['connectors'][number];
}

/**
 * 導入済みのコネクタの一覧。
 *
 * @param onOpenExtension 「拡張機能で設定」を押したとき。拡張機能の画面で、その拡張機能の詳細を開く
 */
export function ConnectorList({ onOpenExtension }: { onOpenExtension: (extensionId: string) => void }) {
  const [items, setItems] = useState<ExtensionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, ConnectorCheck | 'busy'>>({});
  useEffect(() => {
    api.admin.extensions().then((r) => setItems(r.items)).catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);

  const rows: Row[] = (items ?? [])
    .filter((x) => x.installed)
    .flatMap((x) => x.connectors.map((c) => ({ extension: x, connector: c })));

  /** その場で接続を試す。状態は変えない（拡張機能の詳細の確認と同じ口）。 */
  const check = async ({ extension, connector }: Row) => {
    const key = `${extension.id}/${connector.id}`;
    setChecks((c) => ({ ...c, [key]: 'busy' }));
    const res = await api.admin.checkConnector(extension.id, connector.id)
      .catch((e): ConnectorCheck => ({ ok: false, error: describeError(e) }));
    setChecks((c) => ({ ...c, [key]: res }));
  };

  return (
    <>
      <PageTitle trail={['接続', 'コネクタ（MCP）']} help={{
        article: 'admin-connectors',
        text: '導入した拡張機能がつなぐ外部のサービス（コネクタ）の一覧です。追加や入り切りは「拡張機能」の画面で行います。',
      }} />
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">読み込み中…</p>}
      {items && rows.length === 0 && (
        <div className="card">
          <p>コネクタはまだありません</p>
          <button className="btn ghost small" onClick={() => onOpenExtension('')}>拡張機能を開く</button>
        </div>
      )}
      {rows.map((row) => {
        const { extension: x, connector: c } = row;
        const key = `${x.id}/${c.id}`;
        const st = checks[key];
        const enabledTools = c.tools.filter((t) => t.enabled).length;
        const stopped = c.tools.length - enabledTools;
        const top = strongest(c.tools);
        const unusable = x.needsReconsent ? '新しい版の権限への同意を待っています' : !x.enabled ? '拡張機能が無効です' : null;
        return (
          <div key={key} className={unusable ? 'card ext-card off' : 'card ext-card'}>
            <div className="ext-row">
              <div>
                <strong>{c.name}</strong>{' '}
                {unusable
                  ? <span className="status cancelled">使えません</span>
                  : <span className="status succeeded">使えます</span>}
                <div className="muted small">拡張機能「{x.name}」（{x.publisher.name}）</div>
              </div>
            </div>
            {c.description && <p className="small">{c.description}</p>}
            <dl className="kv small">
              <dt>接続先</dt><dd><code>{c.url}</code></dd>
              <dt>認証</dt><dd>{c.authText}</dd>
              <dt>ツール</dt>
              <dd>
                有効 {enabledTools} ／ {c.tools.length}
                {stopped > 0 && <span className="warn-inline">（{stopped} 個を止めています）</span>}
              </dd>
              {top && <><dt>最も強い危険度</dt><dd>{top.riskText}</dd></>}
            </dl>
            {unusable && <p className="warn-msg small">{unusable}。拡張機能の画面で確かめてください。</p>}
            <div className="row small">
              <button className="btn small ghost" disabled={st === 'busy'} onClick={() => void check(row)}>
                {st === 'busy' ? '確認しています…' : '接続を確認'}
              </button>
              <button className="btn small ghost" onClick={() => onOpenExtension(x.id)}>拡張機能で設定</button>
              {st && st !== 'busy' && (st.ok
                ? <span className="ok-inline">接続できました（提供のあるツール {st.tools.filter((t) => t.provided).length} ／ {st.tools.length}）</span>
                : <span className="error">接続できませんでした: {st.error}</span>)}
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * ツールのうち、最も危険度の強いもの。
 *
 * @returns 危険度の分からないツールしか無ければ `null`
 */
function strongest<T extends { risk: string; riskText: string }>(tools: T[]): T | null {
  const rank = (r: string) => RISK_ORDER[r as RiskLevel] ?? -1;
  return tools.reduce<T | null>((top, t) => (rank(t.risk) > (top ? rank(top.risk) : -1) ? t : top), null);
}
