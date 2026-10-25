/**
 * @file スライドのデザインを見本の絵のカードから選ぶ部品（仕様書 第9.4.2節「組み込みのデザイン」）。
 *
 * 組み込みのデザイン（`SLIDE_DESIGNS`）は、表紙と本文の 2 枚を小さく描いた絵で、会社が登録したテンプレートは名前と説明のカードで並べる。
 * 見本の絵はデザインの定義（色・表紙の飾り）から描く（外へ取りに行かない。デザインを足せば絵も自動で増える）。
 * 「スライドの作成」の入力（形 `slide-design`）と、管理者ページの「スライドの見本」（会社の既定）で使う。
 * Google スライドのテーマ（本人が選んだプレゼンテーション）も見本に並べ、「＋ Google スライドのテーマ」から加える（第9.4.2節「Google スライドのテーマを使う」）。
 */

import { useCallback, useEffect, useState } from 'react';
import { SLIDE_DESIGNS, SLIDE_THEME_PREFIX, slideRgbCss, type SlideDeckKind, type SlideDesign, type SlideThemeSummary } from '@m2office/shared';
import { api, describeError } from './api.js';
import { pickDriveTemplate } from './google-picker.js';

/** 会社が登録したテンプレート（選ぶための名前と説明だけ）。 */
export interface SlideTemplateChoice {
  name: string;
  description: string;
}

/** 表紙と本文の 2 枚の見本の絵（16:9 を 2 枚並べる）。 */
function DesignPreview({ d }: { d: SlideDesign }) {
  const c = slideRgbCss;
  const cover = d.cover;
  return (
    <svg viewBox="0 0 200 58" className="slide-design-preview" aria-hidden="true">
      {/* 表紙 */}
      <rect x="0" y="0" width="96" height="54" rx="2" fill={c(cover.background)} stroke="var(--line)" strokeWidth="0.5" />
      {cover.style === 'band' && <rect x="0" y="0" width="4" height="54" fill={c(d.accent)} />}
      {cover.style === 'corner' && (
        <>
          <circle cx="92" cy="2" r="12" fill={c(d.accentLight)} />
          <circle cx="2" cy="52" r="12" fill={c(d.accent)} />
        </>
      )}
      <rect x="22" y="20" width="52" height="6" rx="1" fill={c(cover.title)} />
      <rect x="32" y="30" width="32" height="3" rx="1" fill={c(cover.subtitle)} />
      {cover.style === 'line' && <rect x="34" y="37" width="28" height="1" fill={c(d.accent)} />}
      {/* 本文 */}
      <rect x="104" y="0" width="96" height="54" rx="2" fill={c(d.background)} stroke="var(--line)" strokeWidth="0.5" />
      <rect x="110" y="6" width="44" height="5" rx="1" fill={c(d.accent)} />
      {d.rule && <rect x="110" y="13" width="84" height="0.8" fill={c(d.accent)} />}
      <rect x="110" y="18" width="40" height="22" rx="2" fill={c(d.accentLight)} />
      <rect x="154" y="18" width="40" height="22" rx="2" fill={c(d.accentLight)} />
      <rect x="114" y="22" width="20" height="3" rx="1" fill={c(d.accent)} />
      <rect x="114" y="28" width="30" height="2" rx="1" fill={c(d.text)} />
      <rect x="158" y="22" width="20" height="3" rx="1" fill={c(d.accent)} />
      <rect x="158" y="28" width="30" height="2" rx="1" fill={c(d.text)} />
      <rect x="110" y="44" width="84" height="5" rx="1" fill={c(d.accentLight)} />
    </svg>
  );
}

/** Google スライドのテンプレート ギャラリー（テーマにするファイルを作る場所）。 */
const GALLERY_URL = 'https://docs.google.com/presentation/u/0/?tgif=d';
/** Google ドキュメントのテンプレート ギャラリー（第9.5.5.2節「文書のテンプレート」）。 */
const DOC_GALLERY_URL = 'https://docs.google.com/document/u/0/?tgif=d';
/** 文書のテンプレートを使わない（今の作り方）値。 */
export const DOC_STANDARD = '標準';

