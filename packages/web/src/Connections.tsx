/**
 * @file 管理者ページ「接続」。Gemini（自社の鍵・モデル・接続の確認）と Google Workspace（会社の OAuth クライアントの登録、
 * 利用者ごとの接続状況、業務が求める権限）。会社の外のサービス（WordPress・LINE・窓口のメール）は `ServiceConnections.tsx`。
 *
 * AI Radio の「システム接続設定」の作り（伏せ字の入力欄、実際に許可された範囲の表示、サインインのボタン）を引き継ぐ。
 * 秘密の値は画面に出さない。登録済みかどうかと日時だけを示し、上書きと削除だけができる。
 *
 * @see 仕様書 第14.3.3節 接続の設定
 * @see 仕様書 第14.3.2節 Google から取得したデータの保持
 * @see ADR-0007 接続の設定
 */

import { copyText } from './clipboard.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, describeError, type ConnectionHealth, type ConnectionSettings, type GoogleClientVerdict, type GoogleLoginAuditStatus } from './api.js';
import { GOOGLE_APIS, googleEnableApiUrl } from '@m2office/shared';
import { HealthList } from './health.js';
import { adminPath } from './route.js';
import { PageTitle, type PageHelp } from './help.js';
import { SaveButton } from './save.js';
import { isServiceConnectionPage, ServiceConnection } from './ServiceConnections.js';

const MODEL_LABELS: [string, string][] = [
  ['fast', '高速（秘書の取り次ぎなど）'], ['standard', '標準（業務の推論）'], ['advanced', '高性能'],
  ['research', 'Web の調査'], ['live', '音声（Gemini Live）'],
];

const LEVEL: Record<string, { text: string; cls: string }> = {
  restricted: { text: '制限付き', cls: 'badge warn' },
  sensitive: { text: '機密', cls: 'badge' },
  'non-sensitive': { text: '機密でない', cls: 'badge muted-badge' },
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '');

/** OAuth クライアントを消す・替えるときの確認の文（仕様書 第6.5.2.1節）。 */
function clientChangeText(impact: { users: number; runs: number } | null, what: string): string {
  const lines = [`${what}。よろしいですか。`];
  if (impact === null) lines.push('', '影響する人数を確かめられませんでした。');
  else if (impact.users > 0) {
    lines.push('', `接続している ${impact.users} 人の許可が使えなくなります。`);
    if (impact.runs > 0) lines.push(`動いている業務 ${impact.runs} 件が止まります。`);
    lines.push('業務が読んだメールや文書の中身も消します。従業員は、新しい設定で接続し直す必要があります。');
  }
  lines.push('', 'クライアント シークレットだけを替える場合は、従業員の接続に影響しません。');
  return lines.join('\n');
}

/**
 * 管理者ページ「接続」（仕様書 第6.6.2節）。
 *
 * @remarks **1 画面 1 保存**（第6.6.0節）。小分けを `page` で受け取り、1 つだけを出す。
 */
