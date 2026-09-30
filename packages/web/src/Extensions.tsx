/**
 * @file 管理者ページ「拡張機能」。ブラウザの拡張機能と同じ感覚で、取り込み・導入・スイッチ・削除を行う。
 *
 * 導入済みの拡張機能はカードで並べ、スイッチで有効と無効を切り替える。
 * 追加は「配布元から追加」（公式の配布元と、取り込み済みのファイル）と「ファイルから追加」（SKILL.md・`.zip`・`.m2ext`）の 2 つ。
 * 導入の前に、業務エージェント・コネクタ・ツールごとに、何をするかと危険度を示して同意を得る。
 *
 * @see 仕様書 第12.10.5節 画面（管理者ページ「拡張機能」）
 */

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { JinglePlayer } from './signage-audio.js';
import { api, ApiError, describeError, type AccessOptions, type ExtensionView, type HrProposalField, type ScopeValue } from './api.js';
import {
  INVENTORY_FEATURES, SIGNAGE_DEFAULT_COLOR, SIGNAGE_JINGLES, type HrSettings, type InventoryBookingSource, type InventoryFeature, type InventorySettings,
  type SignageSettings, type SignageSound, type SignageSource,
} from '@m2office/shared';
import { HelpTip, Markdown } from './help.js';
import { ScopeEditor, ScopeField, useAccessOptions } from './Scope.js';

/** 画面の下に出す知らせ。 */
type Notice = { kind: 'ok' | 'error'; text: string; problems?: string[] } | null;

/**
 * 拡張機能の画面。
 *
 * @param focus 詳細を開いて見せる拡張機能の ID（「接続 › コネクタ」から移ったとき。仕様書 第6.6.3.0節）
 */
export function ExtensionSettings({ focus = null }: { focus?: string | null } = {}) {
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
  const importFile = async (file: File) => {
    // スキルの形式で除いたファイル（プログラムなど）があれば、取り込めたことと一緒に知らせる（仕様書 第12.12.4節）
    let notes: string[] = [];
    const done = `「${file.name}」を取り込みました。内容を確認して導入してください`;
    await act(async () => {
      const res = await api.admin.importExtension(file);
      notes = res.notices ?? [];
      if (res.item) {
        setAdding(false);
        setConsenting(res.item.installed && !res.item.needsReconsent ? null : res.item.id);
      }
    }, done);
    if (notes.length > 0) setNotice({ kind: 'ok', text: done, problems: notes });
  };

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
            ref={fileInput} type="file" accept=".m2ext,.zip,.skill,.md" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }}
          />
        </div>
      </div>
      <p className="muted small">SKILL.md・.zip・.m2ext はドラッグでも追加できます</p>

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
        <p className="muted">まだありません</p>
      )}
      {installed.map((x) => (
        <InstalledCard
          key={x.id} item={x} busy={busy} focused={x.id === focus}
          options={access.options} onChanged={() => void Promise.all([load(), access.reload()])}
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
          <span className={x.origin === 'private' ? 'badge warn' : 'badge'}>{x.originText}</span>
        </div>
        <div className="muted small">提供: {x.publisher.name}{parts.length > 0 && `・${parts.join('・')}`}</div>
      </div>
    </div>
  );
}

/** 導入済みの拡張機能のカード。スイッチ・詳細・削除。 */
function InstalledCard({ item: x, busy, focused = false, options, onChanged, onToggle, onReconsent, onDelete }: {
  item: ExtensionView; busy: boolean;
  /** 詳細を開いた状態で出し、画面の中へ送る（「接続 › コネクタ」から移ったとき） */
  focused?: boolean;
  options: AccessOptions | null;
  /** 利用範囲の保存と、ツールの入り切りのあとに呼ぶ。一覧を読み直す */
  onChanged: () => void;
  onToggle: (on: boolean) => void; onReconsent: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(focused);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    card.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focused]);
  const on = x.enabled && !x.needsReconsent;
  return (
    <div ref={card} className={on ? 'card ext-card' : 'card ext-card off'}>
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
      {/* 人事・給与は利用範囲ではなく人事区画で決まる（仕様書 第30.2節）。区画の画面で人を足す */}
      {options && !x.hr && (
        <div className="small">利用できる人: <ScopeField target={x.id} options={options} onSaved={onChanged} /></div>
      )}
      {x.hr && <div className="small">利用できる人: 権限区画「hr」の人</div>}
      {x.cards && (
        // 名刺管理の会社の設定（仕様書 第27.7節）。すぐに反映する
        <label className="small check">
          <input type="checkbox" checked={x.cards.defaultScope === 'personal'} disabled={busy}
            onChange={(e) => void api.admin.setCardsDefaultScope(e.target.checked ? 'personal' : 'company').then(onChanged)} />
          取り込んだ名刺を、既定で自分だけにする
        </label>
      )}
      {x.inventory && on && <InventoryFields settings={x.inventory} busy={busy} onChanged={onChanged} />}
      {x.hr && on && <HrFields settings={x.hr} busy={busy} onChanged={onChanged} />}
      {x.signage && on && <SignageFields settings={x.signage} busy={busy} onChanged={onChanged} />}
      <div className="row small">
        <button className="link" onClick={() => setOpen(!open)}>{open ? '詳細を閉じる' : '詳細'}</button>
        {/* 内蔵の拡張は削除しない。スイッチで切る（データは消えない。第12.13節） */}
        {x.origin !== 'builtin' && <button className="link danger" disabled={busy} onClick={onDelete}>削除</button>}
      </div>
      {open && <Details item={x} onChanged={onChanged} />}
    </div>
  );
}

