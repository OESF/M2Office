/**
 * @file 個人設定の画面（プロフィール・Google 連携・秘書・通知・表示・メニューの並び・セキュリティ・利用状況）。
 *
 * @see 仕様書 第6.5節 個人設定
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AVATAR_PRESETS, BRIEF_SECTIONS, WEEKLY_SECTIONS, VOICE_CHOICES, VOICE_STYLE_MAX, showsCaptions, type BriefSettings, type UserSettings } from '@m2office/shared';
import {
  api, describeError, type MyConnectionView,
  type AgentSummary, type ConversationView, type Me, type MemoryView,
  type MyGoogle, type PromotionView,
} from './api.js';
import { useTheme, type ThemeChoice } from './theme.js';
import { statusLabel } from './components.js';
import { SecretaryAvatar } from './nav.js';
import { KEY_BINDINGS, isTouchOnly, keyLabel } from './keys.js';
import { SaveButton } from './save.js';
import { playSample } from './voice.js';

/**
 * 個人設定（仕様書 第6.5節）。左ペインの最下部の利用者のカードの歯車のボタンから開く。
 *
 * @remarks
 * 昇華の履歴と会話ログ（第6.5.4節）は、昇華と会話ログの実装とあわせて追加する（Phase 2）。
 */
/**
 * 個人設定の区分（仕様書 第6.5.0節）。
 *
 * @remarks
 * **1 度に 1 区分だけを出す。** すべてを縦に並べると、目的の項目まで画面を延々と送ることになる。
 * 歯車を押したときの一覧も、この表から作る。
 */
export const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'プロフィール', hint: '名前・所属・利用状況' },
  { id: 'google', label: 'Google 連携', hint: 'メール・予定への接続' },
  // 会社に利用者ごとに許可する接続があるときだけ出す（仕様書 第6.5.9節。出し分けは画面の上側で行う）
  { id: 'services', label: 'サービスとの接続', hint: 'Slack などへの接続' },
  { id: 'secretary', label: '秘書', hint: '名前・呼ばれ方・声・アバター・朝のブリーフ' },
  { id: 'notifications', label: '通知', hint: '種類・時間帯・受け取り方' },
  { id: 'memory', label: '記憶とデータ', hint: '記憶・会話ログ・見え方' },
  { id: 'display', label: '表示', hint: '明るさ・メニューの並び' },
  { id: 'keys', label: 'キーボード', hint: 'ショートカットの一覧' },
  { id: 'security', label: 'セキュリティ', hint: 'ログイン中の端末' },
] as const;

/** 個人設定の区分の ID。 */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

/** 覚えておく先。最後に開いた区分から始める（仕様書 第6.5.0節）。 */
export const SETTINGS_SECTION_KEY = 'm2office.settings-section';

/** 覚えている区分。知らない値なら先頭に戻す。 */
export function rememberedSection(): SettingsSection {
  try {
    const v = localStorage.getItem(SETTINGS_SECTION_KEY);
    if (SETTINGS_SECTIONS.some((x) => x.id === v)) return v as SettingsSection;
  } catch { /* 覚えられなくても動く */ }
  return 'profile';
}