export function Connections({ page }: { page: string }) {
  const [data, setData] = useState<ConnectionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.admin.connections().then(setData).catch((e) => setError(describeError(e, '読み込めませんでした')));
  useEffect(() => { void load(); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  return (
    <>
      <PageTitle trail={['接続', TITLES[page] ?? '']} help={CONNECTION_HELP[page]} />
      {/* 会社の AI の方針は、ローカルの形（社内の 1 台に入れた M2Office）でだけ出す（仕様書 第8.6節・第16.3.7.1節） */}
      {page === 'gemini' && data.ai.deployment === 'onsite' && <AiPolicyCard data={data.ai} onSaved={() => void load()} />}
      {page === 'gemini' && <GeminiCard data={data.gemini} onSaved={() => void load()} />}
      {(page === 'google' || page === 'permissions' || page === 'people') && (
        <GoogleCard data={data.google} page={page} onSaved={() => void load()} />
      )}
      {/* 接続の健全性（仕様書 第6.6.2節・第6.7.6節）。ダッシュボードの「接続先」と同じ記録から出す */}
      {page === 'google' && <HealthCard group="google" />}
      {page === 'gemini' && <HealthCard group="ai" />}
      {page === 'retention' && <RetentionCard />}
      {/* 会社の外のサービス（WordPress・LINE・窓口のメール。第6.6.2.1節） */}
      {isServiceConnectionPage(page) && <ServiceConnection page={page} />}
    </>
  );
}

/**
 * 接続の健全性（仕様書 第6.6.2節）。直近 15 分の状態を、ダッシュボードの「接続先」と同じ形で出す。
 *
 * @param group 出す区分（Google の各サービスか AI）
 */
function HealthCard({ group }: { group: ConnectionHealth['group'] }) {
  const [items, setItems] = useState<ConnectionHealth[] | null>(null);
  useEffect(() => {
    api.admin.connectionHealth().then((r) => setItems(r.items.filter((x) => x.group === group))).catch(() => setItems(null));
  }, [group]);
  if (!items || items.length === 0) return null;
  return <HealthList items={items} />;
}

/**
 * 登録済みの OAuth クライアントを Google で確かめるボタン（仕様書 第14.3.3節「登録の確認」）。
 *
 * @remarks
 * 保存し直さずに試せる。何も変えない。結果はボタンのすぐ横に出す（第6.10.4.2節）。
 * 確かめられなかったときは注意の色で出し、正しいとは言わない。
 */
function CheckClientButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verdict: GoogleClientVerdict | 'error'; text: string } | null>(null);
  const tone = (v: GoogleClientVerdict | 'error') =>
    v === 'ok' ? 'saved' : v === 'unreachable' || v === 'unexpected' ? 'saved warn' : 'error-inline';
  return (
    <span className="save-row">
      <button className="btn ghost" disabled={busy} onClick={() => void (async () => {
        setBusy(true); setResult(null);
        try {
          const r = await api.admin.testGoogleClient();
          setResult({ verdict: r.verdict, text: r.message });
        } catch (e) {
          setResult({ verdict: 'error', text: describeError(e, '確かめられませんでした') });
        } finally {
          setBusy(false);
        }
      })()}>{busy ? '確かめています…' : 'Google で確かめる'}</button>
      <span className="save-result" role="status" aria-live="polite">
        {result && <span className={tone(result.verdict)}>{result.text}</span>}
      </span>
    </span>
  );
}

/**
 * Google から取得したデータを残す日数（仕様書 第14.3.2節）。7 日より長くはできない。
 */
function RetentionCard() {
  const [days, setDays] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    api.admin.settings().then((s) => setDays(s.privacy.googleDataRetentionDays)).catch(() => setDays(null));
  }, []);
  if (days === null) return null;
  return (
    <div className="card">
      <p className="muted small">成果物（下書き等）は消しません</p>
      <div className="field">
        <label>残す日数</label>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 3, 1, 0].map((d) => <option key={d} value={d}>{d === 0 ? '業務が終わったらすぐ削除' : `${d} 日${d === 7 ? '（上限）' : ''}`}</option>)}
        </select>
      </div>
      <div className="row">
        <button className="btn" onClick={() => {
          setMsg(null);
          api.admin.saveSettings('privacy', { googleDataRetentionDays: days })
            .then(() => setMsg({ ok: true, text: '保存しました' }))
            .catch((e) => setMsg({ ok: false, text: describeError(e, '保存できませんでした') }));
        }}>保存</button>
      </div>
      {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
    </div>
  );
}

/**
 * 会社の AI の方針（仕様書 第16.3.7.1節、ADR-0059）。顧客の個人の情報を外部の AI に渡さないことを、仕組みで守る。
 *
 * @remarks ローカルの形でだけ出す。ローカル AI に届くかをその場で確かめられる
 */
