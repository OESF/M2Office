/**
 * @file 管理者ページの編集画面（会社情報・業務と承認・ユーザー・知識）。拡張機能は Extensions.tsx。
 *
 * 保存のたびに API が値を検証する。画面側の入力制限は利便のためであり、
 * 規則の強制は API 側で行う。
 *
 * @see 仕様書 第6.6節 管理者ページ
 */

import { Fragment, useEffect, useState } from 'react';
import type {
  AutomationPolicy, CompanyInfo, Role, SlideTemplate, TenantSettings, User, WritingStyle,
} from '@m2office/shared';
import { STANDARD_SYNONYMS, SYNONYM_LIMITS } from '@m2office/shared';
import { api, describeError, type KnowledgeItemView, type KnowledgeSectionView } from './api.js';
import { HelpTip } from './help.js';
import { CompartmentSettings, GroupSettings, ScopeField, useAccessOptions } from './Scope.js';

type Catalog = {
  id: string; name: string; description: string; usesWriteInternal: boolean; defaultMinutes: number;
}[];
type Loaded = TenantSettings & { catalog: Catalog };

/** 設定を読み込み、保存後に読み直す。 */
function useSettings() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.admin.settings().then(setData).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  return { data, error, reload: load };
}

/** 保存ボタンの状態と結果の表示。 */
function useSaver() {
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: string | null }>(
    { busy: false, message: null, error: null });
  const run = async <R,>(fn: () => Promise<R>, done: string | ((r: R) => string) = '保存しました') => {
    setState({ busy: true, message: null, error: null });
    try {
      const r = await fn();
      setState({ busy: false, message: typeof done === 'function' ? done(r) : done, error: null });
    } catch (e) {
      setState({ busy: false, message: null, error: describeError(e, '保存できませんでした') });
    }
  };
  const view = (
    <>
      {state.message && <p className="ok-msg">{state.message}</p>}
      {state.error && <p className="error">{state.error}</p>}
    </>
  );
  return { busy: state.busy, run, view };
}