/**
 * 詳細。業務エージェント、同梱の接続、説明。
 *
 * @remarks 接続の道具の危険度と入り切りは「接続 › コネクタ（MCP）」で決める（会社の接続。仕様書 第12.11.0節）
 */
function Details({ item: x }: { item: ExtensionView; onChanged: () => void }) {
  return (
    <div className="ext-details">
      {x.agents.length > 0 && (
        <>
          <h4>業務エージェント</h4>
          <ul className="small">{x.agents.map((a) => <li key={a.id}><strong>{a.name}</strong>: {a.summary}</li>)}</ul>
        </>
      )}
      {x.connectors.length > 0 && (
        <>
          <h4>同梱の接続</h4>
          <ul className="small">
            {x.connectors.map((c) => <li key={c.id}>{c.name}（<code>{c.id}</code>）: <code>{c.url}</code></li>)}
          </ul>
          <p className="muted small">導入すると会社の接続として登録されます。道具の危険度と入り切りは「接続 › コネクタ（MCP）」で決めます。</p>
        </>
      )}
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

/**
 * 画面で入り切りできる在庫管理の機能。Web への公開は、その段を作ったときに足す（仕様書 第24.4節）。
 *
 * @remarks 働かない機能のスイッチを出さない（入れても何も起きないと、管理者を惑わせるため）
 */
const INVENTORY_READY: InventoryFeature[] = ['lots', 'units', 'order', 'reserve'];

/**
 * 在庫管理の会社の設定（仕様書 第29.4節・第29.4.1節）。機能の入り切りと、残りわずか・仕入れの日数の既定。すぐに反映する。
 *
 * @remarks 説明文は出さない（原則 u11）。何の機能かは秘書に聞けばよい
 */
/** 店頭サイネージの会社の設定（画像を出す秒数・店の色。仕様書 第31.4節）。画面の数と容量の上限は全社共通の決まり。 */
function SignageFields({ settings, busy, onChanged }: { settings: SignageSettings; busy: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [sounds, setSounds] = useState<SignageSound[]>([]);
  const [sources, setSources] = useState<SignageSource[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState('');
  const soundFile = useRef<HTMLInputElement>(null);
  const player = useRef<JinglePlayer | null>(null);
  const reload = () => {
    api.admin.signageSources().then((r) => setSources(r.sources)).catch(() => undefined);
    api.signage.sounds().then((r) => setSounds(r.sounds)).catch(() => undefined);
  };
  useEffect(reload, []);
  const fail = (e: unknown, text: string) => setError(describeError(e, text));
  const save = (patch: Partial<Omit<SignageSettings, 'enabled'>>) =>
    void api.admin.setSignageSettings(patch).then(() => { setError(null); onChanged(); }).catch((e) => fail(e, '保存できませんでした'));
  /** 選んだ M2Office の音を手元で鳴らす（選ぶと鳴る。試す専用のボタンを置かない）。 */
  const preview = async (id: string) => {
    if (!SIGNAGE_JINGLES.some((j) => j.id === id)) return;
    if (!player.current) player.current = new JinglePlayer();
    await player.current.unlock();
    void player.current.play(id, 70);
  };
  const addSound = async (f: File) => {
    // 長さは手元で確かめる（5 秒まで）
    const url = URL.createObjectURL(f);
    const ms = await new Promise<number>((res) => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(a.duration * 1000); a.onerror = () => res(0); a.src = url; });
    URL.revokeObjectURL(url);
    api.admin.addSignageSound(f, f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 20), ms).then(() => { setError(null); reload(); }).catch((e) => fail(e, '入れられませんでした'));
  };
  return (
    <div className="small ext-inventory">
      <div className="row wrap">
        <label>画像を出す秒数 <input key={settings.imageSeconds} type="number" min={3} max={120} className="num" defaultValue={settings.imageSeconds} disabled={busy}
          onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n !== settings.imageSeconds) save({ imageSeconds: n }); }} /> 秒</label>
        <label>店の色 <input type="color" value={settings.color ?? SIGNAGE_DEFAULT_COLOR} disabled={busy} onChange={(e) => save({ color: e.target.value })} aria-label="店の色" /></label>
        {settings.color && <button className="link" disabled={busy} onClick={() => save({ color: null })}>元の色に戻す</button>}
      </div>
      <div className="row wrap">
        <label>割り込みを出す秒数 <input key={settings.interruptSeconds} type="number" min={5} max={60} className="num" defaultValue={settings.interruptSeconds} disabled={busy}
          onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n !== settings.interruptSeconds) save({ interruptSeconds: n }); }} /> 秒</label>
        <label className="check"><input type="checkbox" checked={settings.chime} disabled={busy} onChange={(e) => save({ chime: e.target.checked })} /> ジングル</label>
        <select value={settings.jingle} disabled={busy} aria-label="既定のジングル" onChange={(e) => { save({ jingle: e.target.value }); void preview(e.target.value); }}>
          {SIGNAGE_JINGLES.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
          {sounds.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <div className="row wrap">
        {sounds.map((x) => (
          <span key={x.id} className="ext-chip">{x.name}（{(x.durationMs / 1000).toFixed(1)} 秒）
            <button className="link" onClick={() => void api.admin.deleteSignageSound(x.id).then(() => { reload(); onChanged(); }).catch((e) => fail(e, '削除できませんでした'))} aria-label={`${x.name}を削除`}>×</button>
          </span>
        ))}
        <button className="btn ghost small" onClick={() => soundFile.current?.click()}>会社の音を入れる</button>
        <input ref={soundFile} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addSound(f); }} />
      </div>
      <div className="row wrap">
        <label className="ext-signage-template">番号と場所の呼び出し <input key={settings.callTemplate} defaultValue={settings.callTemplate} disabled={busy} aria-label="番号と場所の呼び出しの言い回し"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== settings.callTemplate) save({ callTemplate: v }); }} /></label>
        <label className="ext-signage-template">番号だけの呼び出し <input key={settings.callTemplateNoPlace} defaultValue={settings.callTemplateNoPlace} disabled={busy} aria-label="番号だけの呼び出しの言い回し"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== settings.callTemplateNoPlace) save({ callTemplateNoPlace: v }); }} /></label>
      </div>
      <div className="ext-signage-sources">
        {sources.map((x) => (
          <div key={x.id} className="row wrap">
            <strong>{x.name}</strong>
            <span className={`badge ${x.status === 'active' ? 'ok' : ''}`}>{x.status === 'active' ? '動いている' : '止めている'}</span>
            <span className="muted">{x.lastReceivedAt ? `最後 ${new Date(x.lastReceivedAt).toLocaleString('ja-JP')}` : 'まだ受け取っていない'}
              {x.stats.day ? `・今日 ${x.stats.accepted} 件${Object.values(x.stats.rejected).reduce((a, n) => a + n, 0) ? `（断った ${Object.values(x.stats.rejected).reduce((a, n) => a + n, 0)} 件）` : ''}` : ''}</span>
            {(x.stats.rejected['unreadable'] ?? 0) > 0 && <span className="badge warn">読めない呼び出しが届いています</span>}
            <button className="link" onClick={() => void api.admin.setSignageSourceStatus(x.id, x.status === 'active' ? 'stopped' : 'active').then(reload).catch((e) => fail(e, '変えられませんでした'))}>{x.status === 'active' ? '止める' : '動かす'}</button>
            <button className="link" onClick={() => void api.admin.resetSignageSourceMapping(x.id).then(reload).catch((e) => fail(e, '変えられませんでした'))}>推測し直す</button>
          </div>
        ))}
        <div className="row wrap">
          <input placeholder="受付のシステムの名前" value={sourceName} maxLength={40} onChange={(e) => setSourceName(e.target.value)} aria-label="呼び出しの受け口の名前" />
          <button className="btn ghost small" disabled={!sourceName.trim()} onClick={() => void api.admin.createSignageSource(sourceName.trim()).then((r) => { setCreated(r.url); setSourceName(''); reload(); }).catch((e) => fail(e, '作れませんでした'))}>受け口を作る</button>
        </div>
        {created && <p className="ok-msg"><code>{created}</code></p>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function InventoryFields({ settings, busy, onChanged }: { settings: InventorySettings; busy: boolean; onChanged: () => void }) {
  const [low, setLow] = useState(String(settings.lowDefault));
  const [lead, setLead] = useState(String(settings.leadDaysDefault));
  const save = (patch: Partial<InventorySettings>) => void api.admin.setInventorySettings(patch).then(onChanged);
  const saveNumber = (v: string, key: 'lowDefault' | 'leadDaysDefault', current: number) => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n !== current) save({ [key]: n });
  };
  return (
    <div className="small ext-inventory">
      <div className="row wrap">
        {INVENTORY_FEATURES.filter((f) => INVENTORY_READY.includes(f.id)).map((f) => (
          <label key={f.id} className="check">
            <input type="checkbox" checked={settings.features[f.id]} disabled={busy}
              onChange={(e) => save({ features: { ...settings.features, [f.id]: e.target.checked } })} />
            {f.label}
          </label>
        ))}
      </div>
      <div className="row wrap">
        <label>残りわずかの目安 <input type="number" min={0} className="num" value={low} onChange={(e) => setLow(e.target.value)}
          onBlur={() => saveNumber(low, 'lowDefault', settings.lowDefault)} /></label>
        <label>仕入れにかかる日数 <input type="number" min={0} className="num" value={lead} onChange={(e) => setLead(e.target.value)}
          onBlur={() => saveNumber(lead, 'leadDaysDefault', settings.leadDaysDefault)} /> 日</label>
      </div>
      {settings.features.reserve && <BookingSources />}
    </div>
  );
}

