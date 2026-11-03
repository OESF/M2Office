/**
 * @file 機械の資源の欄（仕様書 第23.8.7節「機械の資源の図」、Q-281）。「動いている環境」の欄のすぐ下に置く。
 *
 * CPU の負荷・メモリー・Swap・ディスク・データベースの接続を、全体に対する割合の棒（80% で注意・90% で危険の色）で出し、
 * CPU の負荷・メモリー・Swap・ディスクの直近 24 時間（7 日に切り替え）の推移を折れ線で出す。図のライブラリは使わず SVG で描く。
 * 機械の通信量（受信と送信）は単位が違うので、現在の速度・直近 24 時間の合計と、別の折れ線で出す（第23.8.7節「ネットワークの様子」）。
 * 色だけに頼らず、割合の数も必ず出す。取れなかった値は棒を出さずに「取得できなかった」と出す（推測で埋めない）。
 */

import { useCallback, useEffect, useMemo, useState, type PointerEvent } from 'react';
import type { RuntimeEnvironment, RuntimeNetTotal, RuntimeSampleDays, RuntimeSamplePoint } from '@m2office/shared';

/** 注意の色にする割合（%）。 */
export const RESOURCE_WARN = 80;
/** 危険の色にする割合（%）。 */
export const RESOURCE_DANGER = 90;

/** 割合から段階（注意・危険）を決める。 */
export const resourceLevel = (pct: number): 'ok' | 'warn' | 'danger' => (pct >= RESOURCE_DANGER ? 'danger' : pct >= RESOURCE_WARN ? 'warn' : 'ok');

