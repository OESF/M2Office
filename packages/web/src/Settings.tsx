/**
 * @file 個人設定の画面（プロフィール・Google 連携・秘書・通知・表示・メニューの並び・セキュリティ・利用状況）。
 *
 * @see 仕様書 第6.5節 個人設定
 */

import { useEffect, useState } from 'react';
import type { UserSettings } from '@m2office/shared';
import { api, describeError, type AgentSummary, type Me, type MemoryView, type MyGoogle } from './api.js';
import { useTheme, type ThemeChoice } from './theme.js';
import { statusLabel } from './components.js';

/**
 * 個人設定（仕様書 第6.5節）。左ペインの最下部の利用者のカードの歯車のボタンから開く。
 *
 * @remarks
 * 昇華の履歴と会話ログ（第6.5.4節）は、昇華と会話ログの実装とあわせて追加する（Phase 2）。
 */
export function Settings({ me, agents, onChanged }: {
  me: Me; agents: AgentSummary[]; onChanged: () => void;
}) {
  const [s, setS] = useState<UserSettings | null>(null);
  const [name, setName] = useState(me.user.displayName);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.myUsage>> | null>(null);
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.mySessions>>['items']>([]);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});

  const loadSessions = () => api.mySessions().then((r) => setSessions(r.items));
  useEffect(() => {
    api.mySettings().then(setS).catch((e) => setMsg({ error: e.message }));
    api.myUsage().then(setUsage).catch(() => undefined);
    void loadSessions();
  }, []);

  async function save(fn: () => Promise<unknown>) {
    setMsg({});
    try {
      await fn();
      setMsg({ ok: '保存しました' });
      onChanged();
    } catch (e) {
      setMsg({ error: e instanceof Error ? e.message : '保存できませんでした' });
    }
  }

  if (!s) return <p className="muted">読み込み中…</p>;
  const set = <K extends keyof UserSettings>(k: K, v: Partial<UserSettings[K]>) =>
    setS({ ...s, [k]: { ...s[k], ...v } });

  const ordered = orderAgents(agents, s.menu.order);
  const move = (id: string, d: -1 | 1) => {
    const ids = ordered.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    set('menu', { order: ids });
  };

  return (
    <>
      {msg.ok && <p className="ok-msg">{msg.ok}</p>}
      {msg.error && <p className="error">{msg.error}</p>}

      <div className="card">
        <h3>利用状況</h3>
        <dl className="kv">
          <dt>区分</dt><dd>{usage?.seat ?? '—'}</dd>
          <dt>使える業務</dt><dd>{usage ? `${usage.availableAgents} 件` : '—'}</dd>
          <dt>今月の実行</dt><dd>{usage ? `${usage.thisMonth.runs} 件` : '—'}</dd>
          <dt>グループ</dt><dd>{usage?.groups?.length ? usage.groups.join('、') : '所属なし'}</dd>
          <dt>権限区画</dt><dd>{usage?.compartments.length ? usage.compartments.join('、') : '所属なし'}</dd>
        </dl>
      </div>

      <div className="card">
        <h3>プロフィール</h3>
        <div className="grid2">
          <div className="field"><label>表示名</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>ふりがな</label>
            <input value={s.profile.furigana} onChange={(e) => set('profile', { furigana: e.target.value })} /></div>
        </div>
        <div className="grid2">
          <div className="field"><label>役職・所属</label>
            <input value={s.profile.title} onChange={(e) => set('profile', { title: e.target.value })} /></div>
          <div className="field"><label>タイムゾーン</label>
            <input value={s.profile.timezone} onChange={(e) => set('profile', { timezone: e.target.value })} /></div>
        </div>
        <div className="field"><label>メールアドレス</label>
          <input value={me.user.email} disabled /><span className="muted small">Google 側で管理しているため変更できません</span></div>
        <button className="btn" onClick={() => void save(async () => {
          if (name !== me.user.displayName) await api.saveDisplayName(name);
          await api.saveMySettings('profile', s.profile);
        })}>保存する</button>
      </div>

      <GoogleSettings />

      <div className="card">
        <h3>秘書</h3>
        <div className="grid2">
          <div className="field"><label>秘書の名前</label>
            <input value={s.secretary.name} placeholder="未設定" onChange={(e) => set('secretary', { name: e.target.value })} /></div>
          <div className="field"><label>自分の呼ばれ方</label>
            <input value={s.secretary.callMe} placeholder={`${me.user.displayName}さん`} onChange={(e) => set('secretary', { callMe: e.target.value })} /></div>
        </div>
        <div className="grid2">
          <div className="field"><label>応対スタイル</label>
            <select value={s.secretary.style} onChange={(e) => set('secretary', { style: e.target.value as 'polite' | 'concise' })}>
              <option value="polite">丁寧</option><option value="concise">簡潔</option>
            </select></div>
          <div className="field"><label>提案の積極性</label>
            <select value={s.secretary.proactivity} onChange={(e) => set('secretary', { proactivity: e.target.value as 'low' | 'normal' | 'high' })}>
              <option value="low">控えめ</option><option value="normal">標準</option><option value="high">積極的</option>
            </select></div>
        </div>
        <button className="btn" onClick={() => void save(() => api.saveMySettings('secretary', s.secretary))}>保存する</button>
      </div>

      <div className="card">
        <h3>通知</h3>
        <p>受け取る種類と、受け取り方を選びます。切った種類は画面内にも届きません。</p>
        {([['brief', '週次ブリーフ'], ['run', '実行の完了'], ['approval', '承認の依頼'], ['failure', '失敗']] as const).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={s.notifications.kinds[k]}
              onChange={(e) => set('notifications', { kinds: { ...s.notifications.kinds, [k]: e.target.checked } })} />
            {label}
          </label>
        ))}
        <h4>通知しない時間帯</h4>
        <p className="muted small">
          この時間帯は Chat とメールへ送りません。時間帯が明けてから送ります。画面内のお知らせはその場で届きます。
        </p>
        <div className="row">
          <input type="time" value={s.notifications.quietHours?.from ?? ''}
            onChange={(e) => set('notifications', {
              quietHours: e.target.value ? { from: e.target.value, to: s.notifications.quietHours?.to ?? '07:00' } : null,
            })} />
          <span>〜</span>
          <input type="time" value={s.notifications.quietHours?.to ?? ''}
            onChange={(e) => set('notifications', {
              quietHours: e.target.value ? { from: s.notifications.quietHours?.from ?? '22:00', to: e.target.value } : null,
            })} />
          <button className="btn ghost small" onClick={() => set('notifications', { quietHours: null })}>指定しない</button>
        </div>

        <h4>受け取り方</h4>
        <p className="muted small">
          画面内のお知らせは必ず残ります。Chat とメールには控えとして、種類・題名と画面へのリンクだけを送ります（本文は送りません）。
          いまは送信口が見本のため、実際には届きません。
        </p>
        {([['chat', 'Chat（本人への個別メッセージ）'], ['email', 'メール（会社のアドレス）']] as const).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={s.notifications.channels[k]}
              onChange={(e) => set('notifications', { channels: { ...s.notifications.channels, [k]: e.target.checked } })} />
            {label}
          </label>
        ))}
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save(() => api.saveMySettings('notifications', s.notifications))}>保存する</button>
        </div>
      </div>

      <PresenceNotice />

      <MemorySettings settings={s} onChange={(v) => set('memory', v)}
        onSave={() => void save(() => api.saveMySettings('memory', { ...s.memory }))} />

      <DisplaySettings />
      <div className="card">
        <h3>メニューの並び</h3>
        <p>使える業務のうち、メニューに並べるものと順番を決めます。使える業務を増やすことはできません。</p>
        <table className="table">
          <tbody>
            {ordered.map((a, i) => (
              <tr key={a.id}>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={!s.menu.hidden.includes(a.id)}
                      onChange={(e) => set('menu', {
                        hidden: e.target.checked ? s.menu.hidden.filter((x) => x !== a.id) : [...s.menu.hidden, a.id],
                      })} />
                    {a.name}
                  </label>
                </td>
                <td className="num">
                  <button className="btn ghost small" disabled={i === 0} onClick={() => move(a.id, -1)}>↑</button>{' '}
                  <button className="btn ghost small" disabled={i === ordered.length - 1} onClick={() => move(a.id, 1)}>↓</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save(() => api.saveMySettings('menu', { ...s.menu, order: ordered.map((a) => a.id) }))}>保存する</button>
        </div>
      </div>

      <div className="card">
        <h3>セキュリティ</h3>
        <p>2 段階認証は Google アカウント側で設定します。M2Office では設定しません。</p>
        <table className="table">
          <thead><tr><th>ログインした日時</th><th>最後の利用</th><th>端末</th><th /></tr></thead>
          <tbody>
            {sessions.map((x) => (
              <tr key={x.id}>
                <td>{new Date(x.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td>
                <td>{new Date(x.lastSeenAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td>
                <td className="small">{x.userAgent ?? '不明'}{x.current && '（この端末）'}</td>
                <td className="num">
                  {!x.current && <button className="btn ghost small"
                    onClick={() => void api.revokeSession(x.id).then(loadSessions)}>ログアウトさせる</button>}
                </td>
              </tr>
            ))}
            {sessions.length === 0 && <tr><td colSpan={4} className="muted">開発用ヘッダーでの接続のため、表示できる端末はありません</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * 本人の並び順で業務を並べる。並び順に無い業務は後ろに既定の順で並べる。
 *
 * @param agents 使える業務（管理者が有効にしたもの）
 * @param order 本人が決めた並び順
 */
/**
 * 管理者のダッシュボードでの自分の見え方（仕様書 第6.7.10節 規定 4）。
 *
 * @remarks
 * 「見られているかもしれない」に実物で答えるための区画である。
 * いまの自分の状態と、示される項目・示されない項目を並べる。
 */
function PresenceNotice() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.myPresence>> | null>(null);
  useEffect(() => { api.myPresence().then(setData).catch(() => setData(null)); }, []);
  if (!data) return null;
  return (
    <div className="card">
      <h3>管理者のダッシュボードでの見え方</h3>
      <p>
        管理者の画面には、いまのあなたは
        <strong>「{data.presence.detail}」</strong>
        と表示されています
        {data.granularity === 'counts' && <>（この会社は個人名を出さず、人数と業務だけを表示する設定です）</>}
        。
      </p>
      <p className="muted small">表示されるもの: {data.shown.join('、')}</p>
      <p className="muted small">表示されないもの: {data.hidden.join('、')}</p>
      <p className="muted small">
        個人の状態の履歴は残しません。後から見られるのは、監査ログ（誰が何を実行したか）と実行の記録だけです。
      </p>
    </div>
  );
}

/**
 * 記憶とデータ（仕様書 第6.5.4節）。秘書が自分について覚えていることを見て、消せるようにする。
 *
 * @remarks
 * 「何を覚えているか分からない AI」にしないための画面である（第11.5節）。
 * 覚えるのは、本人が秘書に「〜を覚えておいて」と頼んだときだけ（第11.5.1節）。
 */
function MemorySettings({ settings, onChange, onSave }: {
  settings: UserSettings;
  onChange: (v: UserSettings['memory']) => void;
  onSave: () => void;
}) {
  const [items, setItems] = useState<MemoryView[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.myMemories().then((r) => setItems(r.items)).catch((e) => setMsg(describeError(e)));
  useEffect(() => { void load(); }, []);

  return (
    <div className="card">
      <h3>記憶とデータ</h3>
      <p>
        秘書が自分について覚えていることです。覚えるのは、秘書に「〜を覚えておいて」と頼んだときだけです。
        覚えていることを見られるのは本人だけで、管理者にも見えません。
      </p>
      <label className="check">
        <input type="checkbox" checked={settings.memory.learning}
          onChange={(e) => onChange({ ...settings.memory, learning: e.target.checked })} />
        覚えることを許す（切ると、頼んでも覚えません）
      </label>
      <div className="field">
        <label>覚えない言葉（1 行に 1 つ）</label>
        <textarea rows={3} value={settings.memory.excludes.join('\n')}
          onChange={(e) => onChange({ ...settings.memory, excludes: e.target.value.split('\n') })} />
        <p className="muted small">ここに書いた言葉を含む指示は覚えません。秘書に「〜は覚えないで」と言っても増えます。</p>
      </div>
      <div className="row">
        <button className="btn" onClick={onSave}>保存する</button>
      </div>

      <h4>覚えていること（{items.length} 件）</h4>
      {items.length === 0 ? (
        <p className="muted small">まだ何も覚えていません。秘書に「〜を覚えておいて」とお伝えください。</p>
      ) : (
        <table className="table">
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.text}</td>
                <td className="num">
                  <button className="btn danger small"
                    onClick={() => void api.deleteMemory(m.id).then(load).then(() => setMsg('消しました')).catch((e) => setMsg(describeError(e)))}>
                    消す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items.length > 0 && (
        <div className="row">
          <button className="btn danger"
            onClick={() => {
              if (!confirm('覚えていることをすべて消しますか。元に戻せません。')) return;
              void api.clearMemories().then((r) => setMsg(`${r.removed} 件を消しました`)).then(load).catch((e) => setMsg(describeError(e)));
            }}>すべて消す</button>
        </div>
      )}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

export function orderAgents<T extends { id: string }>(agents: T[], order: string[]): T[] {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length + agents.findIndex((a) => a.id === id) : i;
  };
  return [...agents].sort((a, b) => rank(a.id) - rank(b.id));
}

/** 表示（画面の明るさ）。端末ごとに覚え、保存の操作は要らない（仕様書 第6.1.2節）。 */
function DisplaySettings() {
  const { choice, set } = useTheme();
  const options: [ThemeChoice, string][] = [['system', '端末の設定に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']];
  return (
    <div className="card">
      <h3>表示</h3>
      <p>画面の明るさを選びます。この端末（ブラウザ）にだけ効き、すぐに変わります。上部のボタンでも切り替えられます。</p>
      <div className="row">
        {options.map(([v, label]) => (
          <label key={v} className="check">
            <input type="radio" name="theme" checked={choice === v} onChange={() => set(v)} /> {label}
          </label>
        ))}
      </div>
      <p className="muted small">左のメニューは、上の端のボタンで狭く（アイコンだけに）できます。これもこの端末に覚えます。</p>
    </div>
  );
}

/**
 * Google 連携（仕様書 第6.5.2節）。本人が許可し、本人が取り消す。
 *
 * @remarks 「鍵」「トークン」という言葉を使わない。業務の言葉で、何を許可しているかを示す。
 */
function GoogleSettings() {
  const [g, setG] = useState<MyGoogle | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.myGoogle().then(setG).catch((e) => setMsg({ ok: false, text: describeError(e, '読み込めませんでした') }));
  useEffect(() => { void load(); }, []);
  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api.connectGoogle();
      location.href = url;
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, '接続を始められませんでした') });
      setBusy(false);
    }
  };
  const act = async <R,>(fn: () => Promise<R>, done: string | ((r: R) => string)) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: typeof done === 'function' ? done(r) : done }); await load(); }
    catch (e) { setMsg({ ok: false, text: describeError(e) }); }
    finally { setBusy(false); }
  };
  if (!g) return null;
  return (
    <div className="card">
      <h3>Google 連携</h3>
      {!g.available ? (
        <p>会社の管理者が Google との接続を設定すると、ここから接続できます。</p>
      ) : (
        <>
          <p>
            {g.connected
              ? <>接続しています（{g.googleEmail ?? 'アカウントを確かめられませんでした'}・{g.connectedAt ? new Date(g.connectedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : ''}）。</>
              : 'まだ接続していません。接続すると、業務があなたのメール・予定・ToDo などを扱えるようになります。'}
            あなたの Google アカウントで許可し、あなたのデータだけを扱います。
          </p>
          <ul className="grant-list">
            {g.scopes.map((s) => (
              <li key={s.scope} className={s.granted ? 'granted' : 'missing'}>
                <span aria-hidden="true">{s.granted ? '✓' : '・'}</span> {s.label}
                {!s.granted && g.connected && <span className="warn-inline small">（未許可）</span>}
              </li>
            ))}
          </ul>
          {g.needsReconnect && <p className="warn-msg small">使える業務が増えて、新しい許可が要ります。「接続し直す」を押してください。</p>}
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void connect()}>{g.connected ? '接続し直す' : 'Google と接続する'}</button>
            {g.connected && (
              <>
                <button className="btn ghost" disabled={busy} onClick={() => void act(async () => {
                  const r = await api.checkGoogle();
                  if (!r.ok) throw new Error(r.error ?? '確かめられませんでした');
                }, '許可の状況を確かめました')}>許可の状況を確かめる</button>
                <button className="btn danger" disabled={busy} onClick={() => void (async () => {
                  // 取り消す前に、止まる業務と飛ばす定時実行を示して確かめる（仕様書 第6.5.2.1節）
                  const impact = await api.googleImpact().catch(() => null);
                  const lines = ['Google との接続を取り消しますか。許可はまとめて取り消されます。メールや予定を扱う業務が使えなくなります。'];
                  if (impact === null) lines.push('', '止まる業務を確かめられませんでした。');
                  else {
                    if (impact.runs.length > 0) lines.push('', `次の ${impact.runs.length} 件の業務が止まります:`, ...impact.runs.map((r) => `・${r.agentName}（${statusLabel(r.status)}）`));
                    if (impact.schedules > 0) lines.push('', `定時実行 ${impact.schedules} 件は、接続し直すまで飛ばします（設定は残ります）。`);
                  }
                  lines.push('', '業務が読んだメールや文書の中身も、すぐに消します。一部の許可だけを外したいときは、取り消してから、必要な許可だけで接続し直してください。');
                  if (!confirm(lines.join('\n'))) return;
                  await act(() => api.disconnectGoogle(),
                    (r) => (r.stoppedRuns > 0 ? `接続を取り消し、業務 ${r.stoppedRuns} 件を止めました` : '接続を取り消しました'));
                })()}>接続を取り消す</button>
              </>
            )}
          </div>
        </>
      )}
      {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
    </div>
  );
}