function Text({ label, value, onChange, hint, multiline }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; multiline?: boolean;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {multiline
        ? <textarea value={value} onChange={(e) => onChange(e.target.value)} />
        : <input value={value} onChange={(e) => onChange(e.target.value)} />}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

/** 会社情報と自社の書き方（第6.6.1節、第15.2.1節）。 */
export function CompanySettings() {
  const { data, error, reload } = useSettings();
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [style, setStyle] = useState<WritingStyle | null>(null);
  const saver = useSaver();
  useEffect(() => { if (data) { setCompany(data.company); setStyle(data.writingStyle); } }, [data]);
  if (error) return <p className="error">{error}</p>;
  if (!data || !company || !style) return <p className="muted">読み込み中…</p>;
  const c = (k: keyof CompanyInfo) => (v: string) => setCompany({ ...company, [k]: v });
  const w = (k: keyof WritingStyle) => (v: string) => setStyle({ ...style, [k]: v });

  return (
    <>
      <h1>会社情報 <HelpTip article="admin-setup">帳票・メールの署名と、すべての業務の文面に使います。</HelpTip></h1>
      <p className="lead">帳票・メールの署名、すべての業務の文面に使います。</p>
      <div className="card">
        <h3>基本情報</h3>
        <Text label="正式な会社名" value={company.legalName} onChange={c('legalName')} hint="前株・後株を含めて正確に" />
        <Text label="住所" value={company.address} onChange={c('address')} />
        <Text label="電話番号" value={company.phone} onChange={c('phone')} />
        <div className="grid2">
          <div className="field">
            <label>会計年度の開始月</label>
            <select value={company.fiscalYearStartMonth}
              onChange={(e) => setCompany({ ...company, fiscalYearStartMonth: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 月</option>)}
            </select>
          </div>
          <div className="field">
            <label>締め日</label>
            <select value={String(company.closingDay)}
              onChange={(e) => setCompany({ ...company, closingDay: e.target.value === 'end' ? 'end' : Number(e.target.value) })}>
              <option value="end">月末</option>
              {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 日</option>)}
            </select>
          </div>
        </div>
        <Text label="適格請求書発行事業者の登録番号" value={company.invoiceRegistrationNumber}
          onChange={c('invoiceRegistrationNumber')} hint="T に続く 13 桁（例: T1234567890123）。未登録なら空欄" />
        <div className="grid2">
          <div className="field">
            <label>消費税の端数処理（税率ごとに 1 回）</label>
            <select value={company.taxRounding}
              onChange={(e) => setCompany({ ...company, taxRounding: e.target.value as CompanyInfo['taxRounding'] })}>
              <option value="floor">切り捨て</option>
              <option value="round">四捨五入</option>
              <option value="ceil">切り上げ</option>
            </select>
          </div>
          <Text label="支払サイト" value={company.paymentTerms} onChange={c('paymentTerms')} hint="例: 翌月末払い" />
        </div>
        <button className="btn" disabled={saver.busy}
          onClick={() => void saver.run(() => api.admin.saveSettings('company', company))}>保存する</button>
      </div>

      <div className="card">
        <h3>自社の書き方</h3>
        <p>すべての業務が同じ書き方で文面を作ります。業務ごとの個別指定はできません。</p>
        <Text label="自社の呼び方" value={style.selfReference} onChange={w('selfReference')} hint="例: 弊社／当社" />
        <Text label="社外宛ての書き出し" value={style.greeting} onChange={w('greeting')} multiline />
        <Text label="社外宛ての結び" value={style.closing} onChange={w('closing')} multiline />
        <Text label="署名" value={style.signature} onChange={w('signature')} multiline />
        <div className="field">
          <label>用語の言い換え</label>
          {style.terms.map((t, i) => (
            <div className="row" key={i}>
              <input placeholder="使わない言葉" value={t.avoid}
                onChange={(e) => setStyle({ ...style, terms: style.terms.map((x, j) => j === i ? { ...x, avoid: e.target.value } : x) })} />
              <span className="muted">→</span>
              <input placeholder="使う言葉" value={t.use}
                onChange={(e) => setStyle({ ...style, terms: style.terms.map((x, j) => j === i ? { ...x, use: e.target.value } : x) })} />
              <button className="btn ghost small"
                onClick={() => setStyle({ ...style, terms: style.terms.filter((_, j) => j !== i) })}>削除</button>
            </div>
          ))}
          <button className="btn ghost small" onClick={() => setStyle({ ...style, terms: [...style.terms, { avoid: '', use: '' }] })}>
            言い換えを追加
          </button>
        </div>
        <Text label="その他の注意" value={style.notes} onChange={w('notes')} multiline />
        <button className="btn" disabled={saver.busy}
          onClick={() => void saver.run(() => api.admin.saveSettings('writingStyle', style))}>保存する</button>
      </div>
      <SlideTemplateSettings initial={data.slides.templates} onSaved={() => void reload()} />
      {saver.view}
    </>
  );
}

/** 画面で編集中のテンプレート。`url` には URL か ID をそのまま持つ。 */
type TemplateDraft = { id: string; name: string; url: string; description: string; isDefault: boolean };

/**
 * スライドのテンプレート（仕様書 第9.4.2節）。Google スライドの URL を貼るだけで登録する。
 *
 * @remarks 中身（レイアウト・差し込み口）の読み取りは Google 連携の後。いまは登録と既定の選択だけを行う。
 */
function SlideTemplateSettings({ initial, onSaved }: { initial: SlideTemplate[]; onSaved: () => void }) {
  const toDraft = (t: SlideTemplate): TemplateDraft => ({
    id: t.id, name: t.name, url: t.presentationId, description: t.description, isDefault: t.isDefault,
  });
  const [items, setItems] = useState<TemplateDraft[]>(initial.map(toDraft));
  const saver = useSaver();
  useEffect(() => { setItems(initial.map(toDraft)); }, [initial]);
  const set = (i: number, patch: Partial<TemplateDraft>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const idOf = (url: string) => /\/presentation\/d\/([A-Za-z0-9_-]{20,})/.exec(url)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(url.trim()) ? url.trim() : null);

  return (
    <div className="card">
      <h3>スライドのテンプレート <HelpTip article="admin-slides">Google スライドで作った自社のファイルを、スライドを作るときの見本として使います。URL を貼るだけで登録できます。</HelpTip></h3>
      <div className="note small">
        <p>Google スライドで作った<strong>自社のファイル</strong>を、スライド作成の見本として使います。URL を貼るだけで登録できます。</p>
        <p>
          中身は Google スライドの画面で自由に作り直せます。見本のスライドを 1 枚足せばレイアウトが 1 つ増え、M2Office の変更は要りません。
          ロゴ・フッター・背景は<strong>マスター</strong>に置くと全スライドに入ります。
          差し込みたい場所は <code>{'{{見出し}}'}</code>、図の場所は <code>{'{{CHART}}'}</code>・<code>{'{{IMAGE}}'}</code>、
          レイアウトの名前は画面の外に <code>{'{{LAYOUT_NAME:3カード比較}}'}</code> と書きます。
        </p>
        <p>1 つも登録していない間は、M2Office の標準のテンプレートで作ります。使う人が見られるように、ファイルは会社の中で共有してください。</p>
      </div>
      {items.map((t, i) => {
        const id = idOf(t.url);
        return (
          <div className="template-row" key={t.id || i}>
            <div className="grid2">
              <div className="field">
                <label>名前</label>
                <input value={t.name} placeholder="例: 社内向け" onChange={(e) => set(i, { name: e.target.value })} />
              </div>
              <div className="field">
                <label>説明（どんな資料に使うか）</label>
                <input value={t.description} placeholder="例: 提案書・社外向け" onChange={(e) => set(i, { description: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Google スライドの URL</label>
              <div className="row">
                <input value={t.url} placeholder="https://docs.google.com/presentation/d/…/edit" onChange={(e) => set(i, { url: e.target.value })} />
                {id
                  ? <a className="btn ghost small" href={`https://docs.google.com/presentation/d/${id}/edit`} target="_blank" rel="noreferrer">開く</a>
                  : t.url && <span className="error-inline small">URL を確認してください</span>}
                <button className="btn danger small" onClick={() => setItems(items.filter((_, j) => j !== i))}>削除</button>
              </div>
            </div>
            <label className="check">
              <input type="radio" name="default-template" checked={t.isDefault}
                onChange={() => setItems(items.map((x, j) => ({ ...x, isDefault: j === i })))} /> 既定にする
            </label>
          </div>
        );
      })}
      <div className="row">
        <button className="btn ghost" disabled={items.length >= 10}
          onClick={() => setItems([...items, { id: '', name: '', url: '', description: '', isDefault: items.length === 0 }])}>
          ＋ テンプレートを追加
        </button>
        <button className="btn" disabled={saver.busy} onClick={() => void saver.run(async () => {
          await api.admin.saveSettings('slides', {
            templates: items.map((t) => ({ id: t.id, name: t.name, presentationId: t.url, description: t.description, isDefault: t.isDefault })),
          });
          onSaved();
        })}>保存</button>
      </div>
      <p className="muted small">中身（レイアウトと差し込み口）の読み取りは、Google との接続ができてから行います。いまは登録と既定の選択だけが効きます。</p>
      {saver.view}
    </div>
  );
}

/** 業務の有効化と自動化ポリシー（第6.6.5節、第9.4節）。 */
export function AgentSettings() {
  const { data, error, reload } = useSettings();
  const access = useAccessOptions();
  const [policy, setPolicy] = useState<AutomationPolicy | null>(null);
  const [minutes, setMinutes] = useState<Record<string, string>>({});
  const saver = useSaver();
  useEffect(() => {
    if (!data) return;
    setPolicy(data.automation);
    setMinutes(Object.fromEntries(data.catalog.map((a) =>
      [a.id, String(data.effect.minutesPerRun[a.id] ?? a.defaultMinutes)])));
  }, [data]);
  if (error) return <p className="error">{error}</p>;
  if (!data || !policy) return <p className="muted">読み込み中…</p>;
  const disabled = new Set(data.agents.disabled);

  const toggle = (id: string) => {
    const next = new Set(disabled);
    if (next.has(id)) next.delete(id); else next.add(id);
    void saver.run(async () => { await api.admin.saveSettings('agents', { disabled: [...next] }); await reload(); });
  };
  const setAgentPolicy = (id: string, v: string) => {
    const perAgent = { ...policy.perAgent };
    if (v === 'inherit') delete perAgent[id]; else perAgent[id] = v as 'require' | 'allow';
    setPolicy({ ...policy, perAgent });
  };

  return (
    <>
      <h1>業務と承認 <HelpTip article="admin-agents">社内への書き込みの確認の要否と、使う業務を決めます。社外や他の人に届く操作は、設定にかかわらず必ず承認が必要です。</HelpTip></h1>
      <p className="lead">社内で使う業務と、承認を省略してよい範囲を決めます。</p>
      <div className="card">
        <h3>社内への書き込み（タスクの起票、予定の登録、本人宛の通知など）</h3>
        <p>承認が必要な場合、業務は書き込む直前で止まり、依頼した本人に確認を求めます。</p>
        <div className="field">
          <label>全体の設定</label>
          <select value={policy.writeInternal}
            onChange={(e) => setPolicy({ ...policy, writeInternal: e.target.value as 'require' | 'allow' })}>
            <option value="require">承認が必要（推奨）</option>
            <option value="allow">承認なしで実行する</option>
          </select>
        </div>
        <table className="table">
          <thead><tr><th>業務</th><th>社内への書き込み</th></tr></thead>
          <tbody>
            {data.catalog.filter((a) => a.usesWriteInternal).map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>
                  <select value={policy.perAgent[a.id] ?? 'inherit'} onChange={(e) => setAgentPolicy(a.id, e.target.value)}>
                    <option value="inherit">全体の設定に従う</option>
                    <option value="require">承認が必要</option>
                    <option value="allow">承認なし</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          メールの送信・チャットへの投稿・予定の招待など、社外や他の人に届く操作は、設定にかかわらず必ず承認が必要です。
        </p>
        <button className="btn" disabled={saver.busy}
          onClick={() => void saver.run(() => api.admin.saveSettings('automation', policy))}>保存する</button>
      </div>

      <div className="card">
        <h3>使う業務</h3>
        <p>無効にした業務は、メニュー・秘書・定時実行のいずれからも起動できなくなります。</p>
        <table className="table">
          <tbody>
            {data.catalog.map((a) => (
              <tr key={a.id}>
                <td><strong>{a.name}</strong><br /><span className="muted small">{a.description}</span></td>
                <td className="num">
                  <button className={`btn small ${disabled.has(a.id) ? '' : 'ghost'}`} disabled={saver.busy}
                    onClick={() => toggle(a.id)}>
                    {disabled.has(a.id) ? '有効にする' : '無効にする'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>利用できる人 <HelpTip article="admin-groups">業務ごとに、使える人を全員か、指定したグループと人に絞ります。範囲の外の人のメニュー・秘書には、その業務が出ません。</HelpTip></h3>
        <p>業務ごとに、使える人を決めます。指定したグループに所属する人と、個別に加えた人だけが使えます。</p>
        {access.error && <p className="error">{access.error}</p>}
        {access.options && (
          <table className="table">
            <thead><tr><th>業務</th><th>利用できる人</th></tr></thead>
            <tbody>
              {data.catalog.filter((a) => !a.id.includes(':')).map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td><ScopeField target={a.id} options={access.options!} onSaved={() => void access.reload()} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">拡張機能の業務は、「拡張機能」の画面で拡張機能ごとに設定します。</p>
      </div>
      <div className="card">
        <h3>効果の推計（手作業での標準所要時間）</h3>
        <p>
          「手作業なら 1 件に何分かかるか」を業務ごとに決めます。ダッシュボードの推計の削減時間は、
          完了した件数にこの値を掛けて求めます。実態に合わせて控えめに設定してください。
        </p>
        <table className="table">
          <thead><tr><th>業務</th><th className="num">標準所要時間（分）</th><th className="num">公式の既定値</th></tr></thead>
          <tbody>
            {data.catalog.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="num">
                  <input className="num-input" type="number" min={0} max={600} value={minutes[a.id] ?? ''}
                    onChange={(e) => setMinutes({ ...minutes, [a.id]: e.target.value })} />
                </td>
                <td className="num muted">{a.defaultMinutes} 分</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">変更は、これから完了する実行から反映されます。過去の実行の推計は変わりません。</p>
        <button className="btn" disabled={saver.busy}
          onClick={() => void saver.run(() => api.admin.saveSettings('effect', {
            minutesPerRun: Object.fromEntries(Object.entries(minutes).map(([k, v]) => [k, Number(v)])),
          }))}>保存する</button>
      </div>
      {saver.view}
    </>
  );
}

const ROLE_LABELS: Record<Role, string> = {
  admin: '管理者', approver: '承認者', member: '一般', external: '外部協力者', developer: '開発者',
};

/** ユーザーと権限（第6.6.4節）。 */
export function UserSettings({ meId }: { meId: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [invite, setInvite] = useState({ email: '', displayName: '' });
  // グループと区画は互いの表示（割り当て先・入れる人）に効くため、片方を変えたら両方を読み直す
  const [version, setVersion] = useState({ g: 0, c: 0 });
  const saver = useSaver();
  const load = () => api.admin.users().then((r) => setUsers(r.items));
  useEffect(() => { void load(); }, []);

  const toggleRole = (u: User, role: Role) => {
    const roles = u.roles.includes(role) ? u.roles.filter((r) => r !== role) : [...u.roles, role];
    void saver.run(async () => { await api.admin.updateUser(u.id, { roles }); await load(); });
  };
  const toggleStatus = (u: User) =>
    void saver.run(async () => {
      await api.admin.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' });
      await load();
    });

  return (
    <>
      <h1>ユーザーと権限 <HelpTip article="admin-users">招待・ロール・停止を管理します。管理者は 2 人以上にしておくことをおすすめします。</HelpTip></h1>
      <p className="lead">ログインは各自の Google アカウントで行います。ここではロールと利用の可否を決めます。</p>
      <table className="table">
        <thead><tr><th>名前</th><th>メールアドレス</th><th>ロール</th><th>状態</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.displayName}{u.id === meId && <span className="muted small">（あなた）</span>}</td>
              <td>{u.email}</td>
              <td>
                {(['admin', 'approver', 'member'] as Role[]).map((r) => (
                  <label key={r} className="check">
                    <input type="checkbox" checked={u.roles.includes(r)} disabled={saver.busy}
                      onChange={() => toggleRole(u, r)} />
                    {ROLE_LABELS[r]}
                  </label>
                ))}
              </td>
              <td>
                <button className="btn ghost small" disabled={saver.busy} onClick={() => toggleStatus(u)}>
                  {u.status === 'active' ? '利用中（停止する）' : '停止中（再開する）'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>招待する</h3>
        <div className="grid2">
          <Text label="メールアドレス" value={invite.email} onChange={(v) => setInvite({ ...invite, email: v })}
            hint="会社の Google Workspace のアドレス" />
          <Text label="表示名" value={invite.displayName} onChange={(v) => setInvite({ ...invite, displayName: v })} />
        </div>
        <button className="btn" disabled={saver.busy || !invite.email}
          onClick={() => void saver.run(async () => {
            await api.admin.inviteUser(invite.email, invite.displayName, ['member']);
            setInvite({ email: '', displayName: '' });
            await load();
          }, '招待しました。Google ログインが使えるようになると、この方がログインできます')}>
          一般ロールで招待する
        </button>
      </div>
      <GroupSettings users={users} key={`g-${version.c}`} onChanged={() => setVersion((v) => ({ ...v, g: v.g + 1 }))} />
      <CompartmentSettings key={`c-${version.g}`} onChanged={() => setVersion((v) => ({ ...v, c: v.c + 1 }))} />
      {saver.view}
    </>
  );
}

/** 知識管理（第6.6.6節）。規程の登録。 */
export function KnowledgeSettings() {
  const [items, setItems] = useState<KnowledgeItemView[]>([]);
  const [compartments, setCompartments] = useState<{ name: string; description: string | null }[]>([]);
  const empty = { id: 'new', kind: 'rule', title: '', body: '', source: '', compartment: null as string | null };
  const [draft, setDraft] = useState(empty);
  // 分け方を開いている知識と、その節（第11.7.2節）
  const [open, setOpen] = useState<{ id: string; sections: KnowledgeSectionView[] } | null>(null);
  const saver = useSaver();
  const load = () => api.admin.knowledge().then((r) => { setItems(r.items); setCompartments(r.compartments); });
  const toggle = (id: string) => {
    if (open?.id === id) { setOpen(null); return; }
    api.admin.knowledgeSections(id).then((r) => setOpen({ id, sections: r.sections })).catch(() => setOpen(null));
  };
  useEffect(() => { void load(); }, []);

  return (
    <>
      <h1>知識 <HelpTip article="admin-knowledge">ここに登録した規程から、秘書と「社内ナレッジ Q&A」が出典つきで答えます。空のままだと答えられません。</HelpTip></h1>
      <p className="lead">就業規則・経費規程・価格表などを登録します。「社内ナレッジ Q&A」はここから出典つきで答えます。</p>
      <div className="card">
        <h3>{draft.id === 'new' ? '新しく登録する' : '編集する'}</h3>
        <Text label="題名" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
        <Text label="出典（条番号など）" value={draft.source} onChange={(v) => setDraft({ ...draft, source: v })}
          hint="文書の出どころ。例: 就業規則（2024 年 4 月改定）、ファイル名やリンク。条は本文の見出しから自動で示します" />
        <Text label="本文" value={draft.body} onChange={(v) => setDraft({ ...draft, body: v })} multiline
          hint="長い規程も 1 件で登録できます（50 万字まで）。「第○章」「第○条」や「## 見出し」で、検索と出典の単位（節）に自動で分けます" />
        <div className="field">
          <label>権限区画</label>
          <select value={draft.compartment ?? ''} onChange={(e) => setDraft({ ...draft, compartment: e.target.value || null })}>
            <option value="">区画外（全員が参照できる）</option>
            {compartments.map((c) => <option key={c.name} value={c.name}>{c.description ?? c.name}（{c.name}）</option>)}
          </select>
        </div>
        <div className="row">
          <button className="btn" disabled={saver.busy}
            onClick={() => void saver.run(async () => {
              const { id: _id, version: _v, sectionCount: _n, updatedAt: _u, ...rest } = draft as KnowledgeItemView;
              const saved = await api.admin.saveKnowledge(draft.id, rest);
              setDraft(empty);
              await load();
              setOpen({ id: saved.id, sections: saved.sections });
              return saved.sections.length;
            }, (n) => `保存しました。本文を ${n} の節に分けました。下の一覧で分け方を確かめられます`)}>保存する</button>
          {draft.id !== 'new' && <button className="btn ghost" onClick={() => setDraft(empty)}>やめる</button>}
        </div>
      </div>
      {saver.view}
      <table className="table">
        <thead><tr><th>題名</th><th>出典</th><th>区画</th><th>節</th><th /></tr></thead>
        <tbody>
          {items.map((k) => (
            <Fragment key={k.id}>
            <tr>
              <td>{k.title}</td><td>{k.source}</td><td>{k.compartment ?? '—'}</td>
              <td>
                <button className="link-btn" onClick={() => toggle(k.id)} title="本文をどう分けたかを見る">
                  {k.sectionCount ?? 0} 節{open?.id === k.id ? '（閉じる）' : ''}
                </button>
              </td>
              <td className="num">
                <button className="btn ghost small" onClick={() => setDraft({ ...k })}>編集</button>{' '}
                <button className="btn danger small" disabled={saver.busy}
                  onClick={() => { if (confirm(`「${k.title}」を削除しますか`)) void saver.run(async () => { await api.admin.deleteKnowledge(k.id); await load(); }, '削除しました'); }}>
                  削除
                </button>
              </td>
            </tr>
            {open?.id === k.id && (
              <tr className="sub-row">
                <td colSpan={5}>
                  {open.sections.length === 0 ? <p className="muted small">節がありません（本文が空です）。</p> : (
                    <ol className="section-list">
                      {open.sections.map((x, i) => (
                        <li key={i}>
                          {x.path.length > 0 && <span className="muted">{x.path.join(' › ')} › </span>}
                          {x.heading || '（見出しなし）'}
                          <span className="muted small">　{x.chars.toLocaleString('ja-JP')} 字</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <SynonymSettings />
    </>
  );
}

/**
 * 言い換えの登録（仕様書 第11.7.7節）。同じ意味の言葉の組で、知識の検索を補う。
 *
 * @remarks 自社の組は 1 行に 1 組の文で編集し、保存のときにサーバーが組に分けて検証する。
 */
function SynonymSettings() {
  const [standard, setStandard] = useState(true);
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const saver = useSaver();
  useEffect(() => {
    api.admin.settings().then((s) => {
      setStandard(s.knowledge.standardSynonyms);
      setText(s.knowledge.synonyms.map((g) => g.join('、')).join('\n'));
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  return (
    <div className="card">
      <h3>言い換え <HelpTip article="admin-knowledge">「育休」と聞かれたら「育児休業」でも探す、というように、同じ意味の言葉を結び付けます。</HelpTip></h3>
      <p className="muted small">質問の言葉が規程の言葉と違っても見つかるようにします。言い換えで見つけたときは、答えに「読み替えて探しました」と示します。</p>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={standard} onChange={(e) => setStandard(e.target.checked)} />
          標準の言い換えを使う（労務・経費でよく使う {STANDARD_SYNONYMS.length} 組）
        </label>
        <details>
          <summary className="small">標準の言い換えを見る</summary>
          <ul className="small">{STANDARD_SYNONYMS.map((g) => <li key={g[0]}>{g.join('、')}</li>)}</ul>
          <p className="muted small">一部だけ直したいときは、標準を使わない設定にして、下の自社の言い換えに書き直してください。</p>
        </details>
      </div>
      <Text label="自社の言い換え" value={text} onChange={setText} multiline
        hint={`1 行に 1 組。語は「、」で区切ります（例: 営推、営業推進部）。1 組 ${SYNONYM_LIMITS.wordsPerGroup} 語まで、${SYNONYM_LIMITS.groups} 組まで`} />
      <div className="row">
        <button className="btn" disabled={saver.busy || !loaded}
          onClick={() => void saver.run(async () => {
            // 文のまま送る。サーバーが組に分けて検証し、誤りは画面の行番号で返す
            await api.admin.saveSettings('knowledge', { standardSynonyms: standard, synonyms: text as unknown as string[][] });
          })}>保存する</button>
      </div>
      {saver.view}
    </div>
  );
}

