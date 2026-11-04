/**
 * @file 入口の守りと VPN の様子を集める（仕様書 第23.8.7節「ネットワークの様子」）。m2office-edge-status.timer が 5 分ごとに root で呼ぶ。
 *
 * CrowdSec・国の遮断・WAF・証明書・WireGuard の数は root でないと読めないので、ここで集めて**数だけ**を
 * `/var/lib/m2office/machine/edge-status.json`（だれでも読めるが、書けるのは root だけ）に書く。運営の API はそれを読むだけ。
 * 相手の IP アドレス・鍵・WAF の記録の中身はファイルに入れない。読めなかった部分は `null` にし、理由を `errors` に残す（推測で埋めない）。
 * 攻撃と WAF は、直近 24 時間の種類と国（数だけ）と、ふだんと比べるための 7 日の数も書く（第23.8.7節「セキュリティの状態」）。
 * 国の遮断の数は積み上がった数しか無いので、7 日分の前の値を `edge-history.json`（root だけが読み書きする）に残し、差を出す。
 * 推移の図のため、攻撃・WAF・国の遮断の数を、直近 24 時間は 1 時間ごと、7 日は日本時間の 1 日ごとに区切って書く（第23.8.7節「セキュリティの推移」）。
 * 記録は journalctl -u m2office-edge-status。
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;
/** 種類と国を、多い順にいくつまで書くか（画面は 5 つまで出す。同じ種類にまとめた後でも 5 つ残るよう多めに書く）。 */
const TOP_KEEP = 20;
/** WAF の記録を、今のファイルからいくつ前まで読むか（毎日入れ替えるので 7 日分。`.1` はまだ縮めていない）。 */
const WAF_DAYS = 7;

/** 置き場（試すときは環境変数で替える）。 */
export const PATHS = {
  out: process.env.M2O_EDGE_STATUS_FILE ?? '/var/lib/m2office/machine/edge-status.json',
  history: process.env.M2O_EDGE_HISTORY_FILE ?? '/var/lib/m2office/machine/edge-history.json',
  setupConf: process.env.M2O_SETUP_CONF ?? '/etc/m2office/setup.conf',
  geoConf: process.env.M2O_GEO_CONF ?? '/etc/m2office/geo.conf',
  geoDir: process.env.M2O_GEO_DIR ?? '/var/lib/m2office/geo',
  wafLog: process.env.M2O_WAF_LOG ?? '/var/log/caddy/waf-audit.log',
  certDir: process.env.M2O_CADDY_CERTS ?? '/var/lib/caddy/.local/share/caddy/certificates',
};

/** `KEY='値'` の設定のファイルから 1 つ読む（無ければ `null`）。 */
export function confValue(text, key) {
  const m = new RegExp(`^${key}='?([^'\\n]*)'?$`, 'm').exec(text);
  return m ? m[1] : null;
}

/**
 * CrowdSec のいま止めている相手を、このサーバーで見つけたものと、分け合う一覧のものに分けて数える。
 *
 * @param decisionsJson `cscli decisions list --all --limit 0 -o json` の出力（止めている相手が無ければ `null`）
 */
export function countDecisions(decisionsJson) {
  const alerts = JSON.parse(decisionsJson || 'null') ?? [];
  let local = 0; let shared = 0;
  for (const a of alerts) {
    for (const d of a.decisions ?? []) {
      // このサーバーの見張り（crowdsec）と手で足したもの（cscli）は自分の、それ以外（CAPI・lists）は分け合う一覧
      if (d.origin === 'crowdsec' || d.origin === 'cscli') local++; else shared++;
    }
  }
  return { local, shared };
}

/** `nft list counter` の出力から、止めた数（packets）を読む。 */
export function nftPackets(text) {
  const m = /packets (\d+)/.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

/** 数えた表を、多い順の `[{ key, count }]` にする（同じ数なら名前の順）。 */
function topOf(map) {
  return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_KEEP).map(([key, count]) => ({ key, count }));
}
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/**
 * CrowdSec の 7 日の攻撃の記録から、直近 24 時間と 7 日の数、直近 24 時間の見張りの名前ごと・国ごとの数を出す。
 * 分け合う一覧の取り込み（見張りの名前が `update : +N/-M IPs`）は攻撃ではないので数えない。相手の IP アドレスは捨てる。
 *
 * @param alerts `cscli alerts list --since 168h --limit 0 -o json` を読んだもの
 * @returns 国の分からない攻撃は、国を空の文字（`''`）で数える
 */
