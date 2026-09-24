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
import { api, describeError, type ConnectionSettings } from './api.js';
import { HelpTip } from './help.js';

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
      <h1>
        接続 › {TITLES[page] ?? ''}{' '}
        <HelpTip article="admin-connectors">Gemini と Google Workspace への接続を設定します。鍵やシークレットは登録後に表示しません。</HelpTip>
      </h1>
      {page === 'gemini' && <GeminiCard data={data.gemini} onSaved={() => void load()} />}
      {(page === 'google' || page === 'permissions' || page === 'people') && (
        <GoogleCard data={data.google} page={page} onSaved={() => void load()} />
      )}
      {page === 'retention' && <RetentionCard />}
    </>
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
      <p className="small">
        <HelpTip article="admin-connectors">業務が Google から読んだメールや文書の中身と、そこから作った文を、業務が終わってから何日残すかです。過ぎると中身を消し、使ったツールの名前と件数だけを残します。</HelpTip>
      </p>
      <p className="muted small">業務が終わってから、この日数が過ぎると、読んだメール・文書の中身と、そこから作った要約などを消します。作った成果物（下書き・議事録など）は消しません。承認待ちの間は残します。</p>
      <div className="field">
        <label>残す日数</label>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 3, 1, 0].map((d) => <option key={d} value={d}>{d === 0 ? '業務が終わったらすぐ消す' : `${d} 日${d === 7 ? '（上限）' : ''}`}</option>)}
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
  const effective = { tenant: '自社の鍵を使っています', platform: '運営の鍵を使っています', none: '使える鍵がありません（開発用のスタブで動いています）' }[data.effective];

  return (
    <div className="card">
      <p className="muted small">業務の推論・秘書・Web の調査・音声に使います。</p>
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
          <span className="small muted">Google AI Studio（aistudio.google.com）で発行した鍵を貼ります。登録した鍵は二度と表示しません。変えるときは上書きしてください。</span>
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
      <p className="muted small">
        音声では、鍵をブラウザに渡しません。ブラウザは M2Office のサーバーにつなぎ、サーバーが Gemini Live へ中継します。
      </p>
    </div>
  );
}

/** Google Workspace（会社の OAuth クライアントの登録と、利用者ごとの接続）。 */
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
        <p className="small">
          Gmail・カレンダー・ToDo・Chat・ドライブほかに使います。{' '}
          会社の Google Cloud で作った OAuth クライアント（同意画面を「内部」にしたもの）を登録します。
          社内だけで使うアプリになるため、Google の審査は要りません。登録したあと、従業員はそれぞれ個人設定の「Google 連携」で接続します。
        </p>
        <ol className="small steps-guide">
          <li>
            Google Cloud でプロジェクトを作り、使う API（Gmail・Calendar・Tasks・Chat・Drive・Docs・Sheets・Slides・People・Meet・Forms）を有効にする
            （<a className="link" href="https://console.cloud.google.com/apis/library" target="_blank" rel="noreferrer">API ライブラリ</a>）
          </li>
          <li>
            OAuth の同意画面を<strong>「内部」</strong>で作る
            （<a className="link" href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noreferrer">同意画面</a>）
          </li>
          <li>
            OAuth クライアントを種類「ウェブ アプリケーション」で作り、次の<strong>リダイレクト URI</strong>を登録する
            （<a className="link" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">クライアント</a>）
            <div className="row">
              <code className="uri">{data.redirectUri}</code>
              <button className="btn ghost small" onClick={() => {
                void navigator.clipboard?.writeText(data.redirectUri).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
              }}>{copied ? 'コピーしました' : 'コピー'}</button>
            </div>
          </li>
          <li>クライアント ID とクライアント シークレットを、下に登録する</li>
          <li>管理者が自分で、個人設定の「Google 連携」から接続を試す</li>
        </ol>
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
          <button className="btn" disabled={busy} onClick={() => void (async () => {
            // クライアント ID を替えると、全員の接続が使えなくなる。先に確かめる（仕様書 第6.5.2.1節）
            if (registered && data.clientId && clientId.trim() !== data.clientId) {
              const impact = await api.admin.googleClientImpact().catch(() => null);
              if (impact && impact.users > 0 && !confirm(clientChangeText(impact, 'クライアント ID を替えます'))) return;
            }
            await run(() => api.admin.saveGoogleClient({ clientId, clientSecret: secret || undefined }), '保存しました');
          })()}>保存</button>
          {registered && (
            <button className="btn danger" disabled={busy} onClick={() => void (async () => {
              const impact = await api.admin.googleClientImpact().catch(() => null);
              if (!confirm(clientChangeText(impact, 'OAuth クライアントの登録を消します'))) return;
              await run(() => api.admin.deleteGoogleClient(), '登録を消しました');
            })()}>登録を消す</button>
          )}
        </div>
        {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
        {data.workspaceSource === 'mock' && (
          <p className="warn-msg small">
            Google の API を実際に呼ぶ部分は準備中です。接続して許可の状況を確かめることはできますが、業務はまだ見本のデータで動きます。
          </p>
        )}
      </div>
      )}

      {page === 'permissions' && (
      <div className="card">
        <p className="small">この会社で使える業務のツールから決まります。使っていない業務の許可は求めません。業務を足して許可が増えたら、従業員に接続し直しを案内します。</p>
        <table className="table">
          <tbody>
            {data.requiredScopes.map((s) => (
              <tr key={s.scope}>
                <td>{s.label}</td>
                <td><code className="small">{s.scope}</code></td>
                <td><span className={LEVEL[s.level]?.cls ?? 'badge'}>{LEVEL[s.level]?.text ?? s.level}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

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
