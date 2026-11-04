/**
 * @file セキュリティの推移（仕様書 第23.8.7節「セキュリティの推移」）。攻撃・WAF に当たった要求・国の遮断で止めた通信の数を、
 * 直近 24 時間は 1 時間ごと、7 日は 1 日ごとの棒で出す。運営の画面の「稼働状況」の「セキュリティ」に置く。
 *
 * 数の桁が区分ごとに違うので、区分ごとに小さな図を並べ、図ごとに目盛りを持つ。出ていく通信は、国の遮断の図に危険の色で重ねる。
 * 図のライブラリは使わず SVG で描く。棒の上でマウスを動かすと、その区切りの時刻と、どの図も同じ区切りの数を出す。
 */

import { useState } from 'react';
import type { EdgeTrendPointRow } from './ops-api.js';

/** 図の大きさ（SVG の単位）。 */
const W = 300;
const H = 72;
/** 上の余白。目盛りの上の数をここに書き、いちばん高い棒と重ならないようにする。 */
const PAD_TOP = 12;
const PAD_BOTTOM = 14;

/** 区切りの呼び名（24 時間は「13 時」、7 日は「11/3」）。 */
function bucketLabel(at: string, period: 'hours' | 'days'): string {
  const d = new Date(at);
  return period === 'hours' ? `${d.getHours()} 時` : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 目盛りの上（見やすい区切りに丸める。0 件だけなら 1）。 */
function axisTop(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= max) ?? max;
}

/**
 * 1 つの区分の棒の図。
 *
 * @param values 区切りごとの数（読めなかった区切りは `null`）
 * @param over 重ねる数（国の遮断の出ていく通信）
 * @param hover いまマウスのある区切り
 * @param onHover マウスのある区切りが変わった
 */
function Bars({ label, values, over, period, points, hover, onHover }: {
  label: string; values: (number | null)[]; over?: (number | null)[]; period: 'hours' | 'days';
  points: EdgeTrendPointRow[]; hover: number | null; onHover: (i: number | null) => void;
}) {
  const top = axisTop(Math.max(0, ...values.map((v) => v ?? 0), ...(over ?? []).map((v) => v ?? 0)));
  const slot = W / values.length;
  const barW = Math.max(2, slot * 0.7);
  const y = (v: number) => PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - v / top);
  const total = values.reduce<number>((n, v) => n + (v ?? 0), 0);
  // 目盛りの字（はじめ・まんなか・終わりの区切り）。はじめは左、終わりは右にそろえ、図の外にはみ出して隣の図の字と重ならないようにする
  const ticks: [number, 'start' | 'middle' | 'end', number][] = [
    [0, 'start', 0],
    [Math.floor(values.length / 2), 'middle', Math.floor(values.length / 2) * slot + slot / 2],
    [values.length - 1, 'end', W],
  ];
  return (
    <figure className="et-chart">
      <figcaption className="small"><span>{label}</span><span className="muted">{hover !== null ? `${bucketLabel(points[hover]!.at, period)} ${values[hover] ?? '—'}${over && (over[hover] ?? 0) > 0 ? `（出ていく ${over[hover]}）` : ''}` : `計 ${total.toLocaleString('ja-JP')}`}</span></figcaption>
      <svg className="et-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}の推移（${period === 'hours' ? '24 時間' : '7 日'}）`}
        onMouseLeave={() => onHover(null)}>
        <line className="et-grid" x1={0} x2={W} y1={y(0)} y2={y(0)} />
        <text className="et-axis" x={W} y={PAD_TOP - 3} textAnchor="end">{top.toLocaleString('ja-JP')}</text>
        {values.map((v, i) => (
          <g key={points[i]!.at} onMouseEnter={() => onHover(i)}>
            {/* マウスを受ける透明な枠（棒が低くても選べるように） */}
            <rect x={i * slot} y={0} width={slot} height={H - PAD_BOTTOM} fill="transparent" />
            {v !== null && v > 0 && <rect className={`et-bar${hover === i ? ' on' : ''}`} x={i * slot + (slot - barW) / 2} y={y(v)} width={barW} height={y(0) - y(v)} />}
            {over && (over[i] ?? 0) > 0 && <rect className="et-bar over" x={i * slot + (slot - barW) / 2} y={y(over[i]!)} width={barW} height={y(0) - y(over[i]!)} />}
          </g>
        ))}
        {ticks.map(([i, anchor, x]) => <text key={i} className="et-axis" x={x} y={H - 2} textAnchor={anchor}>{bucketLabel(points[i]!.at, period)}</text>)}
      </svg>
    </figure>
  );
}

/**
 * セキュリティの推移の欄。前の版の集める仕組みの結果（推移が無い）のときは、何も出さない。
 *
 * @param trend 集める仕組みが書いた推移
 */
export function EdgeTrend({ trend }: { trend: { hours: EdgeTrendPointRow[]; days: EdgeTrendPointRow[] } | undefined }) {
  const [period, setPeriod] = useState<'hours' | 'days'>('hours');
  const [hover, setHover] = useState<number | null>(null);
  if (!trend || trend.hours.length === 0) return null;
  const points = trend[period];
  const pick = (k: 'alerts' | 'waf' | 'geoIn' | 'geoOut') => points.map((p) => p[k]);
  // 材料を読めなかった区分（どの区切りも null）は図を出さない
  const has = (vs: (number | null)[]) => vs.some((v) => v !== null);
  const change = (p: 'hours' | 'days') => { setPeriod(p); setHover(null); };
  return (
    <div className="et">
      <div className="rc-trend-head">
        <h4>推移</h4>
        <div className="seg" role="group" aria-label="推移の長さ">
          <button type="button" className={period === 'hours' ? 'on' : ''} onClick={() => change('hours')}>24 時間</button>
          <button type="button" className={period === 'days' ? 'on' : ''} onClick={() => change('days')}>7 日</button>
        </div>
      </div>
      <div className="et-charts">
        {has(pick('alerts')) && <Bars label="攻撃" values={pick('alerts')} period={period} points={points} hover={hover} onHover={setHover} />}
        {has(pick('waf')) && <Bars label="WAF に当たった要求" values={pick('waf')} period={period} points={points} hover={hover} onHover={setHover} />}
        {has(pick('geoIn')) && <Bars label="国の遮断で止めた通信" values={pick('geoIn')} over={pick('geoOut')} period={period} points={points} hover={hover} onHover={setHover} />}
      </div>
    </div>
  );
}