/** テーマの見本の縮小の絵（読み込めなければ名前だけ）。 */
function ThemeThumb({ theme }: { theme: SlideThemeSummary }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!theme.thumbnail) return undefined;
    let alive = true;
    let made: string | null = null;
    void api.slideThemeThumbnail(theme.id).then((u) => { made = u; if (alive) setUrl(u); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [theme.id, theme.thumbnail]);
  return url
    ? <img className="slide-design-thumb" src={url} alt="" />
    : <span className="slide-design-thumb is-empty" aria-hidden="true" />;
}

/**
 * Google スライドのテーマ（文書ならテンプレート）の一覧と、加える・削除する・使えるようにする手続き
 * （第9.4.2節「Google スライドのテーマを使う」・第9.5.5.2節「文書のテンプレート」）。
 *
 * @param company 会社のものを扱うか（管理者ページ）。`false` なら本人のものと会社のもの
 * @param kind スライドのテーマ（既定）か文書のテンプレート
 */
export function useSlideThemes(company: boolean, kind: SlideDeckKind = 'slides') {
  const [themes, setThemes] = useState<SlideThemeSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 見本の接続口の会社では、見本のドライブのファイルから選ぶ
  const [mockItems, setMockItems] = useState<{ id: string; name: string }[] | null>(null);
  const reload = useCallback(async () => {
    const r = await api.slideThemes(kind).catch(() => ({ items: [] as SlideThemeSummary[] }));
    setThemes(company ? r.items.filter((t) => t.company) : r.items);
  }, [company, kind]);
  useEffect(() => { void reload(); }, [reload]);

  /** 選んだファイルをテーマにする。 */
  const register = async (fileId: string): Promise<string | null> => {
    const t = await api.addSlideTheme(fileId, company, kind);
    await reload();
    return `${SLIDE_THEME_PREFIX}${t.id}`;
  };
  /** 選ぶ画面を開き、選んだプレゼンテーションをテーマにする。加えたテーマの値（`theme:<ID>`）を返す。 */
  const add = async (): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.slideThemePicker(kind);
      if (p.kind === 'mock') { setMockItems(p.items); return null; }
      const picked = await pickDriveTemplate(p, kind);
      return picked ? await register(picked.id) : null;
    } catch (err) {
      setError(describeError(err, kind === 'doc' ? 'テンプレートを加えられませんでした' : 'テーマを加えられませんでした'));
      return null;
    } finally {
      setBusy(false);
    }
  };
  /** 見本のドライブのファイルを選んだとき。 */
  const pickMock = async (fileId: string): Promise<string | null> => {
    setMockItems(null);
    try {
      return await register(fileId);
    } catch (err) {
      setError(describeError(err, 'テーマを加えられませんでした'));
      return null;
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm(kind === 'doc' ? 'このテンプレートを見本から削除します（Google ドキュメントのファイルはそのまま残ります）。' : 'このテーマを見本から削除します（Google スライドのファイルはそのまま残ります）。')) return;
    try {
      await api.deleteSlideTheme(id);
      await reload();
    } catch (err) {
      setError(describeError(err, '削除できませんでした'));
    }
  };
  /** 会社のテーマを初めて使うとき、選ぶ画面でそのファイルを選んでもらう（`drive.file` の決まり）。 */
  const ensureAccess = async (id: string) => {
    try {
      const a = await api.slideThemeAccess(id);
      if (a.ok) return;
      const p = await api.slideThemePicker(kind);
      if (p.kind === 'google') await pickDriveTemplate({ ...p, fileId: a.fileId }, kind);
    } catch {
      // 使えなければ、作るときに標準のデザインにして理由を出す
    }
  };
  return { themes, busy, error, mockItems, add, pickMock, remove, ensureAccess, closeMock: () => setMockItems(null) };
}

/**
 * デザインのカードの一覧。
 *
 * @param value 選んでいるもの（組み込みのデザインの ID、テーマの `theme:<ID>`、テンプレートの名前）
 * @param templates 会社が登録したテンプレート
 * @param themes Google スライドのテーマ（`useSlideThemes`）。無ければテーマを並べない
 */