export function summarizeAlerts(alerts, now) {
  let alerts24h = 0; let alerts7d = 0;
  const scenarios = new Map(); const countries = new Map();
  for (const a of alerts ?? []) {
    const scenario = String(a?.scenario ?? '');
    if (/^update\s*:/i.test(scenario)) continue;
    const at = Date.parse(a?.created_at ?? a?.start_at ?? '');
    if (!Number.isFinite(at) || at < now - 7 * DAY_MS) continue;
    alerts7d++;
    if (at < now - DAY_MS) continue;
    alerts24h++;
    bump(scenarios, scenario || '不明');
    bump(countries, typeof a?.source?.cn === 'string' ? a.source.cn.toUpperCase() : '');
  }
  return { alerts24h, alerts7d, scenarios24h: topOf(scenarios), countries24h: topOf(countries) };
}

/**
 * WAF の記録の 1 行を読む。当たった規則が無い行（応答が 400 番台・500 番台だったので残った行など）と、読めない行は `null`。
 * 第 0.515.4 版から記録に残すのは規則に当たった要求だけだが、それより前に残った行もあるので、ここでも外す。
 *
 * @returns 時刻（ミリ秒）と、当たった規則の印
 */
function wafHit(line) {
  if (!line.trim()) return null;
  try {
    const j = JSON.parse(line);
    const t = j.transaction ?? {};
    const messages = j.messages ?? t.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const at = typeof t.unix_timestamp === 'number' ? t.unix_timestamp / 1e6 : Date.parse(t.timestamp ?? '');
    if (!Number.isFinite(at)) return null;
    return { at, tags: messages.flatMap((m) => m?.data?.tags ?? m?.tags ?? []) };
  } catch { return null; /* 途中で切れた行など */ }
}

/**
 * WAF の記録（1 行 1 件の JSON）から、直近 24 時間と 7 日に規則に当たった要求の数と、直近 24 時間の規則の分類ごとの数を出す。
 * 分類は、当たった規則の印（OWASP の規則の `attack-*`）のうち最初のもの。無ければ空の文字（`''`）。要求の中身は読まない。
 * 当たった規則の無い行と読めない行は飛ばす。
 */
export function summarizeWaf(text, now) {
  let hits24h = 0; let hits7d = 0;
  const kinds = new Map();
  for (const line of text.split('\n')) {
    const hit = wafHit(line);
    if (!hit || hit.at < now - 7 * DAY_MS) continue;
    hits7d++;
    if (hit.at < now - DAY_MS) continue;
    hits24h++;
    bump(kinds, hit.tags.find((tag) => typeof tag === 'string' && tag.startsWith('attack-')) ?? '');
  }
  return { hits24h, hits7d, kinds24h: topOf(kinds) };
}

/** WAF の記録を 7 日分つなげて読む（今のファイル・`.1`・縮めた `.2.gz` 以降）。今のファイルが無ければ `null`。 */
function readWafLogs(path) {
  if (!existsSync(path)) return null;
  const parts = [readText(path), readText(`${path}.1`)];
  for (let i = 2; i <= WAF_DAYS; i++) {
    try { parts.push(gunzipSync(readFileSync(`${path}.${i}.gz`)).toString('utf8')); } catch { /* まだ無い */ }
  }
  return parts.join('\n');
}

/**
 * 国の遮断の直近 24 時間に止めた数を、残した前の値との差で出す。表を入れ直して数が戻ったときは、戻った後の数を差とする。
 * 24 時間分の前の値がまだ無いときは、残っているいちばん古い値からの差（短い間の数）になる。
 *
 * @param history 前の値（`[{ at, inBlocked, outBlocked }]`。古い順）
 * @param current いまの値
 */
export function geoDelta24h(history, current, now) {
  const points = [...history.filter((h) => Date.parse(h.at) >= now - DAY_MS - 10 * 60_000), { at: new Date(now).toISOString(), ...current }];
  const delta = (key) => {
    if (current[key] === null || current[key] === undefined) return null;
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1][key]; const cur = points[i][key];
      if (typeof cur !== 'number') continue;
      sum += typeof prev === 'number' && cur >= prev ? cur - prev : (typeof prev === 'number' ? cur : 0);
    }
    return sum;
  };
  return { in24h: delta('inBlocked'), out24h: delta('outBlocked') };
}

