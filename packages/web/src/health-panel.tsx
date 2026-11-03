/**
 * @file 稼働状況の全体の状態（仕様書 第23.8.7節「全体の状態」）。いちばん上の「全体の状態」「対応が要るもの」「区分ごとの札」と、各表の上に置く区分の知らせ。
 *
 * 判断は API が行い（core の `opsHealth`）、ここは出すだけ。運営の画面の「稼働状況」と、ローカルの形の「サーバー」で同じものを使う。
 * 区分の札を押すと、同じ画面の詳しい表（`health-区分` の id）へ移る。手順は運営者マニュアルの章か、ほかの画面を開く（開き方は呼ぶ側が決める）。
 */

import type { ReactNode } from 'react';

/** 状態（平常・注意・警戒）。 */
export type HealthLevel = 'normal' | 'caution' | 'alert';
/** 区分。 */
export type HealthArea = 'jobs' | 'resources' | 'backup' | 'security' | 'external' | 'runtime' | 'tenants' | 'ai';

/** 対応が要るもの 1 件（API の `health.items`）。 */
export interface HealthItemRow {
  area: HealthArea;
  level: 'caution' | 'alert';
  title: string;
  detail: string | null;
  action: string;
  /** 手順。マニュアルの章（`07-server`）か、ほかの画面（`page:tenants`）。 */
  guide: string;
}

/** 全体の状態（API の `health`）。 */
export interface HealthViewRow {
  level: HealthLevel;
  items: HealthItemRow[];
  areas: { area: HealthArea; label: string; level: HealthLevel; summary: string }[];
}

/** 状態の札の色と言葉。 */
export const HEALTH_LEVEL: Record<HealthLevel, { badge: string; text: string }> = {
  normal: { badge: 'ok', text: '平常' }, caution: { badge: 'warn', text: '注意' }, alert: { badge: 'danger', text: '警戒' },
};

/** 詳しい表の id（区分の札を押すと移る）。 */
export const healthAnchor = (area: HealthArea) => `health-${area}`;

/** 手順の言葉（マニュアルの章か、ほかの画面か）。 */
const guideLabel = (guide: string) => (guide === 'page:tenants' ? '会社一覧を開く' : guide === 'page:settings' ? '設定を開く' : '手順を見る');

/** 対応が要るものの一覧（警戒が先。API が並べた順）。 */
function HealthItems({ items, onGuide }: { items: HealthItemRow[]; onGuide: (guide: string) => void }) {
  return (
    <ul className="health-items">
      {items.map((it, i) => (
        <li key={`${it.area}-${i}`} className={`health-item ${it.level}`}>
          <span className={`badge ${HEALTH_LEVEL[it.level].badge}`}>{HEALTH_LEVEL[it.level].text}</span>
          <div className="health-body">
            <strong>{it.title}</strong>
            {it.detail && <span className="small muted">{it.detail}</span>}
            <span className="health-action">すること: {it.action}{' '}<button type="button" className="link-btn" onClick={() => onGuide(it.guide)}>{guideLabel(it.guide)}</button></span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * いちばん上の 3 段（全体の状態・対応が要るもの・区分ごとの札）。
 *
 * @param health API が決めた全体の状態
 * @param onGuide 手順を開く（マニュアルの章 ID か `page:…`）
 * @param tools 帯の右に置く操作（「更新」など）
 * @param checkedAt 最後に読んだ時刻（帯に出す）
 */
export function HealthPanel({ health, onGuide, tools, checkedAt }: { health: HealthViewRow; onGuide: (guide: string) => void; tools?: ReactNode; checkedAt?: string | null }) {
  const lv = HEALTH_LEVEL[health.level];
  const alerts = health.items.filter((i) => i.level === 'alert').length;
  const cautions = health.items.length - alerts;
  const go = (area: HealthArea, guide?: string) => {
    if (guide) { onGuide(guide); return; }
    document.getElementById(healthAnchor(area))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // 会社と AI の費用は、ほかの画面にある（会社一覧・設定）
  const elsewhere: Partial<Record<HealthArea, string>> = { tenants: 'page:tenants', ai: 'page:settings' };
  return (
    <section className={`health-panel ${health.level}`} aria-label="全体の状態">
      <div className="health-banner">
        <span className="health-level">{lv.text}</span>
        <span>{health.items.length === 0 ? '対応が要るものはありません' : `対応が要るもの ${health.items.length} 件（警戒 ${alerts}・注意 ${cautions}）`}</span>
        <span className="spacer" />
        {checkedAt && <span className="small">{checkedAt}</span>}
        {tools}
      </div>
      {health.items.length > 0 && <HealthItems items={health.items} onGuide={onGuide} />}
      <div className="health-tiles">
        {health.areas.map((a) => (
          <button type="button" key={a.area} className={`health-tile ${a.level}`} onClick={() => go(a.area, elsewhere[a.area])}>
            <span className="health-tile-head">{a.label}<span className={`badge ${HEALTH_LEVEL[a.level].badge}`}>{HEALTH_LEVEL[a.level].text}</span></span>
            <span className="small muted">{a.summary}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * 詳しい表の上に置く、その区分の対応が要るもの（無ければ何も出さない）。
 *
 * @param areas 出す区分（稼働環境とサーバーの資源のように、1 つの欄に 2 つの区分があるときは両方）
 */
export function HealthNotes({ health, areas, onGuide }: { health: HealthViewRow | null; areas: HealthArea[]; onGuide: (guide: string) => void }) {
  const items = (health?.items ?? []).filter((i) => areas.includes(i.area));
  return items.length ? <HealthItems items={items} onGuide={onGuide} /> : null;
}