/** 都道府県（健康保険の料率の区分。協会けんぽは都道府県ごと）。 */
const PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

/** 曜日（0=日曜）。 */
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 締め日・支払日の選び（31 は末日）。 */
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const dayLabel = (d: number) => (d === 31 ? '末日' : `${d} 日`);

/** 割増率の欄（設定の名前・画面の名前・法定の下限 %）。下限より下はサーバーが断る（第30.10.1節）。 */
const PREMIUMS: [keyof HrSettings['payroll']['premiums'], string, number][] = [
  ['overtime', '時間外', 25], ['over60', '月 60 時間超', 50], ['night', '深夜', 25], ['holiday', '休日', 35],
];

/**
 * 手当の扱い（仕様書 第30.10.1節）。雇用条件に入っている手当を並べ、割増の単価の基礎に入れるか・所得税の対象かを手当ごとに直す。
 * 設定していない手当は名前から決めた扱い。直した手当は会社の設定に残り、「戻す」で名前から決めた扱いに戻る。
 */
function HrAllowances({ settings, busy, save }: { settings: HrSettings; busy: boolean; save: (patch: Partial<HrSettings>) => void }) {
  const [items, setItems] = useState<{ name: string; premiumBase: boolean; taxable: boolean; set: boolean }[] | null>(null);
  const rules = settings.payroll.items;
  useEffect(() => { api.admin.hrAllowances().then((r) => setItems(r.items)).catch(() => setItems([])); }, [rules]);
  if (!items || items.length === 0) return null;
  const put = (name: string, patch: { premiumBase?: boolean; taxable?: boolean } | null) => {
    const cur = items.find((x) => x.name === name)!;
    const rest = rules.filter((r) => r.name !== name);
    save({ payroll: { ...settings.payroll, items: patch ? [...rest, { name, premiumBase: patch.premiumBase ?? cur.premiumBase, taxable: patch.taxable ?? cur.taxable }] : rest } });
  };
  return (
    <table className="table hr-allowances">
      <thead><tr><th>手当</th><th>割増の基礎に入れる</th><th>所得税の対象</th><th /></tr></thead>
      <tbody>
        {items.map((x) => (
          <tr key={x.name}>
            <td>{x.name}</td>
            <td><input type="checkbox" checked={x.premiumBase} disabled={busy} onChange={(e) => put(x.name, { premiumBase: e.target.checked })} aria-label={`${x.name}を割増の基礎に入れる`} /></td>
            <td><input type="checkbox" checked={x.taxable} disabled={busy} onChange={(e) => put(x.name, { taxable: e.target.checked })} aria-label={`${x.name}を所得税の対象にする`} /></td>
            <td>{x.set && <button className="link small" disabled={busy} onClick={() => put(x.name, null)}>名前から決めた扱いに戻す</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 人事・給与の会社の設定（仕様書 第30.8.1節）。事業所・保険・締めと支払・手続き・勤怠と休暇・給与の計算・振込元。すぐに反映する。
 *
 * @remarks 説明文は出さない（原則 u11）。何の設定かは秘書に聞けばよい
 */
function HrFields({ settings, busy, onChanged }: { settings: HrSettings; busy: boolean; onChanged: () => void }) {
  const [industries, setIndustries] = useState<{ code: string; category: string; name: string; rate: number }[]>([]);
  useEffect(() => { api.admin.hrLaborIndustries().then((r) => setIndustries(r.industries)).catch(() => setIndustries([])); }, []);
  const [name, setName] = useState(settings.office.name);
  const [address, setAddress] = useState(settings.office.address);
  const [error, setError] = useState<string | null>(null);
  const save = (patch: Partial<HrSettings>) => {
    setError(null);
    void api.admin.setHrSettings(patch).then(onChanged).catch((e) => setError(describeError(e, '保存できませんでした')));
  };
  return (
    <div className="small ext-inventory">
      {error && <p className="error">{error}</p>}
      <HrProposal settings={settings} onApply={save} />
      <div className="row wrap">
        <label>事業所 <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== settings.office.name && save({ office: { ...settings.office, name } })} /></label>
        <label>所在地 <input value={address} onChange={(e) => setAddress(e.target.value)} onBlur={() => address !== settings.office.address && save({ office: { ...settings.office, address } })} /></label>
        <select value={settings.office.form} disabled={busy} onChange={(e) => save({ office: { ...settings.office, form: e.target.value as HrSettings['office']['form'] } })} aria-label="事業の形態">
          <option value="corporation">法人</option><option value="sole">個人事業</option>
        </select>
      </div>
      <div className="row wrap">
        <select value={settings.health.kind} disabled={busy} onChange={(e) => save({ health: { ...settings.health, kind: e.target.value as HrSettings['health']['kind'] } })} aria-label="健康保険">
          <option value="kyokai">協会けんぽ</option><option value="kumiai">健康保険組合</option><option value="kokuho-kumiai">国民健康保険組合</option><option value="none">加入なし</option>
        </select>
        <select value={settings.health.prefecture} disabled={busy} onChange={(e) => save({ health: { ...settings.health, prefecture: e.target.value } })} aria-label="都道府県">
          <option value="">都道府県</option>
          {PREFECTURES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={settings.socialApply} disabled={busy} onChange={(e) => save({ socialApply: e.target.value as HrSettings['socialApply'] })} aria-label="社会保険の適用">
          <option value="mandatory">社会保険: 強制適用</option><option value="voluntary">社会保険: 任意適用</option><option value="none">社会保険: 適用なし</option>
        </select>
      </div>
      <div className="row wrap">
        <label>締め日 <select value={settings.pay.closingDay} disabled={busy} onChange={(e) => save({ pay: { ...settings.pay, closingDay: Number(e.target.value) } })}>
          {DAYS.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
        </select></label>
        <label>支払日 <select value={settings.pay.payMonth} disabled={busy} onChange={(e) => save({ pay: { ...settings.pay, payMonth: e.target.value as 'same' | 'next' } })}>
          <option value="same">当月</option><option value="next">翌月</option>
        </select> <select value={settings.pay.payDay} disabled={busy} onChange={(e) => save({ pay: { ...settings.pay, payDay: Number(e.target.value) } })}>
          {DAYS.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
        </select></label>
        <select value={settings.procedures} disabled={busy} onChange={(e) => save({ procedures: e.target.value as HrSettings['procedures'] })} aria-label="保険の手続き">
          <option value="self">保険の手続き: 自社</option><option value="sharoushi">保険の手続き: 社会保険労務士に依頼</option>
        </select>
      </div>
      <div className="row wrap">
        <span>所定の労働日</span>
        {WEEK.map((w, i) => (
          <label key={w} className="check">
            <input type="checkbox" checked={settings.work.weekdays.includes(i)} disabled={busy}
              onChange={(e) => save({ work: { ...settings.work, weekdays: e.target.checked ? [...settings.work.weekdays, i] : settings.work.weekdays.filter((x) => x !== i) } })} />{w}
          </label>
        ))}
        <label className="check"><input type="checkbox" checked={settings.work.nationalHolidays} disabled={busy}
          onChange={(e) => save({ work: { ...settings.work, nationalHolidays: e.target.checked } })} /> 祝日を休みにする</label>
        <label>法定休日 <select value={settings.work.legalHoliday} disabled={busy} onChange={(e) => save({ work: { ...settings.work, legalHoliday: Number(e.target.value) } })}>
          {WEEK.map((w, i) => <option key={w} value={i}>{w}曜</option>)}
        </select></label>
      </div>
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={settings.agreement.enabled} disabled={busy} onChange={(e) => save({ agreement: { ...settings.agreement, enabled: e.target.checked } })} /> 36 協定</label>
        {settings.agreement.enabled && (
          <>
            <label>月 <input type="number" min={1} max={100} className="num" defaultValue={settings.agreement.monthly}
              onBlur={(e) => Number(e.target.value) !== settings.agreement.monthly && save({ agreement: { ...settings.agreement, monthly: Number(e.target.value) } })} /> 時間</label>
            <label>年 <input type="number" min={1} max={720} className="num" defaultValue={settings.agreement.yearly}
              onBlur={(e) => Number(e.target.value) !== settings.agreement.yearly && save({ agreement: { ...settings.agreement, yearly: Number(e.target.value) } })} /> 時間</label>
            <label className="check"><input type="checkbox" checked={settings.agreement.special} disabled={busy} onChange={(e) => save({ agreement: { ...settings.agreement, special: e.target.checked } })} /> 特別条項</label>
            <label>起算の月 <select value={settings.agreement.startMonth} disabled={busy} onChange={(e) => save({ agreement: { ...settings.agreement, startMonth: Number(e.target.value) } })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m} 月</option>)}
            </select></label>
          </>
        )}
        <label className="check"><input type="checkbox" checked={settings.leave.halfDay} disabled={busy} onChange={(e) => save({ leave: { halfDay: e.target.checked } })} /> 半日の有給</label>
      </div>
      <div className="row wrap">
        <label>社会保険料 <select value={settings.payroll.collect} disabled={busy} onChange={(e) => save({ payroll: { ...settings.payroll, collect: e.target.value as 'next' | 'current' } })}>
          <option value="next">翌月徴収</option><option value="current">当月徴収</option>
        </select></label>
        <label>月の平均所定労働時間 <input type="number" min={1} max={250} step="0.01" className="num" defaultValue={settings.payroll.avgMonthlyHours ?? ''} placeholder="自動"
          onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== settings.payroll.avgMonthlyHours) save({ payroll: { ...settings.payroll, avgMonthlyHours: v } }); }} /> 時間</label>
        <label className="check"><input type="checkbox" checked={settings.payroll.deductAbsence} disabled={busy} onChange={(e) => save({ payroll: { ...settings.payroll, deductAbsence: e.target.checked } })} /> 欠勤・遅刻早退を引く</label>
      </div>
      <div className="row wrap">
        {PREMIUMS.map(([k, label, floor]) => (
          <label key={k}>{label} <input key={settings.payroll.premiums[k]} type="number" min={floor} max={200} step="1" className="num" defaultValue={settings.payroll.premiums[k]} aria-label={`${label}の割増率`}
            onBlur={(e) => {
              const empty = e.target.value === '';
              const v = Number(e.target.value);
              // 空や法定の下限より下は保存せず、今の率に戻す（下限より下なら理由を示す）
              if (empty || v < floor) {
                e.target.value = String(settings.payroll.premiums[k]);
                if (!empty) setError(`${label}の割増率は法定の下限（${floor}%）以上で入れてください`);
                return;
              }
              if (v !== settings.payroll.premiums[k]) save({ payroll: { ...settings.payroll, premiums: { ...settings.payroll.premiums, [k]: v } } });
            }} /> %</label>
        ))}
        {settings.health.kind === 'kumiai' && (
          <>
            <label>組合の健康保険料率 <input type="number" min={0} max={30} step="0.001" className="num" defaultValue={settings.payroll.kumiai.health ?? ''}
              onBlur={(e) => save({ payroll: { ...settings.payroll, kumiai: { ...settings.payroll.kumiai, health: e.target.value === '' ? null : Number(e.target.value) } } })} /> %</label>
            <label>介護 <input type="number" min={0} max={30} step="0.001" className="num" defaultValue={settings.payroll.kumiai.care ?? ''}
              onBlur={(e) => save({ payroll: { ...settings.payroll, kumiai: { ...settings.payroll.kumiai, care: e.target.value === '' ? null : Number(e.target.value) } } })} /> %</label>
          </>
        )}
      </div>
      <HrAllowances settings={settings} busy={busy} save={save} />
      <div className="row wrap">
        {([['officeSymbol', '事業所整理記号', 20], ['officeNumber', '事業所番号', 10]] as const).map(([k, l, max]) => (
          <input key={k} className="short" placeholder={l} aria-label={l} maxLength={max} defaultValue={settings.insurance[k]} disabled={busy}
            onBlur={(e) => { if (e.target.value !== settings.insurance[k]) save({ insurance: { ...settings.insurance, [k]: e.target.value } }); }} />
        ))}
        <select value={settings.insurance.specificOffice} disabled={busy} aria-label="特定適用事業所" onChange={(e) => save({ insurance: { ...settings.insurance, specificOffice: e.target.value as HrSettings['insurance']['specificOffice'] } })}>
          <option value="auto">特定適用事業所: 人数から見込む</option><option value="yes">特定適用事業所: 該当（任意特定を含む）</option><option value="no">特定適用事業所: 該当しない</option>
        </select>
        <label>通常の労働者の週の所定 <input type="number" min={10} max={60} step="0.5" className="num" defaultValue={settings.insurance.fullTimeWeeklyHours}
          onBlur={(e) => Number(e.target.value) !== settings.insurance.fullTimeWeeklyHours && save({ insurance: { ...settings.insurance, fullTimeWeeklyHours: Number(e.target.value) } })} /> 時間</label>
      </div>
      <div className="row wrap">
        <select value={settings.labor.business} disabled={busy} aria-label="雇用保険の事業の種類" onChange={(e) => save({ labor: { ...settings.labor, business: e.target.value as HrSettings['labor']['business'] } })}>
          <option value="general">雇用保険: 一般の事業</option><option value="agriculture">雇用保険: 農林水産・清酒製造</option><option value="construction">雇用保険: 建設</option>
        </select>
        <select value={settings.labor.industry} disabled={busy || industries.length === 0} aria-label="労災保険の事業の種類" onChange={(e) => save({ labor: { ...settings.labor, industry: e.target.value } })}>
          {industries.length === 0 && <option value={settings.labor.industry}>労災保険: {settings.labor.industry}</option>}
          {industries.map((r) => <option key={r.code} value={r.code}>労災保険: {r.code} {r.name}（{r.rate}/1000）</option>)}
        </select>
        <input className="short" placeholder="労働保険番号" aria-label="労働保険番号" maxLength={20} defaultValue={settings.labor.number} disabled={busy}
          onBlur={(e) => { if (e.target.value !== settings.labor.number) save({ labor: { ...settings.labor, number: e.target.value } }); }} />
      </div>
      <div className="row wrap">
        <label>振込元 <select value={settings.transfer.format} disabled={busy} onChange={(e) => save({ transfer: { ...settings.transfer, format: e.target.value as 'sogo' | 'kyuyo' } })}>
          <option value="sogo">総合振込</option><option value="kyuyo">給与振込</option>
        </select></label>
        {([['clientCode', '委託者コード', 10], ['clientName', '委託者名（カナ）', 40], ['bankCode', '銀行コード', 4], ['bankName', '銀行名（カナ）', 15],
          ['branchCode', '支店コード', 3], ['branchName', '支店名（カナ）', 15], ['accountNumber', '口座番号', 7]] as const).map(([k, l, max]) => (
          <input key={k} className={max <= 10 ? 'short' : ''} placeholder={l} aria-label={l} maxLength={max} defaultValue={settings.transfer[k]} disabled={busy}
            onBlur={(e) => { if (e.target.value !== settings.transfer[k]) save({ transfer: { ...settings.transfer, [k]: e.target.value } }); }} />
        ))}
        <select value={settings.transfer.accountType} disabled={busy} aria-label="預金の種目" onChange={(e) => save({ transfer: { ...settings.transfer, accountType: e.target.value as '普通' | '当座' } })}>
          <option>普通</option><option>当座</option>
        </select>
      </div>
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={settings.duties.withholdingSpecial} disabled={busy} onChange={(e) => save({ duties: { ...settings.duties, withholdingSpecial: e.target.checked } })} /> 源泉所得税の納期の特例</label>
        <label className="check"><input type="checkbox" checked={settings.duties.residentSpecial} disabled={busy} onChange={(e) => save({ duties: { ...settings.duties, residentSpecial: e.target.checked } })} /> 住民税の納期の特例</label>
        <label>定期健康診断 <select value={settings.duties.healthCheckMonth ?? ''} disabled={busy} onChange={(e) => save({ duties: { ...settings.duties, healthCheckMonth: e.target.value ? Number(e.target.value) : null } })}>
          <option value="">決めていない</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m} 月</option>)}
        </select></label>
      </div>
    </div>
  );
}