/** 残す前の値（推移の図の 7 日分と 1 時間より古いものは捨てる）。 */
export function nextHistory(history, result, now) {
  const kept = history.filter((h) => Date.parse(h.at) >= now - 7 * DAY_MS - 60 * 60_000);
  if (result.geo && (result.geo.inBlocked !== null || result.geo.outBlocked !== null)) {
    kept.push({ at: result.at, inBlocked: result.geo.inBlocked, outBlocked: result.geo.outBlocked });
  }
  return kept;
}

/**
 * `wg show wg0 dump` の出力から、端末ごとの網の中のアドレスと最後につながった時刻を読む（鍵は捨てる）。
 * 1 行目は VPN の口の行。2 行目からは「公開鍵・共有鍵・相手の場所・許すアドレス・最後の接続・受けた量・送った量・保つ間隔」。
 */
export function wgPeers(dump) {
  return dump.trim().split('\n').slice(1).filter(Boolean).map((line) => {
    const f = line.split('\t');
    const address = (f[3] ?? '').split(',')[0].replace(/\/32$/, '') || '不明';
    const hs = Number(f[4]);
    return { address, lastHandshake: hs > 0 ? new Date(hs * 1000).toISOString() : null };
  });
}

/** 証明書の置き場の下の `.crt` を探し、数といちばん近い期限を出す。 */
export function certSummary(dir) {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.crt')) files.push(p); } };
  walk(dir);
  let nearest = null;
  for (const f of files) {
    const to = Date.parse(new X509Certificate(readFileSync(f)).validTo);
    if (Number.isFinite(to) && (nearest === null || to < nearest)) nearest = to;
  }
  return { count: files.length, nearest: nearest === null ? null : new Date(nearest).toISOString() };
}

/** 外の命令を動かす（失敗なら投げる）。 */
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

/** 攻撃の記録の時刻（ミリ秒）。分け合う一覧の取り込みは除く（`summarizeAlerts` と同じ）。 */
export function alertTimes(alerts) {
  return (alerts ?? []).filter((a) => !/^update\s*:/i.test(String(a?.scenario ?? '')))
    .map((a) => Date.parse(a?.created_at ?? a?.start_at ?? '')).filter(Number.isFinite);
}

/** WAF の記録の時刻（ミリ秒）。読めない行は飛ばす。 */
export function wafTimes(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const hit = wafHit(line);
    if (hit) out.push(hit.at);
  }
  return out;
}

/** 推移の区切り。直近 24 時間は時の始まりから 1 時間ごと（24 本）、7 日は日本時間の 0 時から 1 日ごと（7 本）。最後の区切りは途中まで。 */
export function trendBuckets(now) {
  const HOUR = 3_600_000; const JST = 9 * HOUR;
  const hour = Math.floor(now / HOUR) * HOUR;
  const day = Math.floor((now + JST) / DAY_MS) * DAY_MS - JST;
  return {
    hours: Array.from({ length: 24 }, (_, i) => ({ from: hour - (23 - i) * HOUR, to: hour - (22 - i) * HOUR })),
    days: Array.from({ length: 7 }, (_, i) => ({ from: day - (6 - i) * DAY_MS, to: day - (5 - i) * DAY_MS })),
  };
}

/**
 * 攻撃・WAF・国の遮断の数を、推移の区切りごとに数える（第23.8.7節「セキュリティの推移」）。読めなかった材料は `null`。
 * 国の遮断は、前の値と次の値の差を、次の値の時刻の区切りに足す（表を入れ直して数が戻ったときは、戻った後の数を差とする）。
 *
 * @param input `alerts`・`waf` は時刻の並び、`geo` は前の値といまの値（古い順。`{ at, inBlocked, outBlocked }`）
 */