function AiPolicyCard({ data, onSaved }: { data: ConnectionSettings['ai']; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const choose = async (mode: ConnectionSettings['ai']['policy']) => {
    setBusy(true);
    setNote(null);
    try { await api.admin.saveAiPolicy(mode); onSaved(); } catch (e) { setNote(describeError(e, '変えられませんでした')); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await api.admin.testLocalLlm();
      setNote(r.ok ? `ローカル AI に届きました（モデル: ${(r.models ?? []).join('、') || '一覧なし'}）` : `ローカル AI に届きません: ${r.error ?? ''}`);
    } finally { setBusy(false); }
  };
  const options: { value: ConnectionSettings['ai']['policy']; label: string }[] = [
    { value: 'local-first', label: 'ローカルを既定' }, { value: 'local-only', label: 'ローカルだけ' }, { value: 'cloud', label: 'クラウド' },
  ];
  return (
    <div className="card">
      <h3>AI の方針</h3>
      <div className="segmented small" role="group" aria-label="AI の方針">
        {options.map((o) => (
          <button key={o.value} className={data.policy === o.value ? 'on' : ''} aria-pressed={data.policy === o.value} disabled={busy}
            onClick={() => { if (data.policy !== o.value) void choose(o.value); }}>{o.label}</button>
        ))}
      </div>
      <div className="row small">
        <span className={data.localConfigured ? 'muted' : 'error-inline'}>{data.localConfigured ? 'ローカル AI: 設定あり' : 'ローカル AI: 設定がありません'}</span>
        <button className="btn ghost small" disabled={busy || !data.localConfigured} onClick={() => void test()}>ローカル AI を確かめる</button>
        {note && <span className="small">{note}</span>}
      </div>
    </div>
  );
}

/** Gemini（業務の推論・秘書・Web の調査・音声）。 */
function GeminiCard({ data, onSaved }: { data: ConnectionSettings['gemini']; onSaved: () => void }) {
  const [mode, setMode] = useState(data.mode);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<Record<string, string>>(data.models);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: done }); setApiKey(''); onSaved(); }
    catch (e) { setMsg({ ok: false, text: describeError(e, '保存できませんでした') }); }
    finally { setBusy(false); }
  };
  const test = async (kind: 'text' | 'live') => {
    setTests((t) => ({ ...t, [kind]: '確かめています…' }));
    try {
      const r = await api.admin.testGemini(kind);
      setTests((t) => ({ ...t, [kind]: r.ok ? `つながりました（${r.model}・${r.ms} ms）` : `つながりませんでした: ${r.error}` }));
    } catch (e) {
      setTests((t) => ({ ...t, [kind]: `つながりませんでした: ${describeError(e)}` }));
    }
  };
  // いま動いている鍵（状態の欄の印と文）。鍵が無ければ、秘書も業務も動かないことをはっきり出す
  const effective = {
    tenant: { cls: 'badge ok', text: '自社の鍵で動いています' },
    platform: { cls: 'badge ok', text: '運営の鍵で動いています' },
    none: { cls: 'badge warn', text: '使える鍵がありません。秘書も業務も動きません' },
  }[data.effective];

  return (
    <>
      <div className="card">
        <h3>いまの状態</h3>
        <dl className="kv">
          <dt>使っている鍵</dt><dd><span className={effective.cls}>{effective.text}</span></dd>
          <dt>確かめる</dt>
          <dd>
            <button className="btn ghost small" onClick={() => void test('text')}>文章を試す</button>{' '}
            <button className="btn ghost small" onClick={() => void test('live')}>音声（Gemini Live）を試す</button>
            {tests['text'] && <div className="small">文章: {tests['text']}</div>}
            {tests['live'] && <div className="small">音声: {tests['live']}</div>}
          </dd>
        </dl>
      </div>
      <div className="card">
        <h3>設定</h3>
        <div className="field">
          <label>契約の形態</label>
          <label className="check"><input type="radio" checked={mode === 'platform'} onChange={() => setMode('platform')} /> 運営一括（M2Office の鍵を使う）</label>
          <label className="check"><input type="radio" checked={mode === 'byok'} onChange={() => setMode('byok')} /> 自社の鍵を使う（費用は自社の Google Cloud に直接かかります）</label>
        </div>
        {mode === 'byok' && (
          <div className="field">
            <label>Gemini API キー{data.keyRegistered && <span className="muted small">（登録済み・{fmt(data.updatedAt)}。登録後は表示しません）</span>}</label>
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={data.keyRegistered ? '●●●●●●●●（替えるときだけ入れる）' : 'AIzaSy…'} />
          </div>
        )}
        <div className="field">
          <label>使うモデル（空欄なら薄く出ている既定のモデル）</label>
          <div className="grid2">
            {MODEL_LABELS.map(([k, label]) => (
              <div className="field" key={k}>
                <label>{label}</label>
                <input value={models[k] ?? ''} placeholder={data.defaults[k]} onChange={(e) => setModels({ ...models, [k]: e.target.value })} />
              </div>
            ))}
          </div>
        </div>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => void run(() => api.admin.saveGemini({ mode, apiKey: apiKey || undefined, models }), '保存しました')}>保存</button>
          {data.keyRegistered && (
            <button className="btn danger" disabled={busy} onClick={() => {
              if (confirm('自社の鍵を削除しますか。削除すると運営一括に戻ります。')) void run(() => api.admin.deleteGeminiKey(), '鍵を削除しました');
            }}>鍵を削除</button>
          )}
          {msg && <span className={msg.ok ? 'ok-msg small' : 'error-inline small'}>{msg.text}</span>}
        </div>
      </div>
    </>
  );
}

