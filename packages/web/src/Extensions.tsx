/**
 * @file 管理者ページ「拡張機能」。ブラウザの拡張機能と同じ感覚で、取り込み・導入・スイッチ・削除を行う。
 *
 * 導入済みの拡張機能はカードで並べ、スイッチで有効と無効を切り替える。
 * 追加は「配布元から追加」（公式の配布元と、取り込み済みのファイル）と「ファイルから追加」（`.m2ext`）の 2 つ。
 * 導入の前に、業務エージェント・コネクタ・ツールごとに、何をするかと危険度を示して同意を得る。
 *
 * @see 仕様書 第12.10.5節 画面（管理者ページ「拡張機能」）
 */

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, describeError, type AccessOptions, type ConnectorCheck, type ExtensionView, type ScopeValue } from './api.js';
import { HelpTip, Markdown } from './help.js';
import { ScopeEditor, ScopeField, useAccessOptions } from './Scope.js';

/** 画面の下に出す知らせ。 */
type Notice = { kind: 'ok' | 'error'; text: string; problems?: string[] } | null;

export function ExtensionSettings() {
  const [items, setItems] = useState<ExtensionView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [consenting, setConsenting] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const access = useAccessOptions();

  const load = () => api.admin.extensions().then((r) => setItems(r.items))
    .catch((e) => setNotice({ kind: 'error', text: describeError(e, '読み込めませんでした') }));
  useEffect(() => { void load(); }, []);

  /** 操作を 1 つ行い、結果を知らせて読み直す。 */
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ kind: 'ok', text: done });
      await Promise.all([load(), access.reload()]);
    } catch (e) {
      setNotice({
        kind: 'error', text: describeError(e, 'うまくいきませんでした'),
        problems: e instanceof ApiError ? e.problems : [],
      });
    } finally {
      setBusy(false);
    }
  };

  /** ファイルを取り込み、通れば同意の画面を開く。 */
  const importFile = (file: File) => act(async () => {
    const res = await api.admin.importExtension(file);
    if (res.item) {
      setAdding(false);
      setConsenting(res.item.installed && !res.item.needsReconsent ? null : res.item.id);
    }
  }, `「${file.name}」を取り込みました。内容を確認して導入してください`);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void importFile(file);
  };

  if (!items) return notice ? <p className="error">{notice.text}</p> : <p className="muted">読み込んでいます…</p>;
  const installed = items.filter((x) => x.installed);
  const available = items.filter((x) => !x.installed);
  const consentItem = items.find((x) => x.id === consenting) ?? null;

  return (
    <div
      className={dragging ? 'ext-page dragging' : 'ext-page'}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="ext-head">
        <h1>
          拡張機能{' '}
          <HelpTip article="admin-extensions">
            業務エージェントや、外部のサービスとのつながり（コネクタ。MCP サーバ）を追加します。スイッチで有効と無効を切り替えられます。
            Gemini と Google Workspace への接続は、左の「接続」で設定します。
          </HelpTip>
        </h1>
        <div className="row">
          <button className="btn ghost" onClick={() => { setAdding(!adding); setConsenting(null); }}>配布元から追加</button>
          <button className="btn" onClick={() => fileInput.current?.click()}>ファイルから追加</button>
          <input
            ref={fileInput} type="file" accept=".m2ext,.zip" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }}
          />
        </div>
      </div>
      <p className="lead">
        有効な拡張機能の業務は、この会社のメニュー・秘書・定時実行に加わります。
        拡張機能のファイル（.m2ext）は、この画面へドラッグしても取り込めます。
      </p>

      {notice && (
        <div className={notice.kind === 'ok' ? 'ok-msg' : 'error'}>
          {notice.text}
          {notice.problems && notice.problems.length > 0 && (
            <ul className="small">{notice.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
        </div>
      )}

      {consentItem && (
        <Consent
          item={consentItem} busy={busy} options={access.options}
          onCancel={() => setConsenting(null)}
          onAgree={(scope) => void act(async () => {
            await api.admin.installExtension(consentItem.id, scope);
            setConsenting(null);
          }, `「${consentItem.name}」を導入しました。左のメニューに業務が加わります`)}
        />
      )}

      {adding && !consentItem && (
        <section className="ext-add">
          <h2>配布元から追加</h2>
          {available.length === 0 && <p className="muted">追加できる拡張機能はありません。</p>}
          <div className="ext-grid">
            {available.map((x) => (
              <div className="card ext-card" key={x.id}>
                <Title item={x} />
                <p className="small">{x.description}</p>
                <button className="btn small" onClick={() => setConsenting(x.id)}>内容を確認して導入する</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <h2>導入済み</h2>
      {installed.length === 0 && (
        <p className="muted">まだありません。「配布元から追加」か「ファイルから追加」で追加してください。</p>
      )}
      {installed.map((x) => (
        <InstalledCard
          key={x.id} item={x} busy={busy} options={access.options} onChanged={() => void Promise.all([load(), access.reload()])}
          onToggle={(on) => void act(
            () => api.admin.setExtensionEnabled(x.id, on),
            on ? `「${x.name}」を有効にしました` : `「${x.name}」を無効にしました。業務はメニューから消えます`,
          )}
          onReconsent={() => setConsenting(x.id)}
          onDelete={() => {
            const extra = x.origin === 'private' ? '取り込んだファイルも消えます。' : '';
            if (confirm(`「${x.name}」を削除しますか。業務は使えなくなります（実行の記録は残ります）。${extra}`)) {
              void act(() => api.admin.uninstallExtension(x.id), `「${x.name}」を削除しました`);
            }
          }}
        />
      ))}
    </div>
  );
}

/** アイコン・名前・版・区分・提供者・構成要素の数。 */
function Title({ item: x }: { item: ExtensionView }) {
  const parts = [
    x.counts.agents > 0 && `業務エージェント ${x.counts.agents}`,
    x.counts.connectors > 0 && `コネクタ ${x.counts.connectors}`,
    x.counts.tools > 0 && `ツール ${x.counts.tools}`,
  ].filter(Boolean);
  return (
    <div className="ext-title">
      {x.icon ? <img src={x.icon} alt="" className="ext-icon" /> : <div className="ext-icon blank">{x.name.slice(0, 1)}</div>}
      <div>
        <div>
          <strong>{x.name}</strong> <span className="muted small">{x.version}</span>{' '}
          <span className={x.origin === 'official' ? 'badge' : 'badge warn'}>{x.originText}</span>
        </div>
        <div className="muted small">提供: {x.publisher.name}{parts.length > 0 && `・${parts.join('・')}`}</div>
      </div>
    </div>
  );
}

/** 導入済みの拡張機能のカード。スイッチ・詳細・削除。 */
function InstalledCard({ item: x, busy, options, onChanged, onToggle, onReconsent, onDelete }: {
  item: ExtensionView; busy: boolean; options: AccessOptions | null;
  /** 利用範囲の保存と、ツールの入り切りのあとに呼ぶ。一覧を読み直す */
  onChanged: () => void;
  onToggle: (on: boolean) => void; onReconsent: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const on = x.enabled && !x.needsReconsent;
  return (
    <div className={on ? 'card ext-card' : 'card ext-card off'}>
      <div className="ext-row">
        <Title item={x} />
        <label className="switch-label">
          <span className="small">{on ? '有効' : '無効'}</span>
          <button
            type="button" role="switch" aria-checked={on} aria-label={`${x.name}を${on ? '無効' : '有効'}にする`}
            className={on ? 'switch on' : 'switch'} disabled={busy || x.needsReconsent}
            onClick={() => onToggle(!on)}
          ><span /></button>
        </label>
      </div>
      {x.needsReconsent && (
        <p className="warn-msg small">
          新しい版で必要な権限が増えています。内容を確認して同意するまで使えません。{' '}
          <button className="btn small" onClick={onReconsent}>内容を確認して同意する</button>
        </p>
      )}
      {options && (
        <div className="small">利用できる人: <ScopeField target={x.id} options={options} onSaved={onChanged} /></div>
      )}
      <div className="row small">
        <button className="link" onClick={() => setOpen(!open)}>{open ? '詳細を閉じる' : '詳細'}</button>
        <button className="link danger" disabled={busy} onClick={onDelete}>削除</button>
      </div>
      {open && <Details item={x} onChanged={onChanged} />}
    </div>
  );
}

/**
 * 詳細。業務エージェント、コネクタ（接続の確認）、ツールの危険度と入り切り、説明。
 *
 * @param onChanged ツールの入り切りを変えたら呼ぶ。一覧を読み直す
 */
function Details({ item: x, onChanged }: { item: ExtensionView; onChanged: () => void }) {
  const [checks, setChecks] = useState<Record<string, ConnectorCheck | 'busy'>>({});
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: 'busy' }));
    const res = await api.admin.checkConnector(x.id, id)
      .catch((e): ConnectorCheck => ({ ok: false, error: describeError(e) }));
    setChecks((c) => ({ ...c, [id]: res }));
  };

  /** ツールを 1 つ入り切りする。止めるときは、使えなくなる業務を先に示す（第6.6.3.1節）。 */
  async function toggleTool(connectorId: string, toolName: string, enabled: boolean) {
    setBusyTool(toolName);
    setError(null);
    try {
      if (!enabled) {
        const impact = await api.admin.connectorToolImpact(x.id, connectorId, toolName);
        const names = impact.agents.map((a) => `・${a.name}`).join('\n');
        const ok = window.confirm(
          impact.agents.length === 0
            ? `ツール「${toolName}」を止めます。\n\nいま止まる業務はありません。\n\n止めてよろしいですか。`
            : `ツール「${toolName}」を止めます。\n\n次の業務が使えなくなります。\n${names}\n`
              + (impact.schedules > 0 ? `\nこれらの定時実行 ${impact.schedules} 件も、次の回から飛ばします。\n` : '')
              + '\n動いている業務は最後まで進みます。いつでも戻せます。\n\n止めてよろしいですか。',
        );
        if (!ok) return;
      }
      await api.admin.setConnectorToolEnabled(x.id, connectorId, toolName, enabled);
      onChanged();
    } catch (err) {
      setError(describeError(err, enabled ? '戻せませんでした' : '止められませんでした'));
    } finally {
      setBusyTool(null);
    }
  }
  return (
    <div className="ext-details">
      {x.agents.length > 0 && (
        <>
          <h4>業務エージェント</h4>
          <ul className="small">{x.agents.map((a) => <li key={a.id}><strong>{a.name}</strong>: {a.summary}</li>)}</ul>
        </>
      )}
      {x.connectors.map((c) => {
        const st = checks[c.id];
        return (
          <div key={c.id}>
            <h4>コネクタ: {c.name}</h4>
            <p className="small">接続先 <code>{c.url}</code>・{c.authText}</p>
            <ul className="small">
              {c.tools.map((t) => {
                const provided = st && st !== 'busy' && st.ok ? st.tools.find((x) => `${c.id}.${x.name}` === t.name)?.provided : undefined;
                // ツールの名前は `<コネクタの ID>.<ツールの名前>`。API には後ろだけを渡す
                const bare = t.name.slice(t.name.indexOf('.') + 1);
                return (
                  <li key={t.name}>
                    {t.description}（<code>{t.name}</code>・{t.riskText}）
                    {provided === true && <span className="status succeeded">提供あり</span>}
                    {provided === false && <span className="status failed">提供なし</span>}
                    {!t.enabled && <span className="status cancelled">止めています</span>}{' '}
                    <button className="link" disabled={busyTool === bare}
                      onClick={() => void toggleTool(c.id, bare, !t.enabled)}>
                      {busyTool === bare ? '…' : t.enabled ? '止める' : '戻す'}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button className="btn small ghost" disabled={st === 'busy'} onClick={() => void check(c.id)}>
              {st === 'busy' ? '確認しています…' : '接続を確認する'}
            </button>{' '}
            {st && st !== 'busy' && (st.ok
              ? <span className="small ok-inline">接続できました</span>
              : <span className="small error-inline">接続できませんでした: {st.error}</span>)}
          </div>
        );
      })}
      {error && <p className="error">{error}</p>}
      {x.readme && (
        <>
          <h4>説明</h4>
          <div className="ext-readme"><Markdown text={x.readme} /></div>
        </>
      )}
    </div>
  );
}

/** 導入の同意。構成要素ごとに、何をするかと危険度を平易な言葉で並べる（第12.10.5節）。 */
function Consent({ item: x, busy, options, onAgree, onCancel }: {
  item: ExtensionView; busy: boolean; options: AccessOptions | null;
  onAgree: (scope: ScopeValue) => void; onCancel: () => void;
}) {
  const [scope, setScope] = useState<ScopeValue>(x.scope ?? 'all');
  const empty = scope !== 'all' && scope.groups.length === 0 && scope.users.length === 0;
  return (
    <div className="card consent">
      <Title item={x} />
      <p className="small">{x.description}</p>
      <h4>この拡張機能に許可すること</h4>
      {x.agents.length > 0 && (
        <>
          <p className="small"><strong>業務エージェント</strong>（メニュー・秘書・定時実行に加わります）</p>
          <ul className="small">{x.agents.map((a) => <li key={a.id}><strong>{a.name}</strong>: {a.summary}</li>)}</ul>
        </>
      )}
      {x.connectors.length > 0 && (
        <>
          <p className="small"><strong>外部のサービスへの接続</strong>（入力の一部がこの接続先へ送られます）</p>
          <ul className="small">
            {x.connectors.map((c) => <li key={c.id}>{c.name}: <code>{c.url}</code>・{c.authText}</li>)}
          </ul>
        </>
      )}
      <p className="small"><strong>使う操作</strong></p>
      <ul className="small">{x.permissions.tools.map((t) => <li key={t.name}>{t.does}</li>)}</ul>
      <p className="small">扱う最大の危険度: <strong>{x.permissions.maxRiskText}</strong></p>
      {options && (
        <>
          <h4>利用できる人</h4>
          <ScopeEditor value={scope} onChange={setScope} options={options} />
        </>
      )}
      <div className="row">
        <button className="btn" disabled={busy || empty} onClick={() => onAgree(scope)}>同意して導入する</button>
        <button className="btn ghost" onClick={onCancel}>やめる</button>
      </div>
    </div>
  );
}