export function Settings({ me, agents, onChanged, section }: {
  /** メニューの並びと表示に使う業務（名刺も業務の 1 つとして入る。第6.1.1節）。 */
  me: Me; agents: { id: string; name: string }[]; onChanged: () => void;
  /** 出す区分（仕様書 第6.5.0節）。 */
  section: SettingsSection;
}) {
  const [s, setS] = useState<UserSettings | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
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

  // 1 度に 1 区分だけを出す（仕様書 第6.5.0節）
  const on = (id: SettingsSection) => section === id;

  return (
    <>
      {msg.error && <p className="error">{msg.error}</p>}

      {on('profile') && <>
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
        {/* 行程の出発地と朝のブリーフの天気に使う。本人の秘書だけが使い、管理者には見せない（仕様書 第6.5.1節） */}
        <div className="grid2">
          <div className="field"><label>自宅</label>
            <input value={s.profile.home} placeholder="例: 横浜市港北区・日吉駅" onChange={(e) => set('profile', { home: e.target.value })} /></div>
          <div className="field"><label>いつもの勤務地</label>
            <input value={s.profile.workplace} placeholder="空なら会社の住所" onChange={(e) => set('profile', { workplace: e.target.value })} /></div>
        </div>
        <div className="field"><label>メールアドレス</label>
          <input value={me.user.email} disabled /><span className="muted small">Google 側で管理しているため変更できません</span></div>
        <SaveButton run={async () => {
          if (name !== me.user.displayName) await api.saveDisplayName(name);
          await api.saveMySettings('profile', s.profile);
          onChanged();
        }} />
      </div>
      </>}

      {on('google') && <GoogleSettings />}

      {on('services') && <ServicesSettings />}

      {on('secretary') && (
      <>
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
          {/* 音声で話しかけたときの答え方（仕様書 第6.5.3節）。書いた依頼には、もともと声を使わない */}
          <div className="field"><label>音声で話したとき</label>
            <label className="check">
              <input type="checkbox" checked={s.secretary.speak}
                onChange={(e) => set('secretary', { speak: e.target.checked })} />
              声で答える
            </label>
            {/* 声で答えないときは字幕を消せない。声も文字も無いと答えが伝わらない */}
            <label className="check">
              <input type="checkbox" checked={showsCaptions(s.secretary)} disabled={!s.secretary.speak}
                onChange={(e) => set('secretary', { captions: e.target.checked })} />
              会話を文字で出す
            </label>
          </div>
          <div className="field"><label>声</label>
            <select value={s.secretary.voice} disabled={!s.secretary.speak}
              onChange={(e) => set('secretary', { voice: e.target.value })}>
              <option value="">おまかせ</option>
              {VOICE_CHOICES.map((v) => <option key={v.name} value={v.name}>{v.name}（{v.note}）</option>)}
            </select>
            <span className="muted small">（）内は声の印象の目安です</span>
          </div>
        </div>
        {/* 話し方の指示は幅いっぱいに取り、書いたらすぐ横の「声を試す」で確かめられるようにする（第10.5.8節） */}
        <div className="field"><label>話し方の指示</label>
          <VoiceTest secretary={s.secretary}>
            <input value={s.secretary.voiceStyle} disabled={!s.secretary.speak}
              placeholder="例: 関西弁で話して" maxLength={VOICE_STYLE_MAX}
              onChange={(e) => set('secretary', { voiceStyle: e.target.value.slice(0, VOICE_STYLE_MAX) })} />
          </VoiceTest>
        </div>
        <div className="field">
          <label>アバター</label>
          <div className="avatar-picker">
            <button type="button" title="出さない"
              className={`avatar-choice${s.secretary.avatar === '' ? ' on' : ''}`}
              onClick={() => set('secretary', { avatar: '' })}>
              <SecretaryAvatar avatar="" />
            </button>
            {AVATAR_PRESETS.map((a) => (
              <button key={a.id} type="button" title={a.label}
                className={`avatar-choice${s.secretary.avatar === `preset:${a.id}` ? ' on' : ''}`}
                onClick={() => set('secretary', { avatar: `preset:${a.id}` })}>
                <SecretaryAvatar avatar={`preset:${a.id}`} />
              </button>
            ))}
            {s.secretary.avatar.startsWith('file:') && (
              <span className="avatar-choice on" title="上げた画像">
                <SecretaryAvatar avatar={s.secretary.avatar} />
              </span>
            )}
          </div>
          <input ref={avatarInput} type="file" accept="image/png,image/jpeg" hidden
            onChange={async (e) => {
              const chosen = e.target.files?.[0];
              if (!chosen) return;
              // 会社のロゴと同じ仕組み。上げた本人のファイルとして保存される
              const up = await api.uploadFile(chosen);
              set('secretary', { avatar: `file:${up.id}` });
              e.target.value = '';
            }} />
          <button className="btn ghost small" type="button" onClick={() => avatarInput.current?.click()}>
            画像を上げる（PNG か JPEG）
          </button>
        </div>
        <SaveButton run={() => api.saveMySettings('secretary', s.secretary).then(onChanged)} />
      </div>
      <BriefCard brief={s.brief} onSaved={(brief) => setS({ ...s, brief })} />
      </>
      )}

      {on('notifications') && <>
      <div className="card">
        <h3>通知</h3>
        <p className="muted small">切った種類は画面内にも届きません</p>
        {([['brief', 'ブリーフ（朝・週次）'], ['run', '実行の完了'], ['approval', '承認の依頼'], ['failure', '失敗'],
          ...(me.inventory ? [['inventory', '在庫（残りわずか・無くなる見込み・使用期限）']] as const : []),
          ...(me.hr || me.hrSelf ? [['attendance', '給与・勤怠（給与明細・打刻の直し・有給・時間外の上限・有給の取得義務）']] as const : []),
          ...(me.signage ? [['signage', 'サイネージ（画面がつながっていない）']] as const : [])] as const).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={s.notifications.kinds[k]}
              onChange={(e) => set('notifications', { kinds: { ...s.notifications.kinds, [k]: e.target.checked } })} />
            {label}
          </label>
        ))}
        <h4>通知しない時間帯</h4>
        <p className="muted small">Chat だけ、明けてから送ります</p>
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
        <p className="muted small">Chat には題名とリンクのみ（本文なし）。Chat への送信は準備中で、まだ届きません</p>
        <label className="check">
          <input type="checkbox" checked={s.notifications.channels.chat}
            onChange={(e) => set('notifications', { channels: { chat: e.target.checked } })} />
          Chat（本人への個別メッセージ）
        </label>
        <div style={{ marginTop: 'calc(12px * var(--space-scale))' }}>
          <SaveButton run={() => api.saveMySettings('notifications', s.notifications).then(onChanged)} />
        </div>
      </div>
      </>}

      {on('memory') && <>
      <PresenceNotice />

      <MemorySettings settings={s} onChange={(v) => set('memory', v)}
        onSave={() => api.saveMySettings('memory', { ...s.memory }).then(onChanged)} />

      <ConversationSettings settings={s} onChange={(v) => set('memory', v)}
        onSave={() => api.saveMySettings('memory', { ...s.memory }).then(onChanged)} />
      </>}

      {on('keys') && <KeyboardSettings />}

      {on('display') && <>
      <DisplaySettings />
      <div className="card">
        <h3>メニューの並び</h3>
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
        <div style={{ marginTop: 'calc(12px * var(--space-scale))' }}>
          <SaveButton run={() => api.saveMySettings('menu', { ...s.menu, order: ordered.map((a) => a.id) }).then(onChanged)} />
        </div>
      </div>
      </>}

      {on('security') && (
      <div className="card">
        <h3>セキュリティ</h3>
        <p className="muted small">2 段階認証は Google 側で設定</p>
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
            {sessions.length === 0 && <tr><td colSpan={4} className="muted">表示できる端末はありません</td></tr>}
          </tbody>
        </table>
      </div>
      )}
    </>
  );
}

