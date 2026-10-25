/**
 * @file スライドのデザインを見本の絵のカードから選ぶ部品（仕様書 第9.4.2節「組み込みのデザイン」）。
 *
 * 組み込みのデザイン（`SLIDE_DESIGNS`）は、表紙と本文の 2 枚を小さく描いた絵で、会社が登録したテンプレートは名前と説明のカードで並べる。
 * 見本の絵はデザインの定義（色・表紙の飾り）から描く（外へ取りに行かない。デザインを足せば絵も自動で増える）。
 * 「スライドの作成」の入力（形 `slide-design`）と、管理者ページの「スライドの見本」（会社の既定）で使う。
 */

import { useEffect, useState } from 'react';
import { SLIDE_DESIGNS, slideRgbCss, type SlideDesign } from '@m2office/shared';
import { api } from './api.js';

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

/**
 * デザインのカードの一覧。
 *
 * @param value 選んでいるもの（組み込みのデザインの ID か、テンプレートの名前）
 * @param templates 会社が登録したテンプレート
 */
export function SlideDesignPicker({ value, templates, onChange }: {
  value: string; templates: SlideTemplateChoice[]; onChange: (v: string) => void;
}) {
  return (
    <div className="slide-design-grid" role="radiogroup">
      {SLIDE_DESIGNS.map((d) => (
        <button type="button" key={d.id} role="radio" aria-checked={value === d.id} title={d.description}
          className={`slide-design-card${value === d.id ? ' is-selected' : ''}`} onClick={() => onChange(d.id)}>
          <DesignPreview d={d} />
          <span className="slide-design-name">{d.name}</span>
        </button>
      ))}
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
    </div>
  );
}

/**
 * 業務の入力の欄（形 `slide-design`）。会社のテンプレートと会社の既定を読み、初めは会社の既定を選んだ状態にする。
 */
export function SlideDesignField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [templates, setTemplates] = useState<SlideTemplateChoice[]>([]);
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
      <SlideDesignPicker value={value} templates={templates} onChange={onChange} />
    </div>
  );
}