/** 受け取った日時の出し方。 */
const receivedAt = (iso: string | null) =>
  iso ? `${new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}に受信` : 'まだ受信していません';

/**
 * 予約の受け口（仕様書 第29.13.1節）。予約のシステムの Webhook の送り先を作る。URL は作ったときに一度だけ出す。
 * 項目の対応（型）は最初の予約から AI が推論するので、人は設定しない。推論が違っていたら「型をやり直す」で次の予約から推論し直す。
 */
function BookingSources() {
  const [sources, setSources] = useState<InventoryBookingSource[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void api.admin.bookingSources().then((r) => setSources(r.sources)).catch((e) => setError(describeError(e, '読み込めませんでした')));
  useEffect(load, []);
  const act = (fn: () => Promise<unknown>) => void fn().then(() => { setError(null); load(); }).catch((e) => setError(describeError(e, '変更できませんでした')));
  return (
    <div className="booking-sources">
      <strong>予約の受け口</strong>
      {sources?.map((s) => (
        <div key={s.id} className="row wrap">
          <span className="grow">{s.name}<span className="muted">（{s.status === 'stopped' ? '止めています' : receivedAt(s.lastReceivedAt)}{s.mapping ? '' : '・型はまだ'}）</span></span>
          {s.mapping && <button className="btn ghost small" onClick={() => act(() => api.admin.setBookingSourceMapping(s.id, null))}>型をやり直す</button>}
          <button className="btn ghost small" onClick={() => act(() => api.admin.setBookingSourceStatus(s.id, s.status === 'stopped' ? 'active' : 'stopped'))}>
            {s.status === 'stopped' ? '再開' : '止める'}
          </button>
        </div>
      ))}
      {created && (
        <div className="booking-created">
          <div>{created.name}の送り先（この画面を閉じると二度と出ません）</div>
          <code className="copyable">{created.url}</code>
          <button className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(created.url)}>写す</button>
        </div>
      )}
      <div className="row">
        <input placeholder="予約のシステムの名前" value={name} onChange={(e) => setName(e.target.value)} aria-label="予約のシステムの名前" />
        <button className="btn small" disabled={!name.trim()} onClick={() => void api.admin.createBookingSource(name.trim())
          .then((r) => { setCreated({ name: r.source.name, url: r.url }); setName(''); load(); })
          .catch((e) => setError(describeError(e, '作れませんでした')))}>受け口を作る</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** 選んだ案を、会社の設定の変更にする（`pay.closingDay` のような場所に値を入れる）。 */
function proposalPatch(fields: HrProposalField[], current: HrSettings): Partial<HrSettings> {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const f of fields) {
    if (f.problem) continue;
    const [top, a, b] = f.key.split('.') as [string, string, string | undefined];
    const base = (patch[top] ??= structuredClone((current as unknown as Record<string, Record<string, unknown>>)[top] ?? {}));
    if (b === undefined) base[a] = f.value;
    else (base[a] as Record<string, unknown>)[b] = f.value;
  }
  return patch as Partial<HrSettings>;
}

/**
 * 規程から読んだ案と今の設定を並べた表。入れる項目を選ぶ（決まりに合わない案は選べない）。
 */
function ProposalTable({ fields, onApply, onCancel, cancelLabel = 'やめる' }: {
  fields: HrProposalField[]; onApply: (chosen: HrProposalField[]) => void; onCancel: () => void; cancelLabel?: string;
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(fields.filter((x) => !x.problem && x.current !== x.proposed).map((x) => x.key)));
  return (
    <>
      <table className="table small">
        <thead><tr><th /><th>項目</th><th>今</th><th>案</th><th>規程の文</th></tr></thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key}>
              <td><input type="checkbox" disabled={!!f.problem} checked={chosen.has(f.key)} aria-label={`${f.label}を入れる`}
                onChange={() => setChosen((cur) => { const n = new Set(cur); if (n.has(f.key)) n.delete(f.key); else n.add(f.key); return n; })} /></td>
              <td>{f.label}</td>
              <td className="muted">{f.current}</td>
              <td>{f.proposed}{f.problem && <div className="error">{f.problem}</div>}</td>
              <td className="muted">{f.quote}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn small" disabled={chosen.size === 0} onClick={() => onApply(fields.filter((f) => chosen.has(f.key)))}>選んだ {chosen.size} 項目を入れる</button>
        <button className="btn ghost small" onClick={onCancel}>{cancelLabel}</button>
      </div>
    </>
  );
}

