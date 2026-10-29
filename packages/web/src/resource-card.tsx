/**
 * @file 機械の資源の欄（仕様書 第23.8.7節「機械の資源の図」、Q-281）。「動いている環境」の欄のすぐ下に置く。
 *
 * CPU の負荷・メモリー・Swap・ディスク・データベースの接続を、全体に対する割合の棒（80% で注意・90% で危険の色）で出し、
 * CPU の負荷・メモリー・Swap・ディスクの直近 24 時間（7 日に切り替え）の推移を折れ線で出す。図のライブラリは使わず SVG で描く。
 * 色だけに頼らず、割合の数も必ず出す。取れなかった値は棒を出さずに「取得できなかった」と出す（推測で埋めない）。
 */

import { useCallback, useEffect, useMemo, useState, type PointerEvent } from 'react';
import type { RuntimeEnvironment, RuntimeSampleDays, RuntimeSamplePoint } from '@m2office/shared';

/** 注意の色にする割合（%）。 */
export const RESOURCE_WARN = 80;
/** 危険の色にする割合（%）。 */
export const RESOURCE_DANGER = 90;

/** 割合から段階（注意・危険）を決める。 */
export const resourceLevel = (pct: number): 'ok' | 'warn' | 'danger' => (pct >= RESOURCE_DANGER ? 'danger' : pct >= RESOURCE_WARN ? 'warn' : 'ok');

/** バイトを 2 の累乗で数えて表す（1 GB 未満は MB）。 */
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const pctText = (p: number) => `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;

/** 1 つの資源の棒。`pct` が `null` なら「取得できなかった」（または `none` の文）。 */
function Meter({ label, pct, text, sub, none }: { label: string; pct: number | null; text?: string; sub?: string; none?: string }) {
  if (pct === null) {
    return (
      <div className="rc-row">
        <span className="rc-label">{label}</span>
        <span className="rc-none muted">{none ?? '取得できなかった'}</span>
      </div>
    );
  }
  const level = resourceLevel(pct);
  return (
    <div className="rc-row">
      <span className="rc-label">{label}</span>
      <span className="rc-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <span className={`rc-fill ${level}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className={`rc-value ${level}`}>
        <strong>{pctText(pct)}</strong>{text && <span className="small muted">（{text}）</span>}
        {sub && <span className="rc-sub small muted">{sub}</span>}
      </span>
    </div>
  );
}

const SERIES = [
  { key: 'cpu', label: 'CPU の負荷' },
  { key: 'memory', label: 'メモリー' },
  { key: 'swap', label: 'Swap' },
  { key: 'disk', label: 'ディスク' },
] as const;
type SeriesKey = (typeof SERIES)[number]['key'];

const W = 640;
const H = 200;
// 左は縦軸の目盛り（電話の幅では字を大きくする）が収まる幅
const PAD = { left: 54, right: 8, top: 12, bottom: 24 };

/** 日本の時刻での表し方。 */
const jst = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...o });

/**
 * 推移の折れ線。点の間が 2 区切り以上あいたら線を切る（止まっていた間をつながない）。
 *
 * @param days 1 日（5 分ごと）か 7 日（30 分ごと）
 */