export function SlideDesignPicker({ value, templates, onChange, themes }: {
  value: string; templates: SlideTemplateChoice[]; onChange: (v: string) => void; themes?: ReturnType<typeof useSlideThemes>;
}) {
  const choose = async (v: string) => {
    onChange(v);
    const t = themes?.themes.find((x) => `${SLIDE_THEME_PREFIX}${x.id}` === v);
    if (t?.company && themes) await themes.ensureAccess(t.id);
  };
  const added = async (v: string | null) => { if (v) onChange(v); };
  return (
    <>
      <div className="slide-design-grid" role="radiogroup">
        {SLIDE_DESIGNS.map((d) => (
          <button type="button" key={d.id} role="radio" aria-checked={value === d.id} title={d.description}
            className={`slide-design-card${value === d.id ? ' is-selected' : ''}`} onClick={() => onChange(d.id)}>
            <DesignPreview d={d} />
            <span className="slide-design-name">{d.name}</span>
          </button>
        ))}
        {themes?.themes.map((t) => {
          const v = `${SLIDE_THEME_PREFIX}${t.id}`;
          return (
            <div key={v} className={`slide-design-card is-theme${value === v ? ' is-selected' : ''}`}>
              <button type="button" role="radio" aria-checked={value === v} className="slide-design-pick" title={t.name} onClick={() => void choose(v)}>
                <ThemeThumb theme={t} />
                <span className="slide-design-name">{t.name}</span>
                <span className="slide-design-badge">{t.company ? '会社のテーマ' : 'マイテーマ'}</span>
              </button>
              {t.removable && (
                <button type="button" className="slide-design-remove" aria-label={`${t.name}を削除`} onClick={() => void themes.remove(t.id)}>×</button>
              )}
            </div>
          );
        })}
        {templates.map((t) => (
          <button type="button" key={`t:${t.name}`} role="radio" aria-checked={value === t.name} title={t.description || t.name}
            className={`slide-design-card is-template${value === t.name ? ' is-selected' : ''}`} onClick={() => onChange(t.name)}>
            <span className="slide-design-template">
              <span className="slide-design-badge">会社のテンプレート</span>
              <span className="small muted">{t.description}</span>
            </span>
            <span className="slide-design-name">{t.name}</span>
          </button>
        ))}
        {themes && (
          <div className="slide-design-card is-add">
            <button type="button" className="slide-design-pick" disabled={themes.busy} onClick={() => void themes.add().then(added)}>
              <span className="slide-design-plus" aria-hidden="true">＋</span>
              <span className="slide-design-name">{themes.busy ? '開いています…' : 'Google スライドのテーマ'}</span>
            </button>
            <a className="small" href={GALLERY_URL} target="_blank" rel="noreferrer">ギャラリー</a>
          </div>
        )}
      </div>
      {themes?.mockItems && (
        <div className="slide-theme-mock card">
          {themes.mockItems.length === 0 && <p className="muted small">見本のドライブにファイルがありません</p>}
          {themes.mockItems.map((f) => (
            <button key={f.id} type="button" className="btn ghost small" onClick={() => void themes.pickMock(f.id).then(added)}>{f.name}</button>
          ))}
          <button type="button" className="btn ghost small" onClick={themes.closeMock}>閉じる</button>
        </div>
      )}
      {themes?.error && <p className="error small">{themes.error}</p>}
    </>
  );
}

/**
 * 業務の入力の欄（形 `slide-design`）。会社のテンプレートと会社の既定を読み、初めは会社の既定を選んだ状態にする。
 */
export function SlideDesignField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [templates, setTemplates] = useState<SlideTemplateChoice[]>([]);
  const themes = useSlideThemes(false);
  useEffect(() => {
    let alive = true;
    api.slideDesigns().then((r) => {
      if (!alive) return;
      setTemplates(r.templates);
      if (!value) onChange(r.defaultChoice);
    }).catch(() => { if (alive && !value) onChange(SLIDE_DESIGNS[0]!.id); });
    return () => { alive = false; };
    // 読むのは開いたときの 1 回だけ（選び直しで読み直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="field">
      <label>{label}</label>
      <SlideDesignPicker value={value} templates={templates} onChange={onChange} themes={themes} />
    </div>
  );
}