/**
 * ショートカットの一覧（仕様書 第6.11節）。
 *
 * @remarks
 * **割り当ての表（`keys.ts`）から作る。** ここに書き写すと、一覧と実際がずれる。
 * 外付けのキーボードが無さそうな端末では、割り当ての代わりにその旨を出す。
 */
function KeyboardSettings() {
  const groups = ['秘書', '画面', '業務'] as const;
  return (
    <div className="card">
      <h3>キーボード</h3>
      {isTouchOnly() ? (
        <p className="muted">キーボードが見つかりません</p>
      ) : groups.map((g) => (
        <div key={g}>
          <h4>{g}</h4>
          <table className="table">
            <tbody>
              {KEY_BINDINGS.filter((b) => b.group === g).map((b) => (
                <tr key={b.combo}>
                  <td style={{ width: '9em' }}><kbd>{keyLabel(b.combo)}</kbd></td>
                  <td>{b.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/**
 * 本人の並び順で業務を並べる。並び順に無い業務は後ろに既定の順で並べる。
 *
 * @param agents 使える業務（管理者が有効にしたもの）
 * @param order 本人が決めた並び順
 */
/**
 * 会話ログ（仕様書 第11.9.4.1節）。自分のやり取りを探して消せるようにする。
 *
 * @remarks 読めるのは本人だけである（不変則 I-10）。逐語は 4 週で消える。
 */
function ConversationSettings({ settings, onChange, onSave }: {
  settings: UserSettings;
  onChange: (v: UserSettings['memory']) => void;
  /** 保存の処理。終わるのを待って、結果をボタンの横に出す（第6.10.4.2節）。 */
  onSave: () => Promise<unknown>;
}) {
  const [items, setItems] = useState<ConversationView[]>([]);
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = (q = query) => api.myConversations(q)
    .then((r) => setItems(r.items)).catch((e) => setMsg(describeError(e)));
  useEffect(() => { void load(''); }, []);

  return (
    <div className="card">
      <h3>会話ログ</h3>
      <p className="muted small">本人のみ閲覧可・4 週で自動削除</p>
      <label className="check">
        <input type="checkbox" checked={settings.memory.keepConversations}
          onChange={(e) => onChange({ ...settings.memory, keepConversations: e.target.checked })} />
        会話を残す
      </label>
      <div className="row">
        <SaveButton run={onSave} />
      </div>

      <div className="row">
        <input value={query} placeholder="言葉で探す" onChange={(e) => setQuery(e.target.value)} />
        <button className="btn ghost" onClick={() => void load()}>探す</button>
        {items.length > 0 && (
          <button className="btn danger" onClick={() => {
            if (!confirm('会話ログをすべて削除しますか。元に戻せません。')) return;
            void api.clearConversations()
              .then((r) => setMsg(`${r.removed} 件を削除しました`))
              .then(() => load(''))
              .catch((e) => setMsg(describeError(e)));
          }}>すべて削除</button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="muted small">会話はありません。</p>
      ) : (
        <table className="table">
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <div>{c.message}</div>
                  <div className="muted small">{c.reply.slice(0, 120)}{c.reply.length > 120 ? '…' : ''}</div>
                  <div className="muted small">{new Date(c.createdAt).toLocaleString('ja-JP')}</div>
                </td>
                <td className="num">
                  <button className="btn danger small"
                    onClick={() => void api.deleteConversation(c.id).then(() => load()).catch((e) => setMsg(describeError(e)))}>
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

/**
 * 自分の記憶から、秘書が会社の知識にしたもの（仕様書 第6.5.4節・第11.3節、ADR-0028）。
 *
 * @remarks 判断は秘書が行う。ここは見るだけの場所で、選ばせる操作は置かない。違っていれば秘書に話せば直る（第11.5.3節）。
 */
function PromotionHistory() {
  const [items, setItems] = useState<PromotionView[]>([]);
  useEffect(() => { api.myPromotions().then((r) => setItems(r.items.filter((p) => p.status === 'approved'))).catch(() => setItems([])); }, []);
  if (items.length === 0) return null;
  return (
    <>
      <h4>会社の知識になったこと（{items.length} 件）</h4>
      <ul className="plain-list">
        {items.map((p) => <li key={p.id}>{p.text}</li>)}
      </ul>
    </>
  );
}

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
        {/* 本人と秘書は 1 組で出る（仕様書 第6.7.4.4節）。個人名の会社だけ */}
        {data.granularity === 'names' && <>あなたの秘書は<strong>「{data.presence.secretary.detail}」</strong>と表示されています。</>}
      </p>
      {/* 何が見えて何が見えないかは、知りたい人が開く（原則 u11） */}
      <details className="small">
        <summary className="muted">表示されるもの・されないもの</summary>
        <p className="muted small">表示されるもの: {data.shown.join('、')}</p>
        <p className="muted small">表示されないもの: {data.hidden.join('、')}。状態の履歴は残しません</p>
      </details>
    </div>
  );
}

/** しまった理由の言い方（仕様書 第11.11.4節）。 */
const ARCHIVE_REASON: Record<string, string> = { merged: 'まとめた', stale: '新しい事実で古くなった', unused: '半年使われていない' };

/**
 * 記憶とデータ（仕様書 第6.5.4節）。秘書が自分について覚えていることを、見たいときに見る場所。
 *
 * @remarks
 * 秘書は会話から自分で覚え、違っていれば本人が会話で指摘すると自分で直す（第11.5.2節・第11.5.3節、ADR-0028）。
 * ここで 1 件ずつ確かめる必要はない。確認を求める印は出さない。直す・消すは、画面でしたい人のために残す。
 */
function MemorySettings({ settings, onChange, onSave }: {
  settings: UserSettings;
  onChange: (v: UserSettings['memory']) => void;
  /** 保存の処理。終わるのを待って、結果をボタンの横に出す（第6.10.4.2節）。 */
  onSave: () => Promise<unknown>;
}) {
  const [items, setItems] = useState<MemoryView[]>([]);
  // 整理でしまったもの（仕様書 第11.11.4節）。見たいときに開く
  const [archived, setArchived] = useState<MemoryView[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // 直している 1 件（ID と書きかけの文）
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const load = () => api.myMemories().then((r) => setItems(r.items)).catch((e) => setMsg(describeError(e)));
  useEffect(() => { void load(); }, []);

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api.updateMemory(editing.id, editing.text);
      setEditing(null);
      setMsg('直しました');
      await load();
    } catch (e) {
      setMsg(describeError(e));
    }
  };

  return (
    <div className="card">
      <h3>記憶とデータ</h3>
      <p className="muted small">違っていれば、秘書に「それは違う、〇〇だよ」と話すだけで直ります。</p>
      <label className="check">
        <input type="checkbox" checked={settings.memory.learning}
          onChange={(e) => onChange({ ...settings.memory, learning: e.target.checked })} />
        覚えることを許す
      </label>
      <div className="field">
        <label>覚えない言葉（1 行に 1 つ）</label>
        <textarea rows={2} value={settings.memory.excludes.join('\n')}
          onChange={(e) => onChange({ ...settings.memory, excludes: e.target.value.split('\n') })} />
      </div>
      <div className="row">
        <SaveButton run={onSave} />
      </div>

      <h4>覚えていること（{items.length} 件）</h4>
      {items.length === 0 ? (
        <p className="muted small">まだ何も覚えていません。</p>
      ) : (
        <table className="table">
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>
                  {editing?.id === m.id ? (
                    <textarea rows={2} value={editing.text} aria-label="覚えていることを直す"
                      onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                  ) : m.text}
                </td>
                <td className="num">
                  {editing?.id === m.id ? (
                    <>
                      <button className="btn small" disabled={!editing.text.trim()} onClick={() => void saveEdit()}>保存</button>{' '}
                      <button className="btn ghost small" onClick={() => setEditing(null)}>キャンセル</button>
                    </>
                  ) : (
                    <>
                      <button className="btn ghost small" onClick={() => setEditing({ id: m.id, text: m.text })}>直す</button>{' '}
                      <button className="btn danger small"
                        onClick={() => void api.deleteMemory(m.id).then(load).then(() => setMsg('削除しました')).catch((e) => setMsg(describeError(e)))}>
                        削除
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items.length > 0 && (
        <div className="row">
          <button className="btn danger ghost small"
            onClick={() => {
              if (!confirm('覚えていることをすべて削除しますか。元に戻せません。')) return;
              void api.clearMemories().then((r) => setMsg(`${r.removed} 件を削除しました`)).then(load).catch((e) => setMsg(describeError(e)));
            }}>すべて削除</button>
        </div>
      )}
      <button className="link-btn small" onClick={() => {
        if (archived) { setArchived(null); return; }
        void api.myArchivedMemories().then((r) => setArchived(r.items)).catch((e) => setMsg(describeError(e)));
      }}>{archived ? 'しまったものを閉じる' : 'しまったもの'}</button>
      {archived && (archived.length === 0 ? <p className="muted small">ありません。</p> : (
        <table className="table">
          <tbody>
            {archived.map((m) => (
              <tr key={m.id}>
                <td>{m.text}</td>
                <td className="muted small">{m.archivedAt?.slice(0, 10)}・{ARCHIVE_REASON[m.archiveReason ?? ''] ?? ''}</td>
                <td className="num">
                  <button className="btn ghost small" onClick={() => void api.restoreMemory(m.id)
                    .then(() => Promise.all([load(), api.myArchivedMemories().then((r) => setArchived(r.items))]))
                    .then(() => setMsg('戻しました')).catch((e) => setMsg(describeError(e)))}>戻す</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {msg && <p className="muted small">{msg}</p>}
      <PromotionHistory />
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
      <p className="muted small">この端末にだけ効きます</p>
      <div className="row">
        {options.map(([v, label]) => (
          <label key={v} className="check">
            <input type="radio" name="theme" checked={choice === v} onChange={() => set(v)} /> {label}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * 個人設定「サービスとの接続」（仕様書 第6.5.9節・第12.11.6.3節）。本人が許可し、本人が取り消す。
 *
 * @remarks
 * 「鍵」「トークン」と言わない（原則 u1）。取り消す前に、使えなくなる業務と止まる定時実行を示す（第12.11.6.5節）。
 */
function ServicesSettings() {
  const [items, setItems] = useState<MyConnectionView[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.myConnections().then((r) => setItems(r.items)).catch((e) => setMsg({ ok: false, text: describeError(e, '読み込めませんでした') }));
  useEffect(() => { void load(); }, []);

  const connect = async (c: MyConnectionView) => {
    setBusy(c.id);
    try {
      location.href = (await api.connectConnection(c.id)).url;
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, '接続を始められませんでした') });
      setBusy(null);
    }
  };

  const disconnect = async (c: MyConnectionView) => {
    const impact = await api.connectionImpact(c.id).catch(() => null);
    const lines = [`${c.name}との接続を取り消しますか。`];
    if (impact === null) lines.push('', '止まる業務を確かめられませんでした。');
    else {
      if (impact.agents.length > 0) lines.push('', '次の業務が使えなくなります:', ...impact.agents.map((a) => `・${a.name}`));
      if (impact.runs > 0) lines.push('', `動いている業務 ${impact.runs} 件を止めます。`);
      if (impact.schedules > 0) lines.push('', `定時実行 ${impact.schedules} 件は、接続し直すまで飛ばします（設定は残ります）。`);
    }
    if (!confirm(lines.join('\n'))) return;
    setBusy(c.id);
    setMsg(null);
    try {
      const r = await api.disconnectConnection(c.id);
      setMsg({ ok: true, text: r.stopped > 0 ? `接続を取り消し、業務 ${r.stopped} 件を止めました` : '接続を取り消しました' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!items) return msg ? <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p> : null;
  return (
    <>
      {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
      {items.length === 0 && <p className="muted">接続できるサービスはありません</p>}
      {items.map((c) => (
        <div key={c.id} className="card">
          <h3>{c.name}</h3>
          {!c.available ? <p className="muted">管理者の設定待ちです</p> : (
            <>
              <p>
                {c.connected
                  ? <>接続しています（{c.account || 'アカウントを確かめられませんでした'}{c.connectedAt ? `・${new Date(c.connectedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` : ''}）</>
                  : '未接続です'}
              </p>
              {c.usedBy.length > 0 && <p className="muted small">使う業務: {c.usedBy.map((a) => a.name).join('、')}</p>}
              {c.needsReconnect && <p className="warn-msg small">使える業務が増えて、新しい許可が要ります。「接続し直す」を押してください。</p>}
              <div className="row">
                <button className="btn" disabled={busy === c.id} onClick={() => void connect(c)}>
                  {c.connected ? '接続し直す' : `${c.name}と接続する`}
                </button>
                {c.connected && <button className="btn danger" disabled={busy === c.id} onClick={() => void disconnect(c)}>接続を取り消す</button>}
              </div>
            </>
          )}
        </div>
      ))}
    </>
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
        <p className="muted">管理者の設定待ちです</p>
      ) : (
        <>
          <p>
            {g.connected
              ? <>接続しています（{g.googleEmail ?? 'アカウントを確かめられませんでした'}・{g.connectedAt ? new Date(g.connectedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : ''}）。</>
              : '未接続です'}
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

/**
 * 声を試す（仕様書 第10.5.8節）。いま画面に入っている秘書の設定で、秘書に名乗りの挨拶を話させる。
 *
 * @remarks
 * 保存の前に試せる。試しても保存はしない。「声で答える」を切っている間は押せない（声を選ぶ欄と同じ）。
 * 話した文字も横に出す。音が聞こえない環境でも、設定が届いたかを確かめられるように。
 */
function VoiceTest({ secretary, children }: {
  secretary: UserSettings['secretary'];
  /** ボタンの左に並べる入力欄（話し方の指示）。 */
  children: ReactNode;
}) {
  const [state, setState] = useState<'idle' | 'preparing' | 'speaking'>('idle');
  const [said, setSaid] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState('');

  const run = async () => {
    setState('preparing');
    setSaid('');
    setNotes([]);
    setError('');
    try {
      const r = await api.voiceTest(secretary);
      setSaid(r.text);
      setNotes(r.notes);
      setState('speaking');
      if (r.audio) await playSample(r.audio, r.sampleRate);
    } catch (err) {
      setError(describeError(err, '声を試せませんでした'));
    } finally {
      setState('idle');
    }
  };

  return (
    <>
      <div className="voice-test">
        {children}
        <button type="button" className="btn ghost" disabled={!secretary.speak || state !== 'idle'} onClick={() => void run()}>
          {state === 'preparing' ? '準備しています…' : state === 'speaking' ? '話しています…' : '声を試す'}
        </button>
      </div>
      {(said || notes.length > 0 || error) && (
        <div className="voice-test-result">
          {said && <span className="muted small">「{said}」</span>}
          {notes.map((n) => <span key={n} className="muted small">{n}</span>)}
          {error && <span className="error small">{error}</span>}
        </div>
      )}
    </>
  );
}

/**
 * ブリーフ（朝・週）の中身（仕様書 第6.5.3.1節・第9.5.5.1.1節）。秘書が覚えた関心の分野と、朝と週それぞれで外した項目を見せる。
 *
 * @remarks
 * **足すのは秘書への会話で行う。** ここでは消す・戻すだけにする（人に一覧を作らせない。ADR-0028）。
 * 押したらすぐ保存する。説明の文は常に出さない（原則 u11）。
 */
function BriefCard({ brief, onSaved }: { brief: BriefSettings; onSaved: (b: BriefSettings) => void }) {
  const [error, setError] = useState<string | null>(null);
  const save = async (next: BriefSettings) => {
    setError(null);
    try {
      await api.saveMySettings('brief', next);
      onSaved(next);
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    }
  };
  const label = (id: string) => BRIEF_SECTIONS.find((x) => x.id === id)?.label ?? id;
  const weeklyLabel = (id: string) => WEEKLY_SECTIONS.find((x) => x.id === id)?.label ?? id;
  const weeklyOmit = brief.weeklyOmit ?? [];
  return (
    <div className="card">
      <h3>ブリーフ（朝・週）</h3>
      {error && <p className="error">{error}</p>}
      <h4>関心の分野</h4>
      {brief.topics.length === 0
        ? <p className="muted small">一般のニュースだけをお伝えしています</p>
        : (
          <ul className="brief-list">
            {brief.topics.map((t) => (
              <li key={t.label} className="row">
                <strong>{t.label}</strong>
                <span className="muted small">{t.query}</span>
                <button className="btn ghost small" type="button" title={`「${t.label}」を外す`}
                  onClick={() => void save({ ...brief, topics: brief.topics.filter((x) => x.label !== t.label) })}>外す</button>
              </li>
            ))}
          </ul>
        )}
      {brief.omit.length > 0 && <>
        <h4>朝のブリーフで外した項目</h4>
        <ul className="brief-list">
          {brief.omit.map((id) => (
            <li key={id} className="row">
              <span className="grow">{label(id)}</span>
              <button className="btn ghost small" type="button"
                onClick={() => void save({ ...brief, omit: brief.omit.filter((x) => x !== id) })}>戻す</button>
            </li>
          ))}
        </ul>
      </>}
      {weeklyOmit.length > 0 && <>
        <h4>週のブリーフで外した項目</h4>
        <ul className="brief-list">
          {weeklyOmit.map((id) => (
            <li key={id} className="row">
              <span className="grow">{weeklyLabel(id)}</span>
              <button className="btn ghost small" type="button"
                onClick={() => void save({ ...brief, weeklyOmit: weeklyOmit.filter((x) => x !== id) })}>戻す</button>
            </li>
          ))}
        </ul>
      </>}
    </div>
  );
}
