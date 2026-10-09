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
import { api, describeError, type ConsolidationView, type KnowledgeItemView, type KnowledgeSectionView, type KnowledgeVersionView } from './api.js';
import { PageTitle, type PageHelp } from './help.js';
import { SaveButton } from './save.js';
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

function Text({ label, value, onChange, hint, multiline, span, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; multiline?: boolean;
  /** 詰めた並べ方（`form-grid`）の中で使う列の数（12 のうち）。 */
  span?: number;
  /** 入力欄の中に薄く置く例（仕様書 第6.10.4.1節）。下に説明を足すより場所を取らない。 */
  placeholder?: string;
}) {
  return (
    <div className={`field${span ? ` span-${span}` : ''}`}>
      <label>{label}</label>
      {multiline
        ? <textarea value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        : <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

/** 会社情報と自社の書き方（第6.6.1節、第15.2.1節）。 */
/**
 * 会社情報（仕様書 第6.6.1節）。
 *
 * @remarks
 * **1 画面 1 保存**（第6.6.0節）。小分けを `page` で受け取り、1 つだけを出す。
 */
/**
 * 会社のロゴ（仕様書 第6.6.1節）。上げるとすぐに保存し、画面の左上に出す（読み込み直すと替わる）。
 */
function CompanyLogo({ fileId, onChange }: { fileId: string | null; onChange: (id: string | null) => Promise<void> }) {
  const saver = useSaver();
  return (
    <div className="field">
      <label>会社のロゴ</label>
      <input type="file" accept="image/png,image/jpeg"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          void saver.run(async () => {
            const up = await api.uploadFile(file);
            await onChange(up.id);
          }, 'ロゴを登録しました。読み込み直すと画面の左上に出ます');
        }} />
      <span className="muted small">PNG / JPEG。画面の左上に出ます{fileId ? '（登録済み）' : ''}</span>
      {fileId && (
        <div className="row">
          <img className="company-logo-preview" src={`/v1/me/company-logo?v=${encodeURIComponent(fileId)}`} alt="登録したロゴ" />
          <button className="btn ghost small" onClick={() => void saver.run(() => onChange(null), 'ロゴを外しました')}>ロゴを外す</button>
        </div>
      )}
      {saver.view}
    </div>
  );
}

export function CompanySettings({ page }: { page: string }) {
  const { data, error, reload } = useSettings();
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [style, setStyle] = useState<WritingStyle | null>(null);
  const saver = useSaver();
  useEffect(() => { if (data) { setCompany(data.company); setStyle(data.writingStyle); } }, [data]);
  if (error) return <p className="error">{error}</p>;
  if (!data || !company || !style) return <p className="muted">読み込み中…</p>;
  const c = (k: keyof CompanyInfo) => (v: string) => setCompany({ ...company, [k]: v });
  const w = (k: keyof WritingStyle) => (v: string) => setStyle({ ...style, [k]: v });

  const title = TITLES[page] ?? '会社情報';
  return (
    <>
      <PageTitle trail={['会社情報', title]} help={COMPANY_HELP[page]} />
      {page === 'basic' && (
      <div className="card">
        {/*
          詰めて並べる（2026-09-26 に三浦さんが指摘。欄がすべて横いっぱいで広すぎた）。
          欄の幅は中身の長さに合わせ、例は欄の中に薄く置く（第6.10.4.1節）
        */}
        <div className="form-grid">
          <Text span={8} label="正式な会社名" value={company.legalName} onChange={c('legalName')} placeholder="前株・後株を含めて正確に" />
          {/* 略称は、秘書が名乗るときの会社の呼び方と画面の見出しに使う（仕様書 第6.6.1節） */}
          <Text span={4} label="略称" value={company.shortName ?? ''} onChange={c('shortName')} placeholder="例: OESF" />
          <Text span={2} label="郵便番号" value={company.postalCode ?? ''} onChange={c('postalCode')} placeholder="123-4567" />
          <Text span={7} label="住所" value={company.address} onChange={c('address')} />
          <Text span={3} label="電話番号" value={company.phone} onChange={c('phone')} placeholder="03-0000-0000" />
          {/* 自社の Web サイト（仕様書 第36.4節）。競合の分析が自社の像をまとめるときに読む */}
          <Text span={6} label="Web サイト" value={company.website ?? ''} onChange={c('website')} placeholder="https://www.example.jp/" />
          {/* 営業日（第 0.243.0 版）。朝のブリーフなど「会社の営業日」の定時実行は、この曜日にだけ動く */}
          <div className="field">
            <label>営業日</label>
            <div className="row wrap">
              {'日月火水木金土'.split('').map((label, i) => (
                <label key={label} className="check">
                  <input type="checkbox" checked={(company.businessDays ?? [1, 2, 3, 4, 5]).includes(i)}
                    onChange={(e) => {
                      const cur = company.businessDays ?? [1, 2, 3, 4, 5];
                      setCompany({ ...company, businessDays: e.target.checked ? [...new Set([...cur, i])].sort() : cur.filter((d) => d !== i) });
                    }} />{label}
                </label>
              ))}
              <label className="check">
                <input type="checkbox" checked={company.holidaysClosed ?? true} onChange={(e) => setCompany({ ...company, holidaysClosed: e.target.checked })} />祝日は休み
              </label>
            </div>
          </div>
          <Text span={4} label="適格請求書発行事業者の登録番号" value={company.invoiceRegistrationNumber}
            onChange={c('invoiceRegistrationNumber')} placeholder="T1234567890123（未登録なら空欄）" />
          <div className="field span-2">
            <label>会計年度の開始月</label>
            <select value={company.fiscalYearStartMonth}
              onChange={(e) => setCompany({ ...company, fiscalYearStartMonth: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 月</option>)}
            </select>
          </div>
          <div className="field span-2">
            <label>締め日</label>
            <select value={String(company.closingDay)}
              onChange={(e) => setCompany({ ...company, closingDay: e.target.value === 'end' ? 'end' : Number(e.target.value) })}>
              <option value="end">月末</option>
              {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 日</option>)}
            </select>
          </div>
          <div className="field span-2">
            <label title="税率ごとに 1 回">消費税の端数処理</label>
            <select value={company.taxRounding}
              onChange={(e) => setCompany({ ...company, taxRounding: e.target.value as CompanyInfo['taxRounding'] })}>
              <option value="floor">切り捨て</option>
              <option value="round">四捨五入</option>
              <option value="ceil">切り上げ</option>
            </select>
          </div>
          <Text span={2} label="支払サイト" value={company.paymentTerms} onChange={c('paymentTerms')} placeholder="例: 翌月末払い" />
        </div>
        <CompanyLogo fileId={company.logoFileId ?? null}
          onChange={async (logoFileId) => {
            const next = { ...company, logoFileId };
            setCompany(next);
            await api.admin.saveSettings('company', next);
          }} />
        <SaveButton run={() => api.admin.saveSettings('company', company)} />
      </div>
      )}

      {/*
        ダッシュボードの見せ方（仕様書 第6.7.4.1節、Q-64）。
        **ダッシュボードの上には置かない。** 毎日眺める画面に、めったに触らない設定を置かない。
        壁のモニターに映すときに見直すものなので、会社の設定として持つ。
      */}
      {page === 'dashboard' && (
      <div className="card">
        <p className="muted small">壁に映すと通行人にも見えます</p>
        <div className="field">
          <label>見せ方</label>
          <select value={data.dashboard.people}
            onChange={(e) => void saver.run(() =>
              api.admin.saveSettings('dashboard', { people: e.target.value as 'names' | 'counts' }).then(reload))}>
            <option value="names">個人名で表示（既定）</option>
            <option value="counts">人数と業務だけ（誰かは出さない）</option>
          </select>
        </div>
        {saver.view}
      </div>
      )}

      {page === 'writing' && (
      <div className="card">
        {/* 例は入力欄の中に薄く置く（下に説明を常に出さない。仕様書 第6.10.4.1節） */}
        <Text label="自社の呼び方" value={style.selfReference} onChange={w('selfReference')} placeholder="例: 当社・弊社" />
        <Text label="社外宛ての書き出し" value={style.greeting} onChange={w('greeting')} multiline
          placeholder={'例: いつも大変お世話になっております。\n株式会社〇〇の△△でございます。'} />
        <Text label="社外宛ての結び" value={style.closing} onChange={w('closing')} multiline
          placeholder={'例: ご不明な点がございましたら、お気軽にお問い合わせください。\n引き続きどうぞよろしくお願いいたします。'} />
        <Text label="署名" value={style.signature} onChange={w('signature')} multiline
          placeholder={'例: 株式会社〇〇　営業部\n△△ △△\nTEL 03-0000-0000\nsales@example.co.jp'} />
        <div className="field">
          <label>用語の言い換え</label>
          {style.terms.map((t, i) => (
            <div className="row" key={i}>
              <input placeholder="使わない言葉（例: お客さん）" value={t.avoid}
                onChange={(e) => setStyle({ ...style, terms: style.terms.map((x, j) => j === i ? { ...x, avoid: e.target.value } : x) })} />
              <span className="muted">→</span>
              <input placeholder="使う言葉（例: お客様）" value={t.use}
                onChange={(e) => setStyle({ ...style, terms: style.terms.map((x, j) => j === i ? { ...x, use: e.target.value } : x) })} />
              <button className="btn ghost small"
                onClick={() => setStyle({ ...style, terms: style.terms.filter((_, j) => j !== i) })}>削除</button>
            </div>
          ))}
          <button className="btn ghost small" onClick={() => setStyle({ ...style, terms: [...style.terms, { avoid: '', use: '' }] })}>
            言い換えを追加
          </button>
        </div>
        <Text label="その他の注意" value={style.notes} onChange={w('notes')} multiline
          placeholder={'例: 敬語は丁寧すぎない言い方にする。\n数字と英字は半角で書く。\n日付は「10月9日（木）」の形で書く。'} />
        <SaveButton run={() => api.admin.saveSettings('writingStyle', style)} />
      </div>
      )}
      {page === 'invoice' && <InvoiceStyleSettings initial={data.invoice} onSaved={() => void reload()} />}
      {page === 'slides' && <SlideTemplateSettings initial={data.slides.templates} onSaved={() => void reload()} />}
    </>
  );
}

/** 小分けの題名（第6.6.0.1節）。左のメニューと題名で同じ言葉を使う。 */
const TITLES: Record<string, string> = {
  basic: '基本情報',
  writing: '自社の書き方',
  invoice: '帳票の体裁',
  slides: 'スライドの見本',
  dashboard: 'ダッシュボードの見せ方',
};

/** 小分けごとの「？」の説明（仕様書 第6.10.4.4節）。開いている画面のことを書く。 */
const COMPANY_HELP: Record<string, PageHelp> = {
  basic: { article: 'admin-setup', text: '正式な会社名・住所・会計年度など、会社の基本の値です。帳票とメールの署名に使います。' },
  writing: { article: 'admin-setup', text: '自社の呼び方・書き出し・結び・署名など、すべての業務が文面を作るときに従う書き方です。業務ごとには変えられません。' },
  invoice: { article: 'admin-setup', text: '請求書などの PDF に出すロゴ・振込先・支払期限・備考です。文面の書き方は「自社の書き方」で決めます。' },
  slides: { article: 'admin-slides', text: 'Google スライドで作った自社のファイルを、スライドを作るときの見本として使います。URL を貼るだけで登録できます。' },
  dashboard: { article: 'admin-dashboard', text: 'ダッシュボードの人の状態を、個人名で出すか、人数と業務だけにするかを決めます。壁のモニターに映すときに見直してください。' },
};

/**
 * 帳票の体裁（仕様書 第15.2.2節、Q-57）。請求書などの PDF に使う。
 *
 * @remarks
 * 自社の書き方（文章の規則）とは分けて持つ。ここで決めるのは、帳票を描くための値だけである。
 * 差出人は会社情報から組み立てるため、ここでは指定しない。
 */
function InvoiceStyleSettings({ initial, onSaved }: {
  initial: TenantSettings['invoice']; onSaved: () => void;
}) {
  const [style, setStyle] = useState(initial);
  const saver = useSaver();
  const set = (v: Partial<TenantSettings['invoice']>) => setStyle({ ...style, ...v });

  return (
    <div className="card">
      <div className="field">
        <label>ロゴ</label>
        <input type="file" accept="image/png,image/jpeg"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void saver.run(async () => {
              const up = await api.uploadFile(file);
              set({ logoFileId: up.id });
              await api.admin.saveSettings('invoice', { ...style, logoFileId: up.id });
              onSaved();
            }, 'ロゴを登録しました');
          }} />
        <span className="muted small">PNG / JPEG{style.logoFileId ? '（登録済み）' : ''}</span>
        {style.logoFileId && (
          <div className="row">
            <button className="btn ghost small" onClick={() => set({ logoFileId: null })}>ロゴを外す</button>
          </div>
        )}
      </div>
      {/* 例は入力欄の中に薄く置く（下に説明を常に出さない。仕様書 第6.10.4.1節） */}
      <Text label="振込先" value={style.bankAccount} onChange={(v) => set({ bankAccount: v })}
        placeholder="例: 〇〇銀行 △△支店 普通 1234567 カ）マルマルショウジ" />
      <Text label="支払期限の既定" value={style.paymentDue} onChange={(v) => set({ paymentDue: v })}
        placeholder="例: 翌月末" />
      <Text label="備考の定型文" value={style.notes} onChange={(v) => set({ notes: v })} multiline
        placeholder={'例: 振込手数料は貴社にてご負担ください。\nお支払い期限までにお振り込みをお願いいたします。'} />
      <label className="check">
        <input type="checkbox" checked={style.sealBox} onChange={(e) => set({ sealBox: e.target.checked })} />
        印の欄を出す
      </label>
      <div className="row">
        <SaveButton run={async () => {
          await api.admin.saveSettings('invoice', style);
          onSaved();
        }} />
      </div>
      {saver.view}
    </div>
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
      <p className="muted small">ファイルは社内で共有してください</p>
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
        <SaveButton run={async () => {
          await api.admin.saveSettings('slides', {
            templates: items.map((t) => ({ id: t.id, name: t.name, presentationId: t.url, description: t.description, isDefault: t.isDefault })),
          });
          onSaved();
        }} />
      </div>
      {saver.view}
    </div>
  );
}