export function summarizeTrend(input, now) {
  const { hours, days } = trendBuckets(now);
  const count = (times, b) => (times ? times.filter((t) => t >= b.from && t < b.to).length : null);
  const geo = input.geo ?? null;
  const geoSum = (key, b) => {
    if (!geo) return null;
    let sum = 0;
    for (let i = 1; i < geo.length; i++) {
      const at = Date.parse(geo[i].at);
      if (!(at >= b.from && at < b.to)) continue;
      const prev = geo[i - 1][key]; const cur = geo[i][key];
      if (typeof cur !== 'number') continue;
      sum += typeof prev === 'number' && cur >= prev ? cur - prev : (typeof prev === 'number' ? cur : 0);
    }
    return sum;
  };
  const point = (b) => ({ at: new Date(b.from).toISOString(), alerts: count(input.alerts, b), waf: count(input.waf, b), geoIn: geoSum('inBlocked', b), geoOut: geoSum('outBlocked', b) });
  return { hours: hours.map(point), days: days.map(point) };
}

/** 残した前の値を読む（無い・壊れているときは空）。 */
function readHistory() {
  try { const j = JSON.parse(readFileSync(PATHS.history, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}

/**
 * 集める。部分ごとに失敗しても止めず、`null` と理由を残す。
 *
 * @param history 国の遮断の前の値（直近 24 時間の差を出すため）
 */
export function collect(now = Date.now(), run = sh, history = []) {
  const errors = [];
  const part = (name, fn) => { try { return fn(); } catch (e) { errors.push(`${name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`); return null; } };
  // 推移の図の材料（読めなかったものは null のまま）
  const trendIn = { alerts: null, waf: null, geo: null };

  const crowdsec = part('CrowdSec', () => {
    const { local, shared } = countDecisions(run('cscli', ['decisions', 'list', '--all', '--limit', '0', '-o', 'json']));
    const alerts = JSON.parse(run('cscli', ['alerts', 'list', '--since', '168h', '--limit', '0', '-o', 'json']) || 'null') ?? [];
    trendIn.alerts = alertTimes(alerts);
    return { local, shared, ...summarizeAlerts(alerts, now) };
  });

  const geo = part('国の遮断', () => {
    if (!existsSync(PATHS.geoConf)) throw new Error(`${PATHS.geoConf} がありません`);
    const conf = confValue(readText(PATHS.geoConf), 'BLOCK_COUNTRIES') ?? '';
    if (!conf || conf.toUpperCase() === 'NONE') return { countries: '', inBlocked: null, outBlocked: null, in24h: null, out24h: null, listAt: null };
    const countries = readText(join(PATHS.geoDir, 'countries')).trim() || conf.toUpperCase();
    const counter = (name) => nftPackets(run('nft', ['list', 'counter', 'inet', 'm2office_geo', name]));
    let listAt = null;
    try { listAt = statSync(join(PATHS.geoDir, 'geo.nft')).mtime.toISOString(); } catch { /* まだ作っていない */ }
    const current = { inBlocked: counter('in_blocked'), outBlocked: counter('out_blocked') };
    trendIn.geo = [...history, { at: new Date(now).toISOString(), ...current }];
    return { countries, ...current, ...geoDelta24h(history, current, now), listAt };
  });

  const waf = part('WAF', () => {
    const engine = confValue(readText(PATHS.setupConf), 'WAF_ENGINE');
    // 記録が無ければ数えられない（0 件とは言えない）。毎日入れ替えるので、前の日までのファイルも見る
    const text = readWafLogs(PATHS.wafLog);
    if (text === null) { errors.push(`WAF: ${PATHS.wafLog} がありません`); return { engine, hits24h: null, hits7d: null, kinds24h: [] }; }
    trendIn.waf = wafTimes(text);
    return { engine, ...summarizeWaf(text, now) };
  });

  const certs = part('証明書', () => certSummary(PATHS.certDir));

  const vpn = part('VPN', () => ({ peers: wgPeers(run('wg', ['show', 'wg0', 'dump'])) }));

  return { at: new Date(now).toISOString(), crowdsec, geo, waf, certs, vpn, trend: summarizeTrend(trendIn, now), errors };
}

/** 書く（書きかけを読まれないよう、別の名前に書いてから入れ替える）。 */
function write(path, value, mode) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const now = Date.now();
  const history = readHistory();
  const result = collect(now, sh, history);
  write(PATHS.out, result, 0o644);
  write(PATHS.history, nextHistory(history, result, now), 0o600);
  if (result.errors.length) console.error(`読めなかったもの: ${result.errors.join(' ／ ')}`);
}