/** Google Workspace（会社の OAuth クライアントの登録と、利用者ごとの接続）。 */
/**
 * 求める許可（確認の画面。仕様書 第14.3.2節 規定 2）。許可ごとに、その許可を使う業務を並べる（第6.6.3.0節）。
 *
 * @param scopes 接続の設定が返す、求める許可の一覧（業務の言葉の名前つき）
 */
function RequiredScopes({ scopes }: { scopes: ConnectionSettings['google']['requiredScopes'] }) {
  const [usedBy, setUsedBy] = useState<Map<string, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.admin.googlePermissions()
      .then((r) => setUsedBy(new Map(r.items.map((x) => [x.scope, x.agents]))))
      .catch((e) => setError(describeError(e, '使う業務を読み込めませんでした')));
  }, []);
  return (
    <div className="card">
      <p className="muted small">制限付き＝公開時に CASA 評価が必要</p>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead><tr><th>許可</th><th>段階</th><th>利用する業務</th></tr></thead>
        <tbody>
          {scopes.map((s) => (
            <tr key={s.scope}>
              <td>{s.label}<div><code className="small">{s.scope}</code></div></td>
              <td><span className={LEVEL[s.level]?.cls ?? 'badge'}>{LEVEL[s.level]?.text ?? s.level}</span></td>
              <td className="small">{usedBy ? (usedBy.get(s.scope)?.join('、') || '—') : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** ドライブの写真を選ぶ画面（Google Picker）の API キー（仕様書 第41.19.2節）。 */
function PickerKey({ registered, onSaved }: { registered: boolean; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (value: string) => {
    setMsg(null);
    try {
      await api.admin.saveGooglePickerKey(value);
      setKey('');
      setMsg({ ok: true, text: value ? '保存しました' : '削除しました' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, '保存できませんでした') });
    }
  };
  return (
    <div className="field">
      <div className="row">
        <input value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)} placeholder={registered ? '●●●●●●●●（登録済み）' : 'AIza…'} />
        <button className="btn ghost small" disabled={!key.trim()} onClick={() => void save(key.trim())}>保存</button>
        {registered && <button className="link danger small" onClick={() => void save('')}>削除</button>}
      </div>
      {msg && <p className={msg.ok ? 'ok-msg small' : 'error small'}>{msg.text}</p>}
    </div>
  );
}

/**
 * 通知の控えを送る会社の Chat アプリの鍵（サービスアカウントの JSON。仕様書 第6.5.5.2.1節）。貼るかファイルを選んで登録する。
 *
 * @remarks 登録のときに Google で Chat アプリとして認証できるかを確かめ、できなければ保存しない。鍵は画面に戻さない
 */
function ChatAppKey({ data, onSaved }: { data: { registered: boolean; clientEmail: string } | null; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.admin.saveChatAppKey(key.trim());
      setKey('');
      setMsg({ ok: true, text: `登録しました（${r.clientEmail}）` });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, '登録できませんでした') });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true); setMsg(null);
    try { await api.admin.deleteChatAppKey(); setMsg({ ok: true, text: '削除しました' }); onSaved(); }
    catch (e) { setMsg({ ok: false, text: describeError(e, '削除できませんでした') }); }
    finally { setBusy(false); }
  };
  return (
    <div className="field">
      {data?.registered && <p className="small muted">登録済み: {data.clientEmail}</p>}
      <textarea rows={3} value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)}
        placeholder={data?.registered ? '登録し直すときだけ、新しい鍵の JSON を貼る' : 'サービスアカウントの鍵の JSON を貼る'} />
      <div className="row">
        <button className="btn ghost small" disabled={busy} onClick={() => file.current?.click()}>ファイルを選ぶ</button>
        <button className="btn ghost small" disabled={busy || !key.trim()} onClick={() => void save()}>{busy ? '確かめています…' : '登録'}</button>
        {data?.registered && <button className="link danger small" disabled={busy} onClick={() => void remove()}>削除</button>}
      </div>
      <input ref={file} type="file" accept=".json,application/json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && f.size < 20_000) void f.text().then(setKey); }} />
      {msg && <p className={msg.ok ? 'ok-msg small' : 'error small'}>{msg.text}</p>}
    </div>
  );
}

