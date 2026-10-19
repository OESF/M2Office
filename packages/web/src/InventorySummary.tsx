/**
 * @file 在庫のサマリー（仕様書 第29.11節「一覧」。2026-10-19 に三浦さんが、いまの在庫の状況が一目で分かるよう求めた）。
 *
 * 秘書のひとこと（要発注・在庫切れ・期限切れを短く）と、数のカード（品目数・在庫切れ・要発注・本日の出庫・期限切れ・期限が近い・販売品の在庫額）。
 * カードを押すと、その状態で一覧を絞り込む。数は一覧と同じ計算で、絞り込みに関わらず会社の全体を数える。
 */
import { useEffect, useState } from 'react';
import { inventorySaleValue, type InventoryItemView } from '@m2office/shared';
import { api } from './api.js';
import { SecretaryAvatar } from './nav.js';

/** サマリーのカードを押したときに絞り込む状態。 */
export type SummaryFilter = 'out' | 'order' | 'expired' | 'expiring' | 'sale' | null;

/** 在庫切れ（使える数が 0 以下）。 */
export const isOut = (i: InventoryItemView) => i.status === 'active' && i.available <= 0;
/** 要発注（残りわずか、または仕入れにかかる日数より早く無くなりそう）。 */
export const needsOrder = (i: InventoryItemView, runningOut: Set<string>) => i.status === 'active' && (i.low || runningOut.has(i.id));

/**
 * 在庫のサマリー。
 *
 * @param items 会社の品目（絞り込む前のもの）
 * @param onFilter カードを押したとき（その状態で一覧を絞り込む）
 * @param onOrders 「発注の案を開く」を押したとき
 */
export function InventorySummary({ items, runningOut, todayOut, taxRounding, active, onFilter, onOrders }: {
  items: InventoryItemView[]; runningOut: string[]; todayOut: number; taxRounding: 'floor' | 'round' | 'ceil';
  active: SummaryFilter; onFilter: (f: SummaryFilter) => void; onOrders: () => void;
}) {
  const [secretary, setSecretary] = useState<{ name: string; avatar: string } | null>(null);
  useEffect(() => {
    api.mySettings().then((s) => setSecretary({ name: s.secretary.name || '秘書', avatar: s.secretary.avatar })).catch(() => setSecretary({ name: '秘書', avatar: '' }));
  }, []);
  const out = new Set(runningOut);
  const used = items.filter((i) => i.status === 'active');
  const jst = new Date(Date.now() + 9 * 3_600_000);
  const today = jst.toISOString().slice(0, 10);
  const soon = new Date(jst.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const n = {
    all: used.length,
    out: used.filter(isOut).length,
    order: used.filter((i) => needsOrder(i, out)).length,
    expired: used.filter((i) => i.expired > 0).length,
    expiring: used.filter((i) => !!i.nearestExpiry && i.nearestExpiry >= today && i.nearestExpiry <= soon).length,
  };
  const value = inventorySaleValue(used, taxRounding);
  // 数は 1 行に収める（単位は小さく添え、桁が多ければ字を小さくする）。説明も 1 行にそろえ、収まらない分は「…」（全文はマウスを重ねると出る）
  const card = (key: SummaryFilter, label: string, num: string, sub: string, tone: 'neutral' | 'danger' | 'warn' | 'ok' | 'accent', unit = '') => (
    <button type="button" className={`inv-card tone-${tone}${active === key && key ? ' active' : ''}`} disabled={!key}
      onClick={() => key && onFilter(active === key ? null : key)} aria-pressed={key ? active === key : undefined} title={`${label}: ${num}${unit}（${sub}）`}>
      <span className="inv-card-label">{label}</span>
      <strong className={`inv-card-num${num.length >= 9 ? ' longer' : num.length >= 7 ? ' long' : ''}`}>{num}{unit && <span className="inv-card-unit">{unit}</span>}</strong>
      <span className="inv-card-sub">{sub}</span>
    </button>
  );
  return (
    <section className="inv-summary" aria-label="在庫の状況">
      <div className="inv-say">
        <div className="inv-say-face">
          <span className="avatar">{secretary && <SecretaryAvatar avatar={secretary.avatar} />}</span>
          <span className="small muted">{secretary?.name ?? ''}</span>
        </div>
        <div className="inv-say-bubble">
          <div className="small muted">在庫の状況です。</div>
          {n.order > 0
            ? <div><span className="dot danger" />要発注が <strong className="inv-say-num">{n.order}</strong> 品あります。<button className="link-btn" onClick={onOrders}>発注の案を開く</button></div>
            : <div><span className="dot ok" />足りなくなりそうな品目はありません</div>}
          {n.out > 0 && <div><span className="dot danger" />在庫切れが <strong className="inv-say-num">{n.out}</strong> 品あります</div>}
          {n.expired > 0 && <div><span className="dot warn" />使用期限の切れたロットのある品目が <strong className="inv-say-num">{n.expired}</strong> 品あります</div>}
          <div><span className="dot neutral" />登録品目 <strong className="inv-say-num neutral">{n.all}</strong> 品</div>
        </div>
      </div>
      <div className="inv-cards">
        {card(null, '品目数', String(n.all), '使っている品目', 'neutral')}
        {card('out', '在庫切れ', String(n.out), '使える数が 0', n.out ? 'danger' : 'ok')}
        {card('order', '要発注', String(n.order), '残りわずか・無くなる見込み', n.order ? 'danger' : 'ok')}
        {card(null, '本日の出庫', String(todayOut), '今日の出庫の記録', 'accent')}
        {card('expired', '期限切れ', String(n.expired), '期限の切れたロットあり', n.expired ? 'warn' : 'ok')}
        {card('expiring', '期限が近い', String(n.expiring), '30 日以内', n.expiring ? 'warn' : 'ok')}
        {(value.counted > 0 || value.noPrice > 0) && card('sale', '販売品の在庫額', value.withTax.toLocaleString('ja-JP'), `税込・${value.counted} 品目${value.noPrice ? `（価格なし ${value.noPrice}）` : ''}`, 'accent', '円')}
      </div>
    </section>
  );
}