function Trend({ samples, days }: { samples: RuntimeSamplePoint[]; days: RuntimeSampleDays }) {
  const [hover, setHover] = useState<number | null>(null);
  const end = Date.now();
  const start = end - days * 86_400_000;
  const step = (days > 1 ? 30 : 5) * 60_000;
  const top = useMemo(() => {
    const cpuMax = Math.max(0, ...samples.map((s) => s.cpu ?? 0));
    return cpuMax > 100 ? Math.ceil(cpuMax / 50) * 50 : 100;
  }, [samples]);
  const x = (t: number) => PAD.left + ((t - start) / (end - start)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const path = (key: SeriesKey) => {
    let d = '';
    let prev: number | null = null;
    for (const s of samples) {
      const v = s[key];
      const t = Date.parse(s.at);
      if (v === null) { prev = null; continue; }
      // 線の始まりには短い線を足す（前後が無い 1 点だけでも、丸い端で点として見える）
      d += prev === null || t - prev > step * 2.5 ? `M${x(t).toFixed(1)},${y(v).toFixed(1)}h0.1` : `L${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      prev = t;
    }
    return d;
  };
  // 横軸の目盛り: 1 日は 6 時間ごと、7 日は 1 日ごと（日本の時刻の区切り）
  const ticks = useMemo(() => {
    const unit = days > 1 ? 86_400_000 : 6 * 3_600_000;
    const offset = 9 * 3_600_000;
    const out: number[] = [];
    for (let t = Math.ceil((start + offset) / unit) * unit - offset; t <= end; t += unit) out.push(t);
    return out;
  }, [start, end, days]);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!samples.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = start + (((e.clientX - r.left) / r.width) * W - PAD.left) / (W - PAD.left - PAD.right) * (end - start);
    let best = 0;
    samples.forEach((s, i) => { if (Math.abs(Date.parse(s.at) - t) < Math.abs(Date.parse(samples[best]!.at) - t)) best = i; });
    setHover(best);
  };
  const h = hover !== null ? samples[hover] : null;
  return (
    <div className="rc-trend">
      <p className="rc-readout small" aria-live="polite">
        {h
          ? <>{jst(h.at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　{SERIES.map((s) => `${s.label} ${h[s.key] === null ? '—' : pctText(h[s.key]!)}`).join('・')}</>
          : SERIES.map((s) => <span key={s.key} className="rc-legend"><i className={`rc-swatch ${s.key}`} />{s.label}</span>)}
      </p>
      <svg className="rc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`機械の資源の推移（${days > 1 ? '7 日' : '24 時間'}）`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {[0, 50, 100, ...(top > 100 ? [top] : [])].map((v) => (
          <g key={v}>
            <line className="rc-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="rc-axis" x={PAD.left - 4} y={y(v)} textAnchor="end" dominantBaseline="middle">{v}%</text>
          </g>
        ))}
        <line className="rc-limit warn" x1={PAD.left} x2={W - PAD.right} y1={y(RESOURCE_WARN)} y2={y(RESOURCE_WARN)} />
        <line className="rc-limit danger" x1={PAD.left} x2={W - PAD.right} y1={y(RESOURCE_DANGER)} y2={y(RESOURCE_DANGER)} />
        {ticks.map((t) => (
          <text key={t} className="rc-axis" x={x(t)} y={H - 6} textAnchor="middle">
            {days > 1 ? jst(new Date(t).toISOString(), { month: 'numeric', day: 'numeric' }) : jst(new Date(t).toISOString(), { hour: '2-digit', minute: '2-digit' })}
          </text>
        ))}
        {SERIES.map((s) => <path key={s.key} className={`rc-line ${s.key}`} d={path(s.key)} />)}
        {h && <line className="rc-cursor" x1={x(Date.parse(h.at))} x2={x(Date.parse(h.at))} y1={PAD.top} y2={H - PAD.bottom} />}
      </svg>
    </div>
  );
}

/**
 * 機械の資源の欄。
 *
 * @param env 動いている環境（「動いている環境」の欄と同じもの。1 分ごとに読み直される）
 * @param loadSamples 推移を読む口（管理者ページは `/admin/machine/runtime/samples`、運営は `/ops/runtime/samples`）
 * @param filesBytes ファイルの置き場の使用量（ディスクの内訳に添える。分からなければ省く）
 */
export function ResourceCard({ env, loadSamples, filesBytes }: {
  env: RuntimeEnvironment;
  loadSamples: (days: RuntimeSampleDays) => Promise<{ samples: RuntimeSamplePoint[] }>;
  filesBytes?: number | null;
}) {
  const [days, setDays] = useState<RuntimeSampleDays>(1);
  const [samples, setSamples] = useState<RuntimeSamplePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => {
    loadSamples(days).then((r) => { setSamples(r.samples); setError(null); }).catch(() => setError('推移を読み込めませんでした'));
  }, [loadSamples, days]);
  useEffect(() => { read(); const t = window.setInterval(read, 300_000); return () => clearInterval(t); }, [read]);

  const m = env.machine;
  const cpu = m?.load && m.cores ? (m.load[0] / m.cores) * 100 : null;
  const mem = m?.memTotal && m.memFree !== null ? (1 - m.memFree / m.memTotal) * 100 : null;
  const swapNone = m?.swapTotal === 0;
  const swap = m?.swapTotal && m.swapFree !== null ? (1 - m.swapFree / m.swapTotal) * 100 : null;
  const disk = m?.diskTotal && m.diskFree !== null ? (1 - m.diskFree / m.diskTotal) * 100 : null;
  const db = env.database;
  const diskParts = [db ? `データベース ${size(db.bytes)}` : null, filesBytes != null ? `ファイル ${size(filesBytes)}` : null].filter(Boolean);
  return (
    <div className="card resource-card">
      <h3>機械の資源</h3>
      <div className="rc-meters">
        <Meter label="CPU の負荷" pct={cpu}
          text={m?.load && m.cores ? `1 分 ${m.load[0].toFixed(2)}・5 分 ${m.load[1].toFixed(2)}・15 分 ${m.load[2].toFixed(2)} ／ ${m.cores} コア` : undefined} />
        <Meter label="メモリー" pct={mem} text={mem !== null ? `${size(m!.memTotal! - m!.memFree!)} ／ ${size(m!.memTotal!)}` : undefined} />
        <Meter label="Swap" pct={swapNone ? null : swap} none={swapNone ? 'なし' : undefined}
          text={swap !== null ? `${size(m!.swapTotal! - m!.swapFree!)} ／ ${size(m!.swapTotal!)}` : undefined} />
        <Meter label="ディスク" pct={disk} text={disk !== null ? `${size(m!.diskTotal! - m!.diskFree!)} ／ ${size(m!.diskTotal!)}` : undefined}
          sub={disk !== null && diskParts.length ? `うち ${diskParts.join('・')}` : undefined} />
        <Meter label="データベースの接続" pct={db && db.max ? (db.connections / db.max) * 100 : null} text={db ? `${db.connections} ／ ${db.max}` : undefined} />
      </div>
      <div className="rc-trend-head">
        <h4>推移</h4>
        <div className="seg" role="group" aria-label="推移の長さ">
          <button type="button" className={days === 1 ? 'on' : ''} onClick={() => setDays(1)}>24 時間</button>
          <button type="button" className={days === 7 ? 'on' : ''} onClick={() => setDays(7)}>7 日</button>
        </div>
      </div>
      {error ? <p className="error">{error}</p>
        : !samples ? null
          : samples.length === 0 ? <p className="muted small">まだ記録がありません</p>
            : <Trend samples={samples} days={days} />}
    </div>
  );
}