/**
 * Google のログインの記録（不正の兆しの見張りの段 3。仕様書 第16.8.6節）。担当（Google の管理者である M2Office の管理者）の許可と、読めているか。
 *
 * @remarks 読み取りだけの許可を、本人の Google の接続とは別に預ける。戻ってきたら結果（`?loginaudit=`）を出す。
 * Google Workspace の会社のドメインでログインしていない会社では出さない
 */
function GoogleLoginAudit({ status, reload }: { status: GoogleLoginAuditStatus | null; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result] = useState(() => {
    const r = new URLSearchParams(location.search).get('loginaudit');
    if (r) history.replaceState(null, '', location.pathname);
    return r;
  });
  const RESULT_TEXT: Record<string, string> = {
    connected: '接続しました', cancelled: '接続をキャンセルしました', scopes: 'ログインの記録を見る許可が足りません。Google の管理者のアカウントで、許可してください',
    domain: '会社の Google Workspace のドメインのアカウントではありません', client: '会社の Google 接続の設定に誤りがあります', failed: '接続できませんでした',
  };
  const load = reload;
  const connect = () => {
    setBusy(true); setError(null);
    api.admin.connectGoogleLoginAudit().then((r) => { if (r.url) location.href = r.url; else load(); })
      .catch((e) => setError(describeError(e, '接続できませんでした'))).finally(() => setBusy(false));
  };
  const disconnect = () => {
    if (!window.confirm('Google のログインの記録を切断しますか。Google アカウントの異変を見張らなくなります')) return;
    setBusy(true); setError(null);
    api.admin.disconnectGoogleLoginAudit().then(load).catch((e) => setError(describeError(e, '切断できませんでした'))).finally(() => setBusy(false));
  };
  if (!status || status.state === 'na') return null;
  return (
    <div className="field">
      <div className="row wrap">
        {status.state === 'connected'
          ? <>
              {status.read === 'error' ? <span className="badge warn">読めていません</span> : <span className="badge ok">接続中</span>}
              <span className="small">担当: {status.assignee ?? '（分かりません）'}（{status.email}）</span>
              <button className="btn ghost small" disabled={busy} onClick={connect}>{status.read === 'error' ? '接続し直す' : '担当を替える'}</button>
              <button className="link danger small" disabled={busy} onClick={disconnect}>切断</button>
            </>
          : <>
              <span className="muted small">未接続</span>
              <button className="btn ghost small" disabled={busy} onClick={connect}>{busy ? '接続しています…' : '接続'}</button>
            </>}
      </div>
      {result && <p className={result === 'connected' ? 'ok-msg small' : 'error small'}>{RESULT_TEXT[result] ?? '接続できませんでした'}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** 状態の札（設定済み・未設定・注意）。 */
function StateBadge({ state, text }: { state: 'ok' | 'off' | 'warn'; text: string }) {
  return <span className={state === 'ok' ? 'badge ok' : state === 'warn' ? 'badge warn' : 'badge muted-badge'}>{text}</span>;
}

/** 「接続」の小分けへ移る（管理者ページは URL の変化で画面を切り替える）。 */
function goPage(page: string) {
  const href = adminPath('connectors', page);
  history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** 追加の機能（Google Workspace の画面の「追加の機能」。第6.6.2節「画面の構成」）。 */
type Extra = 'picker' | 'chat' | 'audit';

/**
 * Google Workspace の画面（仕様書 第6.6.2節「Google Workspace」の「画面の構成」）。
 * 上から、状態の一覧・基本の設定（OAuth クライアント）・追加の機能（Picker の API キー・Chat アプリの鍵・ログインの記録）。
 * 小分けの「求める許可」「従業員の接続」は同じ部品で出す。
 */
function GoogleCard({ data, page, onSaved }: {
  data: ConnectionSettings['google']; page: string; onSaved: () => void;
}) {
  const [clientId, setClientId] = useState(data.clientId);
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [audit, setAudit] = useState<GoogleLoginAuditStatus | null>(null);
  // ログインの記録の接続から戻ってきたとき（`?loginaudit=`）は、その結果が見えるように開いておく
  const [open, setOpen] = useState<Set<Extra>>(() => new Set(new URLSearchParams(location.search).get('loginaudit') ? ['audit'] : []));
  const loadAudit = () => void api.admin.googleLoginAudit().then(setAudit).catch(() => setAudit(null));
  useEffect(() => { if (page === 'google') loadAudit(); }, [page]);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: done }); setSecret(''); onSaved(); }
    catch (e) { setMsg({ ok: false, text: describeError(e, '保存できませんでした') }); }
    finally { setBusy(false); }
  };
  const registered = !!data.clientId && data.secretRegistered;
  const connectedCount = data.users.filter((u) => u.connected).length;
  // ログインの記録は、見本データの会社ならクライアントの登録が無くてもつなげる
  const auditUsable = (registered || data.workspaceSource === 'mock') && !!audit && audit.state !== 'na';
  const toggle = (k: Extra, on?: boolean) => setOpen((cur) => {
    const next = new Set(cur);
    if (on ?? !next.has(k)) next.add(k); else next.delete(k);
    return next;
  });
  /** 状態の一覧から、その設定へ移る（追加の機能は開く）。 */
  const jump = (id: string, extra?: Extra) => {
    if (extra) toggle(extra, true);
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const auditState = (): { state: 'ok' | 'off' | 'warn'; text: string } =>
    audit?.state === 'connected' ? (audit.read === 'error' ? { state: 'warn', text: '読めていません' } : { state: 'ok', text: '接続中' }) : { state: 'off', text: '未接続' };
  /** 追加の機能の 1 つ（名前・使う機能・状態。押すと開く）。 */
  const extra = (k: Extra, id: string, name: string, uses: string, st: { state: 'ok' | 'off' | 'warn'; text: string }, body: ReactNode) => (
    <details key={k} id={id} className="google-extra" open={open.has(k)} onToggle={(e) => toggle(k, (e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="google-extra-name">{name}</span>
        <StateBadge state={registered || k === 'audit' ? st.state : 'off'} text={registered || k === 'audit' ? st.text : '基本の設定が先'} />
        <span className="muted small google-extra-uses">{uses}</span>
      </summary>
      {registered || (k === 'audit' && auditUsable) ? body : null}
    </details>
  );

  return (
    <>
      {page === 'google' && (
      <>
      {/* 状態の一覧。何が設定済みで、何が足りないかを一目で（第6.6.2節「画面の構成」） */}
      <div className="card">
        <h3>状態</h3>
        <ul className="google-status">
          <li><button type="button" className="link" onClick={() => jump('google-client')}>OAuth クライアント</button><StateBadge state={registered ? 'ok' : 'off'} text={registered ? '設定済み' : '未設定'} /></li>
          <li><button type="button" className="link" onClick={() => jump('google-picker', 'picker')}>Picker の API キー</button><StateBadge state={data.pickerKeyRegistered ? 'ok' : 'off'} text={data.pickerKeyRegistered ? '設定済み' : '未設定'} /></li>
          <li><button type="button" className="link" onClick={() => jump('google-chat', 'chat')}>Chat アプリの鍵</button><StateBadge state={data.chatApp?.registered ? 'ok' : 'off'} text={data.chatApp?.registered ? '設定済み' : '未設定'} /></li>
          {audit && audit.state !== 'na' && (
            <li><button type="button" className="link" onClick={() => jump('google-audit', 'audit')}>ログインの記録</button><StateBadge {...auditState()} /></li>
          )}
          <li><button type="button" className="link" onClick={() => goPage('people')}>従業員の接続</button><span className="small">{connectedCount} / {data.users.length} 人</span></li>
          {/* 業務が断られて分かった、有効になっていない API（第6.6.2節「足りない API を知らせる」） */}
          {(data.apiGaps ?? []).map((g) => (
            <li key={g.service} className="google-gap">
              <span>{g.label}</span>
              <span className="row">
                <StateBadge state="warn" text="有効になっていません" />
                <a className="btn small" href={googleEnableApiUrl([g.service], data.projectNumber ?? null)} target="_blank" rel="noreferrer">有効にする</a>
                <button type="button" className="btn ghost small" onClick={() => void api.admin.clearGoogleApiGap(g.service).then(onSaved)}>有効にした</button>
              </span>
            </li>
          ))}
        </ul>
        {data.workspaceSource === 'mock' && <p className="warn-msg small">この会社の業務は見本データで動きます</p>}
      </div>

      <div className="card" id="google-client">
        <h3>基本の設定</h3>
        {/* 手順の説明は「？」とヘルプの記事に任せ、ここには Google Cloud の各画面へのリンクとリダイレクト URI だけを置く */}
        {/* M2Office が使う API を並べた「まとめて有効にする」画面を開く（第6.6.2節「必要な API をまとめて有効にする」） */}
        <p>
          <a className="btn ghost" href={googleEnableApiUrl(GOOGLE_APIS.map((a) => a.service), data.projectNumber ?? null)} target="_blank" rel="noreferrer">必要な API をまとめて有効にする</a>
        </p>
        <div className="row small">
          <a className="link" href="https://console.cloud.google.com/apis/library" target="_blank" rel="noreferrer">API ライブラリ</a>
          <a className="link" href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noreferrer">同意画面（内部）</a>
          <a className="link" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">クライアント</a>
        </div>
        <div className="field">
          <label>リダイレクト URI</label>
          <div className="row">
            <code className="uri">{data.redirectUri}</code>
            <button className="btn ghost small" onClick={() => {
              void copyText(data.redirectUri).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } });
            }}>{copied ? 'コピーしました' : 'コピー'}</button>
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>クライアント ID</label>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456-abc.apps.googleusercontent.com" />
          </div>
          <div className="field">
            <label>クライアント シークレット</label>
            <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)}
              placeholder={data.secretRegistered ? `●●●●●●●●（登録済み・${fmt(data.updatedAt)}）` : 'GOCSPX-…'} />
          </div>
        </div>
        <div className="row">
          {/* 保存の前に Google で組を確かめる。誤りなら API が断り、その理由をボタンの横に出す（仕様書 第14.3.3節） */}
          <SaveButton
            disabled={busy}
            run={async () => {
              // クライアント ID を替えると、全員の接続が使えなくなる。先に確かめる（仕様書 第6.5.2.1節）
              if (registered && data.clientId && clientId.trim() !== data.clientId) {
                const impact = await api.admin.googleClientImpact().catch(() => null);
                if (impact && impact.users > 0 && !confirm(clientChangeText(impact, 'クライアント ID を替えます'))) return null;
              }
              setMsg(null);
              const r = await api.admin.saveGoogleClient({ clientId, clientSecret: secret || undefined });
              setSecret('');
              onSaved();
              return r;
            }}
            done={(r) => (r === null ? '' : { text: r.message, warn: r.verdict !== 'ok' })}
          />
          {registered && <CheckClientButton />}
          {registered && (
            <button className="btn danger" disabled={busy} onClick={() => void (async () => {
              const impact = await api.admin.googleClientImpact().catch(() => null);
              if (!confirm(clientChangeText(impact, 'OAuth クライアントの登録を消します'))) return;
              await run(() => api.admin.deleteGoogleClient(), '登録を削除しました');
            })()}>登録を削除</button>
          )}
        </div>
        {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
      </div>

      {/* 追加の機能。名前・使う機能・状態を 1 行に出し、押すと開いて設定する */}
      <div className="card">
        <h3>追加の機能</h3>
        {extra('picker', 'google-picker', 'ファイルを選ぶ画面（Picker の API キー）',
          'スライドのテーマ・文書と表のテンプレート・秘書にドライブのファイルを渡す・販促物の「ドライブから」',
          data.pickerKeyRegistered ? { state: 'ok', text: '設定済み' } : { state: 'off', text: '未設定' },
          <PickerKey registered={!!data.pickerKeyRegistered} onSaved={onSaved} />)}
        {extra('chat', 'google-chat', 'Chat への通知（Chat アプリの鍵）', '通知の控えを Google Chat で届ける',
          data.chatApp?.registered ? { state: 'ok', text: '設定済み' } : { state: 'off', text: '未設定' },
          <ChatAppKey data={data.chatApp ?? null} onSaved={onSaved} />)}
        {audit && audit.state !== 'na' && extra('audit', 'google-audit', 'ログインの見張り（ログインの記録）', 'Google アカウントの不正の兆しを見張る',
          auditState(), <GoogleLoginAudit status={audit} reload={loadAudit} />)}
      </div>
      </>
      )}

      {page === 'permissions' && <RequiredScopes scopes={data.requiredScopes} />}

      {page === 'people' && (
      <div className="card">
        <p className="muted small">{connectedCount} / {data.users.length} 人が接続済み</p>
        <table className="table">
          <thead><tr><th>名前</th><th>Google アカウント</th><th>接続した日時</th><th>足りない許可</th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.userId}>
                <td>{u.name}<div className="muted small">{u.email}</div></td>
                <td>{u.connected ? (u.googleEmail ?? '（取得できませんでした）') : <span className="muted">未接続</span>}</td>
                <td className="small">{fmt(u.connectedAt)}</td>
                <td className="small">{u.missing.length > 0 ? <span className="warn-inline">{u.missing.join('、')}</span> : u.connected ? 'なし' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </>
  );
}

/** 小分けの題名（仕様書 第6.6.0.1節）。 */
const TITLES: Record<string, string> = {
  gemini: 'Gemini',
  google: 'Google Workspace',
  retention: 'Google のデータを残す日数',
  permissions: 'Google に求める許可',
  people: 'Google の従業員の接続',
  wordpress: 'WordPress',
  line: 'LINE 公式アカウント',
  mailbox: '窓口のメール',
  mcp: 'コネクタ（MCP）',
};

/**
 * 小分けごとの「？」の説明（仕様書 第6.10.4.4節）。
 *
 * @remarks `mcp` の画面は管理者ページ側（`Admin.tsx`）が出す。題名と説明もそちらで持つ
 */
const CONNECTION_HELP: Record<string, PageHelp> = {
  gemini: { article: 'admin-connectors', text: '業務の推論・秘書・Web の調査・音声に使う Gemini の鍵とモデルです。鍵は登録後に表示しません。' },
  google: { article: 'admin-google-setup', text: '従業員が Google Workspace につなぐための設定です。はじめての設定の手順は、ヘルプの「Google Workspace のつなぎ方」にあります。' },
  retention: { article: 'admin-connectors', text: '業務が Google から読んだメールや文書の中身と、そこから作った文を、業務が終わってから何日残すかです。過ぎると中身を消し、使ったツールの名前と件数だけを残します。' },
  permissions: { article: 'admin-connectors', text: '従業員が接続するときに Google に求める許可と、その権限の段階です。' },
  people: { article: 'admin-connectors', text: '従業員ごとの、Google との接続の状況です。' },
  wordpress: { article: 'admin-connectors', text: 'コラムとお知らせを入れる会社の WordPress です。アプリケーションパスワードは、WordPress の「ユーザー → プロフィール」で作ります。' },
  line: { article: 'admin-connectors', text: '問い合わせ・お知らせの配信・会員証に使う LINE 公式アカウントです。接続したときに出る受け口の URL を、LINE の管理画面の Webhook に入れます。' },
  mailbox: { article: 'admin-connectors', text: '問い合わせを受け、まとめてのメールを送る、窓口の Google のアカウント（info@ など）です。' },
};
