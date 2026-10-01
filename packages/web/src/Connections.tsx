/**
 * @file 管理者ページ「接続」。Gemini（自社の鍵・モデル・接続の確認）と Google Workspace（会社の OAuth クライアントの登録、
 * 利用者ごとの接続状況、業務が求める権限）。
 *
 * AI Radio の「システム接続設定」の作り（伏せ字の入力欄、実際に許可された範囲の表示、サインインのボタン）を引き継ぐ。
 * 秘密の値は画面に出さない。登録済みかどうかと日時だけを示し、上書きと削除だけができる。
 *
 * @see 仕様書 第14.3.3節 接続の設定
 * @see 仕様書 第14.3.2節 Google から取得したデータの保持
 * @see ADR-0007 接続の設定
 */

import { useEffect, useState } from 'react';
import { api, describeError, type ConnectionSettings, type GoogleClientVerdict } from './api.js';
import { PageTitle, type PageHelp } from './help.js';
import { SaveButton } from './save.js';

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
      {page === 'retention' && <RetentionCard />}
    </>
  );
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
  const effective = { tenant: '自社の鍵を使っています', platform: '運営の鍵を使っています', none: '使える鍵がありません。秘書も業務も動きません' }[data.effective];

  return (
    <div className="card">
      <p className="small">いまの状態: <strong>{effective}</strong></p>
      <div className="field">
        <label>契約の形態</label>
        <label className="check"><input type="radio" checked={mode === 'platform'} onChange={() => setMode('platform')} /> 運営一括（M2Office の鍵を使う）</label>
        <label className="check"><input type="radio" checked={mode === 'byok'} onChange={() => setMode('byok')} /> 自社の鍵を使う（費用は自社の Google Cloud に直接かかります）</label>
      </div>
      {mode === 'byok' && (
        <div className="field">
          <label>Gemini API キー</label>
          <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={data.keyRegistered ? `●●●●●●●●（登録済み・${fmt(data.updatedAt)}）` : 'AIzaSy…'} />
          <span className="small muted">登録後は表示しません</span>
        </div>
      )}
      <details className="field">
        <summary className="small">モデルを指定する（空欄なら既定）</summary>
        <div className="grid2">
          {MODEL_LABELS.map(([k, label]) => (
            <div className="field" key={k}>
              <label>{label}</label>
              <input value={models[k] ?? ''} placeholder={data.defaults[k]} onChange={(e) => setModels({ ...models, [k]: e.target.value })} />
            </div>
          ))}
        </div>
      </details>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => void run(() => api.admin.saveGemini({ mode, apiKey: apiKey || undefined, models }), '保存しました')}>保存</button>
        {data.keyRegistered && (
          <button className="btn danger" disabled={busy} onClick={() => {
            if (confirm('自社の鍵を削除しますか。削除すると運営一括に戻ります。')) void run(() => api.admin.deleteGeminiKey(), '鍵を削除しました');
          }}>鍵を削除</button>
        )}
      </div>
      {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
      <h4>接続の確認</h4>
      <div className="row">
        <button className="btn ghost small" onClick={() => void test('text')}>文章を試す</button>
        <span className="small">{tests['text']}</span>
      </div>
      <div className="row">
        <button className="btn ghost small" onClick={() => void test('live')}>音声（Gemini Live）を試す</button>
        <span className="small">{tests['live']}</span>
      </div>
    </div>
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

function GoogleCard({ data, page, onSaved }: {
  data: ConnectionSettings['google']; page: string; onSaved: () => void;
}) {
  const [clientId, setClientId] = useState(data.clientId);
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: done }); setSecret(''); onSaved(); }
    catch (e) { setMsg({ ok: false, text: describeError(e, '保存できませんでした') }); }
    finally { setBusy(false); }
  };
  const registered = !!data.clientId && data.secretRegistered;
  const connectedCount = data.users.filter((u) => u.connected).length;

  return (
    <>
      {page === 'google' && (
      <div className="card">
        {/* 手順の説明は「？」とヘルプの記事に任せ、ここには Google Cloud の各画面へのリンクとリダイレクト URI だけを置く */}
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
              void navigator.clipboard?.writeText(data.redirectUri).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
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
        {data.workspaceSource === 'mock' && (
          <p className="warn-msg small">この会社の業務は見本データで動きます</p>
        )}
      </div>
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
  retention: 'データを残す日数',
  permissions: '求める許可',
  people: '従業員の接続状況',
  mcp: 'コネクタ（MCP）',
};

/**
 * 小分けごとの「？」の説明（仕様書 第6.10.4.4節）。
 *
 * @remarks `mcp` の画面は管理者ページ側（`Admin.tsx`）が出す。題名と説明もそちらで持つ
 */
const CONNECTION_HELP: Record<string, PageHelp> = {
  gemini: { article: 'admin-connectors', text: '業務の推論・秘書・Web の調査・音声に使う Gemini の鍵とモデルです。鍵は登録後に表示しません。' },
  google: { article: 'admin-connectors', text: '従業員が Google Workspace につなぐための OAuth クライアントです。シークレットは登録後に表示しません。' },
  retention: { article: 'admin-connectors', text: '業務が Google から読んだメールや文書の中身と、そこから作った文を、業務が終わってから何日残すかです。過ぎると中身を消し、使ったツールの名前と件数だけを残します。' },
  permissions: { article: 'admin-connectors', text: '従業員が接続するときに Google に求める許可と、その権限の段階です。' },
  people: { article: 'admin-connectors', text: '従業員ごとの、Google との接続の状況です。' },
};