/** 業務の有効化と自動化ポリシー（第6.6.5節、第9.4節）。 */
export function AgentSettings({ page }: { page: string }) {
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
      <PageTitle trail={['業務と承認', AGENT_TITLES[page] ?? '']} help={AGENT_HELP[page]} />
      {page === 'automation' && (
      <div className="card">
        <div className="field">
          <label>全体の設定</label>
          <select value={policy.writeInternal}
            onChange={(e) => setPolicy({ ...policy, writeInternal: e.target.value as 'require' | 'allow' })}>
            <option value="allow">承認なし（既定）</option>
            <option value="require">承認が必要</option>
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
        <p className="muted small">社外に出るものとお金の確定は、いつも人が判断します</p>
        <SaveButton run={() => api.admin.saveSettings('automation', policy)} />
      </div>
      )}

      {page === 'enabled' && (
      <div className="card">
        <p className="muted small">無効にすると誰も起動できません</p>
        <table className="table">
          <tbody>
            {data.catalog.map((a) => (
              <tr key={a.id}>
                <td><strong>{a.name}</strong><br /><span className="muted small">{a.description}</span></td>
                <td className="num nowrap">
                  {/* 拡張機能と同じスライドのスイッチ（押すとすぐ保存する） */}
                  <label className="switch-label">
                    <span className="small">{disabled.has(a.id) ? '無効' : '有効'}</span>
                    <button type="button" role="switch" aria-checked={!disabled.has(a.id)} aria-label={`${a.name}を${disabled.has(a.id) ? '有効' : '無効'}にする`}
                      className={disabled.has(a.id) ? 'switch' : 'switch on'} disabled={saver.busy} onClick={() => toggle(a.id)}><span /></button>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {saver.view}
      </div>
      )}

      {page === 'scope' && (
      <div className="card">
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
        <p className="muted small">拡張機能の業務は「拡張機能」で設定</p>
      </div>
      )}
      {page === 'effect' && (
      <div className="card">
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
        <p className="muted small">過去の推計は変わりません</p>
        <SaveButton
          run={() => api.admin.saveSettings('effect', {
            // 公式の既定値と同じものは残さない（公式の既定値が変わったら、その値に付いていけるように）
            minutesPerRun: Object.fromEntries(Object.entries(minutes)
              .filter(([k, v]) => v !== '' && Number(v) !== data.catalog.find((a) => a.id === k)?.defaultMinutes)
              .map(([k, v]) => [k, Number(v)])),
          })} />
      </div>
      )}
    </>
  );
}

/** 小分けの題名（第6.6.0.1節）。 */
const AGENT_TITLES: Record<string, string> = {
  enabled: '使う業務',
  automation: '社内への書き込み',
  scope: '利用できる人',
  effect: '効果の推計',
};

/** 小分けごとの「？」の説明（仕様書 第6.10.4.4節）。 */
const AGENT_HELP: Record<string, PageHelp> = {
  enabled: { article: 'admin-agents', text: '会社で使う業務を選びます。無効にした業務は、メニュー・秘書・定時実行のどれからも起動できなくなります。' },
  automation: { article: 'admin-agents', text: '社内への書き込みは、既定では確認なしで行います。社外に出るものとお金の確定は、設定にかかわらず、いつも人が判断します。' },
  scope: { article: 'admin-groups', text: '業務ごとに、使える人をグループと個人で決めます。範囲の外の人のメニュー・秘書には、その業務が出ません。' },
  effect: { article: 'admin-agents', text: '「手作業なら 1 件に何分かかるか」を業務ごとに決めます。ダッシュボードの推計の削減時間に使います。' },
};

/** 小分けの題名（第6.6.0.1節）。 */
const USER_TITLES: Record<string, string> = {
  list: 'ユーザー',
  invite: '招待する',
  groups: 'グループ',
  compartments: '権限区画',
};

/** 小分けごとの「？」の説明（仕様書 第6.10.4.4節）。 */
const USER_HELP: Record<string, PageHelp> = {
  list: { article: 'admin-users', text: '招待した人の一覧です。ロールの変更と停止をここで行います。管理者は 2 人以上にしておくことをおすすめします。' },
  invite: { article: 'admin-users', text: 'メールアドレスとロールを指定して招待します。ログインは各自の Google アカウントで行います。' },
  groups: { article: 'admin-groups', text: '業務を使える人と、権限区画を割り当てる人のまとまりです。Google Chat のスペースとは別のものです。' },
  compartments: { article: 'admin-groups', text: '給与や評価のような機微なデータを隔てる区画です。区画ごとに、入れるグループと人を割り当てます。' },
};

const ROLE_LABELS: Record<Role, string> = {
  admin: '管理者', approver: '承認者', member: '一般', external: '外部協力者', developer: '開発者',
};

/** ユーザーと権限（第6.6.4節）。 */
export function UserSettings({ meId, page }: { meId: string; page: string }) {
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
  // Google のデータの削除を求められたとき（仕様書 第27.6.1節、Q-152）。値は前に戻り、記録は取り戻せないため確かめる
  const forgetSignatures = (u: User) => {
    if (!confirm(`${u.displayName}さんのメールの署名から新しくした名刺の値を前に戻し、その記録を削除します。よろしいですか？`)) return;
    void saver.run(async () => api.admin.forgetMailSignatures(u.id), (r) => `${r.count} 件の記録を削除しました`);
  };
  const toggleStatus = (u: User) =>
    void saver.run(async () => {
      const r = await api.admin.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' });
      await load();
      return r;
    }, (r) => (r.status === 'disabled' && (r.personalCards ?? 0) > 0
      // 管理者は中身を見られないため件数だけを示す（仕様書 第27.7節、Q-94）
      ? `停止しました。この人の「自分だけ」の名刺 ${r.personalCards} 件は、30 日後に削除されます（それまでに戻せば残ります）`
      : '保存しました'));

  return (
    <>
      <PageTitle trail={['ユーザーと権限', USER_TITLES[page] ?? '']} help={USER_HELP[page]} />
      {page === 'list' && <>
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
                <button className="btn ghost small" disabled={saver.busy} onClick={() => forgetSignatures(u)}>メールから得た名刺の変更を削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {saver.view}
      </>}

      {page === 'invite' && (
      <div className="card">
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
          }, '招待しました')}>
          一般ロールで招待する
        </button>
        {saver.view}
      </div>
      )}

      {page === 'groups' && (
        <GroupSettings users={users} key={`g-${version.c}`} onChanged={() => setVersion((v) => ({ ...v, g: v.g + 1 }))} />
      )}
      {page === 'compartments' && (
        <CompartmentSettings key={`c-${version.g}`} onChanged={() => setVersion((v) => ({ ...v, c: v.c + 1 }))} />
      )}
    </>
  );
}