/**
 * 就業規則・賃金規程から設定の案を作る（仕様書 第30.8.2節）。AI が読み、今の設定と並べる。入れるかは管理者が選ぶ。
 * ファイルのほか、知識に登録した社内規程からも読める。社内規程を登録・改定して今の設定と食い違う項目が見つかっていれば、ここに出す（第11.11.2節）。
 */
function HrProposal({ settings, onApply }: { settings: HrSettings; onApply: (patch: Partial<HrSettings>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState<HrProposalField[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<{ id: string; title: string }[]>([]);
  const [checks, setChecks] = useState<{ itemId: string; version: number; title: string; effectiveFrom: string; fields: HrProposalField[] }[]>([]);
  const loadChecks = () => api.admin.hrRuleChecks().then((r) => setChecks(r.checks)).catch(() => setChecks([]));
  useEffect(() => {
    void api.admin.knowledge().then((r) => setRules(r.items.filter((k) => k.category === 'rule' && (k.status ?? 'active') === 'active').map((k) => ({ id: k.id, title: k.title })))).catch(() => undefined);
    void loadChecks();
  }, []);
  const read = (job: Promise<{ fields: HrProposalField[] }>) => {
    setBusy(true);
    setError(null);
    setFields(null);
    void job.then((r) => setFields(r.fields)).catch((e) => setError(describeError(e, '規程を読めませんでした'))).finally(() => setBusy(false));
  };
  return (
    <div className="hr-proposal">
      {checks.map((c) => (
        <div key={`${c.itemId}:${c.version}`} className="hr-rule-check">
          <p><strong>「{c.title}」第 {c.version} 版（施行 {c.effectiveFrom}）</strong>と今の設定が食い違っています</p>
          <ProposalTable fields={c.fields} cancelLabel="このままにする"
            onApply={(chosen) => { onApply(proposalPatch(chosen, settings)); void api.admin.dismissHrRuleCheck(c.itemId, c.version).then(loadChecks); }}
            onCancel={() => void api.admin.dismissHrRuleCheck(c.itemId, c.version).then(loadChecks)} />
        </div>
      ))}
      <div className="row wrap">
        <button className="btn ghost small" disabled={busy} onClick={() => input.current?.click()}>{busy ? '規程を読んでいます…' : '就業規則・賃金規程から設定の案を作る'}</button>
        {rules.length > 0 && (
          <select value="" disabled={busy} aria-label="登録した社内規程から案を作る" onChange={(e) => { if (e.target.value) read(api.admin.hrProposalFromRule(e.target.value)); }}>
            <option value="">登録した社内規程から…</option>
            {rules.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        )}
      </div>
      <input ref={input} type="file" hidden accept=".pdf,.docx,.txt,.md,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) read(api.admin.hrProposal(f)); }} />
      {error && <p className="error">{error}</p>}
      {fields && <ProposalTable key={fields.map((f) => f.key).join()} fields={fields} onApply={(chosen) => { onApply(proposalPatch(chosen, settings)); setFields(null); }} onCancel={() => setFields(null)} />}
    </div>
  );
}