/**
 * 文書のテンプレートの見本の並び（第9.5.5.2節「文書のテンプレート」）。「標準」、マイテンプレート・会社のテンプレート、「＋ Google ドキュメントのテンプレート」。
 *
 * @param value 選んでいるもの（「標準」か `theme:<ID>`）
 */
export function DocTemplatePicker({ value, onChange, templates }: {
  value: string; onChange: (v: string) => void; templates: ReturnType<typeof useSlideThemes>;
}) {
  const choose = async (v: string) => {
    onChange(v);
    const t = templates.themes.find((x) => `${SLIDE_THEME_PREFIX}${x.id}` === v);
    if (t?.company) await templates.ensureAccess(t.id);
  };
  const added = async (v: string | null) => { if (v) onChange(v); };
  return (
    <>
      <div className="slide-design-grid" role="radiogroup">
        <button type="button" role="radio" aria-checked={value === DOC_STANDARD}
          className={`slide-design-card is-template${value === DOC_STANDARD ? ' is-selected' : ''}`} onClick={() => onChange(DOC_STANDARD)}>
          <span className="slide-design-thumb doc-standard" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="slide-design-name">{DOC_STANDARD}</span>
        </button>
        {templates.themes.map((t) => {
          const v = `${SLIDE_THEME_PREFIX}${t.id}`;
          return (
            <div key={v} className={`slide-design-card is-theme${value === v ? ' is-selected' : ''}`}>
              <button type="button" role="radio" aria-checked={value === v} className="slide-design-pick" title={t.name} onClick={() => void choose(v)}>
                <ThemeThumb theme={t} />
                <span className="slide-design-name">{t.name}</span>
                <span className="slide-design-badge">{t.company ? '会社のテンプレート' : 'マイテンプレート'}</span>
              </button>
              {t.removable && (
                <button type="button" className="slide-design-remove" aria-label={`${t.name}を削除`} onClick={() => void templates.remove(t.id)}>×</button>
              )}
            </div>
          );
        })}
        <div className="slide-design-card is-add">
          <button type="button" className="slide-design-pick" disabled={templates.busy} onClick={() => void templates.add().then(added)}>
            <span className="slide-design-plus" aria-hidden="true">＋</span>
            <span className="slide-design-name">{templates.busy ? '開いています…' : 'Google ドキュメントのテンプレート'}</span>
          </button>
          <a className="small" href={DOC_GALLERY_URL} target="_blank" rel="noreferrer">ギャラリー</a>
        </div>
      </div>
      {templates.mockItems && (
        <div className="slide-theme-mock card">
          {templates.mockItems.length === 0 && <p className="muted small">見本のドライブにファイルがありません</p>}
          {templates.mockItems.map((f) => (
            <button key={f.id} type="button" className="btn ghost small" onClick={() => void templates.pickMock(f.id).then(added)}>{f.name}</button>
          ))}
          <button type="button" className="btn ghost small" onClick={templates.closeMock}>閉じる</button>
        </div>
      )}
      {templates.error && <p className="error small">{templates.error}</p>}
    </>
  );
}

/**
 * 業務の入力の欄（形 `doc-template`）。会社の既定を読み、初めは会社の既定を選んだ状態にする。
 */
export function DocTemplateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const templates = useSlideThemes(false, 'doc');
  useEffect(() => {
    let alive = true;
    api.docTemplateDefault().then((r) => { if (alive && !value) onChange(r.defaultChoice); }).catch(() => { if (alive && !value) onChange(DOC_STANDARD); });
    return () => { alive = false; };
    // 読むのは開いたときの 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="field">
      <label>{label}</label>
      <DocTemplatePicker value={value || DOC_STANDARD} onChange={onChange} templates={templates} />
    </div>
  );
}