/** 知識の種類ごとの小分け（仕様書 第11.11.5節）。以前の `items` は社内規程として開く。 */
const KNOWLEDGE_CATEGORY: Record<string, 'rule' | 'minutes' | 'learned'> = { rules: 'rule', items: 'rule', minutes: 'minutes', learned: 'learned' };
/** しまった理由の言い方。 */
const ARCHIVE_REASON: Record<string, string> = { merged: 'まとめた', stale: '新しい事実で古くなった', unused: '半年使われていない', conflict: '社内規程と食い違う' };
/** 廃止した・しまったものを戻せる期間。 */
const RESTORE_MS = 365 * 86_400_000;
/** 日本時間の今日。 */
const jstToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');

/**
 * 知識管理（仕様書 第6.6.6節・第11.11節、ADR-0056）。社内規程・議事録・秘書が学んだことを別々の一覧にする。
 *
 * @remarks
 * 社内規程は改定すると版を残し、消さずに廃止する（1 年は戻せる）。議事録も廃止する。消せるのは秘書が学んだことだけ。
 * 同じ見た目の削除のボタンを、社内規程と議事録に置かない。
 */
export function KnowledgeSettings({ page }: { page: string }) {
  const category = KNOWLEDGE_CATEGORY[page] ?? 'rule';
  const [items, setItems] = useState<KnowledgeItemView[]>([]);
  const [compartments, setCompartments] = useState<{ name: string; description: string | null }[]>([]);
  const [consolidated, setConsolidated] = useState<ConsolidationView | null>(null);
  const empty = { id: 'new', title: '', body: '', source: '', compartment: null as string | null, effectiveFrom: jstToday() };
  const [draft, setDraft] = useState(empty);
  // 開いている知識と、その節か版（第11.7.2節・第11.11.2節）
  const [open, setOpen] = useState<{ id: string; sections?: KnowledgeSectionView[]; versions?: KnowledgeVersionView[] } | null>(null);
  const [body, setBody] = useState<{ key: string; text: string } | null>(null);
  const saver = useSaver();
  const [semantic, setSemantic] = useState<{ ready: number; total: number } | null>(null);
  const load = () => api.admin.knowledge().then((r) => { setItems(r.items); setCompartments(r.compartments); setConsolidated(r.consolidated); setSemantic(r.semantic); });
  useEffect(() => { void load(); }, []);
  useEffect(() => { setDraft(empty); setOpen(null); }, [category]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = items.filter((k) => (k.category ?? 'rule') === category);
  const active = mine.filter((k) => (k.status ?? 'active') === 'active');
  const inactive = mine.filter((k) => (k.status ?? 'active') !== 'active');
  const toggleSections = (id: string) => {
    if (open?.id === id && open.sections) { setOpen(null); return; }
    api.admin.knowledgeSections(id).then((r) => setOpen({ id, sections: r.sections })).catch(() => setOpen(null));
  };
  const toggleVersions = (id: string) => {
    if (open?.id === id && open.versions) { setOpen(null); return; }
    api.admin.knowledgeVersions(id).then((r) => setOpen({ id, versions: r.versions })).catch(() => setOpen(null));
  };
  const showBody = (id: string, version: number) => {
    const key = `${id}:${version}`;
    if (body?.key === key) { setBody(null); return; }
    void api.admin.knowledgeVersion(id, version).then((r) => setBody({ key, text: r.version.body }));
  };
  const act = (fn: () => Promise<unknown>, done: string) => void saver.run(async () => { await fn(); await load(); }, done);
  const restorable = (k: KnowledgeItemView) => !k.statusAt || Date.now() - Date.parse(k.statusAt) <= RESTORE_MS;
  const isRule = category === 'rule';
  // 秘書が学んだことは 1 文なので、節の列を出さない
  const showSections = category !== 'learned';
  const colSpan = (isRule ? 4 : 3) + (showSections ? 1 : 0);

  return (
    <>
      <PageTitle trail={['知識', KNOWLEDGE_TITLES[page] ?? KNOWLEDGE_TITLES['rules']!]} help={KNOWLEDGE_HELP[page] ?? KNOWLEDGE_HELP['rules']} />
      {isRule && active.length === 0 && <p className="lead"><strong>空のままだと秘書は答えられません。</strong></p>}
      {/* 意味での検索の準備（第11.7.6.1節）。作り終えるまでの節も、言葉では見つかる */}
      {isRule && semantic && semantic.total > 0 && <p className="muted small">意味での検索の準備: {semantic.ready} / {semantic.total} 節</p>}
      {category === 'learned' && consolidated && (
        <p className="muted small">
          最後に整理した日: {day(consolidated.at)}
          {consolidated.detail.ai !== false && `（まとめた ${consolidated.detail.merged ?? 0}・古くなった ${consolidated.detail.stale ?? 0}・使われていない ${consolidated.detail.unused ?? 0}・社内規程と食い違う ${consolidated.detail.conflict ?? 0}）`}
        </p>
      )}
      {(category !== 'learned' || draft.id !== 'new') && (category !== 'minutes' || draft.id !== 'new') && (
        <div className="card">
          <h3>{draft.id === 'new' ? '新しく登録する' : isRule ? '改定する' : '修正する'}</h3>
          <Text label="題名" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
          <Text label="出典（条番号など）" value={draft.source} onChange={(v) => setDraft({ ...draft, source: v })}
            placeholder="就業規則（2024 年 4 月改定）" />
          {isRule && (
            <div className="field">
              <label>施行日</label>
              <input type="date" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
            </div>
          )}
          <Text label="本文" value={draft.body} onChange={(v) => setDraft({ ...draft, body: v })} multiline
            hint="50 万字まで。見出しで節に分けます" />
          <div className="field">
            <label>権限区画</label>
            <select value={draft.compartment ?? ''} onChange={(e) => setDraft({ ...draft, compartment: e.target.value || null })}>
              <option value="">区画外（全員が参照できる）</option>
              {compartments.map((c) => <option key={c.name} value={c.name}>{c.description ?? c.name}（{c.name}）</option>)}
            </select>
          </div>
          <div className="row">
            <SaveButton
              run={async () => {
                const saved = await api.admin.saveKnowledge(draft.id, {
                  title: draft.title, body: draft.body, source: draft.source, compartment: draft.compartment,
                  ...(isRule ? { effectiveFrom: draft.effectiveFrom } : {}),
                });
                setDraft(empty);
                await load();
                setOpen({ id: saved.id, sections: saved.sections });
                return saved;
              }}
              done={(r) => (r.applied === false
                ? `第 ${r.version} 版を保存しました。施行日から切り替わります`
                : `${r.version ? `第 ${r.version} 版を保存しました。` : '保存しました。'}本文を ${r.sections.length} の節に分けました`)}
            />
            {draft.id !== 'new' && <button className="btn ghost" onClick={() => setDraft(empty)}>キャンセル</button>}
          </div>
        </div>
      )}
      {saver.view}
      <table className="table knowledge-table">
        <thead><tr>
          <th>{category === 'learned' ? '学んだこと' : '題名'}</th>
          {isRule ? <th>施行</th> : <th className="nowrap">{category === 'learned' ? '最後に使った日' : '出典'}</th>}
          {isRule && <th>出典</th>}
          {showSections && <th className="nowrap">節</th>}<th />
        </tr></thead>
        <tbody>
          {active.map((k) => (
            <Fragment key={k.id}>
              <tr>
                <td>{category === 'learned' ? k.body : k.title}</td>
                {isRule ? (
                  <td>
                    第 {k.version ?? 1} 版（{day(k.effectiveFrom)}）
                    {k.pending && <>{' '}<span className="badge">次の版 {k.pending.effectiveFrom}</span></>}
                  </td>
                ) : category === 'learned' ? <td className="nowrap">{day(k.lastUsedAt)}</td> : (
                  // 出典は折り返さない（題名の列に幅を取られて、1 字ずつ折り返していた）
                  <td className="nowrap">
                    {k.source}
                    {k.originRunId && <>{' '}<span className="badge muted-badge">業務から登録</span></>}
                    {k.googleDerived && <>{' '}<span className="badge muted-badge">Google 由来</span></>}
                  </td>
                )}
                {isRule && <td>{k.source}{k.compartment && <span className="muted small">（{k.compartment}）</span>}</td>}
                {showSections && (
                  <td className="nowrap">
                    <button className="link-btn" onClick={() => toggleSections(k.id)}>{k.sectionCount ?? 0} 節</button>
                  </td>
                )}
                <td className="num nowrap">
                  <button className="btn ghost small" onClick={() => setDraft({ id: k.id, title: k.title, body: k.body, source: k.source, compartment: k.compartment, effectiveFrom: jstToday() })}>
                    {isRule ? '改定' : '修正'}
                  </button>{' '}
                  {isRule && <><button className="btn ghost small" onClick={() => toggleVersions(k.id)}>版</button>{' '}</>}
                  {category === 'learned' ? (
                    <button className="btn danger small" disabled={saver.busy}
                      onClick={() => { if (confirm('この知識を削除しますか')) act(() => api.admin.deleteKnowledge(k.id), '削除しました'); }}>削除</button>
                  ) : (
                    // 社内規程は「廃止」、議事録は「削除」（どちらも 1 年は戻せる）
                    <button className={`btn small ${isRule ? 'ghost' : 'danger'}`} disabled={saver.busy} onClick={() => act(() => api.admin.retireKnowledge(k.id), `${isRule ? '廃止' : '削除'}しました。1 年は戻せます`)}>{isRule ? '廃止' : '削除'}</button>
                  )}
                </td>
              </tr>
              {open?.id === k.id && open.sections && (
                <tr className="sub-row"><td colSpan={colSpan}>
                  {open.sections.length === 0 ? <p className="muted small">節がありません。</p> : (
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
                </td></tr>
              )}
              {open?.id === k.id && open.versions && (
                <tr className="sub-row"><td colSpan={colSpan}>
                  <table className="table small">
                    <tbody>
                      {open.versions.map((v) => (
                        <Fragment key={v.version}>
                          <tr>
                            <td>第 {v.version} 版{v.current && <>{' '}<span className="badge">施行中</span></>}{v.pending && <>{' '}<span className="badge">施行前</span></>}</td>
                            <td>施行 {v.effectiveFrom}</td>
                            <td className="muted">保存 {day(v.savedAt)}・{v.chars.toLocaleString('ja-JP')} 字</td>
                            <td className="num"><button className="link-btn" onClick={() => showBody(k.id, v.version)}>本文</button></td>
                          </tr>
                          {body?.key === `${k.id}:${v.version}` && <tr><td colSpan={4}><pre className="knowledge-body">{body.text}</pre></td></tr>}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {inactive.length > 0 && (
        <>
          <h4>{category === 'learned' ? 'しまったもの' : isRule ? '廃止したもの' : '削除したもの'}</h4>
          <table className="table knowledge-table">
            <tbody>
              {inactive.map((k) => (
                <tr key={k.id}>
                  <td>{category === 'learned' ? k.body : k.title}</td>
                  <td className="muted nowrap">
                    {day(k.statusAt)}
                    {category === 'learned' && k.statusReason && `・${ARCHIVE_REASON[k.statusReason] ?? k.statusReason}`}
                  </td>
                  <td className="num nowrap">
                    {restorable(k)
                      ? <button className="btn ghost small" disabled={saver.busy} onClick={() => act(() => api.admin.restoreKnowledge(k.id), '戻しました')}>戻す</button>
                      : <span className="muted small">1 年を過ぎました</span>}
                    {category === 'learned' && <>{' '}<button className="btn danger small" disabled={saver.busy}
                      onClick={() => { if (confirm('この知識を削除しますか')) act(() => api.admin.deleteKnowledge(k.id), '削除しました'); }}>削除</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

/** 小分けの題名（第6.6.0.1節）。 */
const KNOWLEDGE_TITLES: Record<string, string> = {
  rules: '社内規程',
  items: '社内規程',
  minutes: '議事録',
  learned: '秘書が学んだこと',
};

/** 小分けごとの「？」の説明（仕様書 第6.10.4.4節）。 */
const KNOWLEDGE_HELP: Record<string, PageHelp> = {
  rules: { article: 'admin-knowledge', text: 'ここに登録した規程から、秘書と「社内ナレッジ Q&A」が出典つきで答えます。改定すると前の版を残し、廃止しても 1 年は戻せます。' },
  items: { article: 'admin-knowledge', text: 'ここに登録した規程から、秘書と「社内ナレッジ Q&A」が出典つきで答えます。改定すると前の版を残し、廃止しても 1 年は戻せます。' },
  minutes: { article: 'admin-knowledge', text: '「議事録の作成・共有」が、共有のあとに登録した議事録です。削除しても 1 年は戻せます。' },
  learned: { article: 'admin-knowledge', text: '秘書が会話から学び、ほかの人にも役立つと判断したことです。週 1 回、秘書がまとめ、古いものや使われないものをしまいます。' },
};