/** バイトを 2 の累乗で数えて表す（1 GB 未満は MB）。 */
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const pctText = (p: number) => `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
/** 通信の速さ（Mbps。1 未満は kbps）。 */
export const mbpsText = (v: number) => (v >= 1 ? `${v < 10 ? v.toFixed(1) : Math.round(v)} Mbps` : `${Math.round(v * 1000)} kbps`);
/** 通信量（バイトを 10 の累乗で数える。回線の量の言い方に合わせる）。 */
export const trafficText = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
/** 通信の速さの図の縦軸の上（見やすい区切りに丸める）。 */
export function netAxisTop(max: number): number {
  for (const t of [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (max <= t) return t;
  return Math.ceil(max / 1000) * 1000;
}

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
const NET_SERIES = [
  { key: 'rxMbps', label: '受信速度' },
  { key: 'txMbps', label: '送信速度' },
] as const;
type NetKey = (typeof NET_SERIES)[number]['key'];

const W = 640;
const H = 200;
// 左は縦軸の目盛り（電話の幅では字を大きくする）が収まる幅
const PAD = { left: 54, right: 8, top: 12, bottom: 24 };

/** 日本の時刻での表し方。 */
const jst = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...o });

/** 1 本の線の道（点の間が 2 区切り以上あいたら線を切る。止まっていた間をつながない）。 */
function linePath<K extends string>(samples: readonly (RuntimeSamplePoint & Record<K, number | null>)[], key: K, step: number,
  x: (t: number) => number, y: (v: number) => number): string {
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
}

/**
 * 推移の折れ線。割合（%）の図と、通信の速さ（Mbps）の図で使う。
 *
 * @param days 1 日（5 分ごと）か 7 日（30 分ごと）
 * @param kind 割合の図か通信の図か
 */
function Trend({ samples, days, kind = 'pct' }: { samples: RuntimeSamplePoint[]; days: RuntimeSampleDays; kind?: 'pct' | 'net' }) {
  const [hover, setHover] = useState<number | null>(null);
  const end = Date.now();
  const start = end - days * 86_400_000;
  const step = (days > 1 ? 30 : 5) * 60_000;
  const series: readonly { key: SeriesKey | NetKey; label: string }[] = kind === 'net' ? NET_SERIES : SERIES;
  const top = useMemo(() => {
    if (kind === 'net') return netAxisTop(Math.max(0, ...samples.flatMap((s) => [s.rxMbps ?? 0, s.txMbps ?? 0])));
    const cpuMax = Math.max(0, ...samples.map((s) => s.cpu ?? 0));
    return cpuMax > 100 ? Math.ceil(cpuMax / 50) * 50 : 100;
  }, [samples, kind]);
  const x = (t: number) => PAD.left + ((t - start) / (end - start)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const valueText = (v: number) => (kind === 'net' ? mbpsText(v) : pctText(v));
  const gridValues = kind === 'net' ? [0, top / 2, top] : [0, 50, 100, ...(top > 100 ? [top] : [])];
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
  const label = kind === 'net' ? 'サーバーの通信速度の推移' : 'サーバーの資源の推移';
  return (
    <div className="rc-trend">
      <p className="rc-readout small" aria-live="polite">
        {h
          ? <>{jst(h.at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　{series.map((s) => `${s.label} ${h[s.key] === null ? '—' : valueText(h[s.key]!)}`).join('・')}</>
          : series.map((s) => <span key={s.key} className="rc-legend"><i className={`rc-swatch ${s.key}`} />{s.label}</span>)}
      </p>
      <svg className="rc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}（${days > 1 ? '7 日' : '24 時間'}）`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {gridValues.map((v) => (
          <g key={v}>
            <line className="rc-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="rc-axis" x={PAD.left - 4} y={y(v)} textAnchor="end" dominantBaseline="middle">{kind === 'net' ? (v === 0 ? '0' : mbpsText(v)) : `${v}%`}</text>
          </g>
        ))}
        {/* 通信の図には注意の線を引かない（回線の上限は契約によって違い、機械からは分からないため） */}
        {kind === 'pct' && <line className="rc-limit warn" x1={PAD.left} x2={W - PAD.right} y1={y(RESOURCE_WARN)} y2={y(RESOURCE_WARN)} />}
        {kind === 'pct' && <line className="rc-limit danger" x1={PAD.left} x2={W - PAD.right} y1={y(RESOURCE_DANGER)} y2={y(RESOURCE_DANGER)} />}
        {ticks.map((t) => (
          <text key={t} className="rc-axis" x={x(t)} y={H - 6} textAnchor="middle">
            {days > 1 ? jst(new Date(t).toISOString(), { month: 'numeric', day: 'numeric' }) : jst(new Date(t).toISOString(), { hour: '2-digit', minute: '2-digit' })}
          </text>
        ))}
        {series.map((s) => <path key={s.key} className={`rc-line ${s.key}`} d={linePath(samples, s.key, step, x, y)} />)}
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
  loadSamples: (days: RuntimeSampleDays) => Promise<{ samples: RuntimeSamplePoint[]; net?: RuntimeNetTotal }>;
  filesBytes?: number | null;
}) {
  const [days, setDays] = useState<RuntimeSampleDays>(1);
  const [samples, setSamples] = useState<RuntimeSamplePoint[] | null>(null);
  const [net, setNet] = useState<RuntimeNetTotal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => {
    loadSamples(days).then((r) => { setSamples(r.samples); setNet(r.net ?? null); setError(null); }).catch(() => setError('推移を読み込めませんでした'));
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
      <h3>サーバーの資源</h3>
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
      {samples && <NetSection samples={samples} net={net} days={days} />}
    </div>
  );
}

/**
 * 機械の通信量（第23.8.7節「ネットワークの様子」）。現在の速度（いちばん新しい点）と直近 24 時間の合計、速度の折れ線。
 * 読めない OS・記録の無いときは「取得できなかった」と出す（推測で埋めない）。
 */
function NetSection({ samples, net, days }: { samples: RuntimeSamplePoint[]; net: RuntimeNetTotal | null; days: RuntimeSampleDays }) {
  const last = [...samples].reverse().find((s) => s.rxMbps !== null || s.txMbps !== null) ?? null;
  const has = !!last || net?.rx != null || net?.tx != null;
  return (
    <>
      <div className="rc-trend-head"><h4>ネットワーク</h4></div>
      {!has ? <p className="muted small">取得できなかった</p> : (
        <>
          <dl className="kv rc-net">
            <dt>現在の速度</dt>
            <dd>{last ? `受信 ${last.rxMbps === null ? '—' : mbpsText(last.rxMbps)}・送信 ${last.txMbps === null ? '—' : mbpsText(last.txMbps)}` : '—'}</dd>
            <dt>直近 24 時間の合計</dt>
            <dd>{net && (net.rx !== null || net.tx !== null) ? `受信 ${net.rx === null ? '—' : trafficText(net.rx)}・送信 ${net.tx === null ? '—' : trafficText(net.tx)}` : '—'}</dd>
          </dl>
          {last && <Trend samples={samples} days={days} kind="net" />}
        </>
      )}
    </>
  );
}
