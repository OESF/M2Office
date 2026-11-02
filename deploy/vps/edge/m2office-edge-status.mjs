/**
 * @file 入口の守りと VPN の様子を集める（仕様書 第23.8.7節「ネットワークの様子」）。m2office-edge-status.timer が 5 分ごとに root で呼ぶ。
 *
 * CrowdSec・国の遮断・WAF・証明書・WireGuard の数は root でないと読めないので、ここで集めて**数だけ**を
 * `/var/lib/m2office/machine/edge-status.json`（だれでも読めるが、書けるのは root だけ）に書く。運営の API はそれを読むだけ。
 * 相手の IP アドレス・鍵・WAF の記録の中身はファイルに入れない。読めなかった部分は `null` にし、理由を `errors` に残す（推測で埋めない）。
 * 記録は journalctl -u m2office-edge-status。
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;

/** 置き場（試すときは環境変数で替える）。 */
export const PATHS = {
  out: process.env.M2O_EDGE_STATUS_FILE ?? '/var/lib/m2office/machine/edge-status.json',
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
 * CrowdSec のいま止めている相手を、この機械で見つけたものと、分け合う一覧のものに分けて数える。
 *
 * @param decisionsJson `cscli decisions list --all --limit 0 -o json` の出力（止めている相手が無ければ `null`）
 */
export function countDecisions(decisionsJson) {
  const alerts = JSON.parse(decisionsJson || 'null') ?? [];
  let local = 0; let shared = 0;
  for (const a of alerts) {
    for (const d of a.decisions ?? []) {
      // この機械の見張り（crowdsec）と手で足したもの（cscli）は自分の、それ以外（CAPI・lists）は分け合う一覧
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

/**
 * WAF の記録（1 行 1 件の JSON）から、`since` より後に規則に当たった要求の数を数える。読めない行は飛ばす。
 *
 * @param since この時刻（ミリ秒）より後だけを数える
 */
export function countWafHits(text, since) {
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line).transaction ?? {};
      const at = typeof t.unix_timestamp === 'number' ? t.unix_timestamp / 1e6 : Date.parse(t.timestamp ?? '');
      if (Number.isFinite(at) && at >= since) n++;
    } catch { /* 途中で切れた行など */ }
  }
  return n;
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

/** 集める。部分ごとに失敗しても止めず、`null` と理由を残す。 */
export function collect(now = Date.now(), run = sh) {
  const errors = [];
  const part = (name, fn) => { try { return fn(); } catch (e) { errors.push(`${name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`); return null; } };

  const crowdsec = part('CrowdSec', () => {
    const { local, shared } = countDecisions(run('cscli', ['decisions', 'list', '--all', '--limit', '0', '-o', 'json']));
    const alerts = JSON.parse(run('cscli', ['alerts', 'list', '--since', '24h', '--limit', '0', '-o', 'json']) || 'null') ?? [];
    return { local, shared, alerts24h: alerts.length };
  });

  const geo = part('国の遮断', () => {
    if (!existsSync(PATHS.geoConf)) throw new Error(`${PATHS.geoConf} がありません`);
    const conf = confValue(readText(PATHS.geoConf), 'BLOCK_COUNTRIES') ?? '';
    if (!conf || conf.toUpperCase() === 'NONE') return { countries: '', inBlocked: null, outBlocked: null, listAt: null };
    const countries = readText(join(PATHS.geoDir, 'countries')).trim() || conf.toUpperCase();
    const counter = (name) => nftPackets(run('nft', ['list', 'counter', 'inet', 'm2office_geo', name]));
    let listAt = null;
    try { listAt = statSync(join(PATHS.geoDir, 'geo.nft')).mtime.toISOString(); } catch { /* まだ作っていない */ }
    return { countries, inBlocked: counter('in_blocked'), outBlocked: counter('out_blocked'), listAt };
  });

  const waf = part('WAF', () => {
    const engine = confValue(readText(PATHS.setupConf), 'WAF_ENGINE');
    // 記録が無ければ数えられない（0 件とは言えない）。毎日入れ替えるので、前の日のファイル（.1）も見る
    const hits24h = existsSync(PATHS.wafLog) ? countWafHits(readText(PATHS.wafLog) + '\n' + readText(`${PATHS.wafLog}.1`), now - DAY_MS) : null;
    if (hits24h === null) errors.push(`WAF: ${PATHS.wafLog} がありません`);
    return { engine, hits24h };
  });

  const certs = part('証明書', () => certSummary(PATHS.certDir));

  const vpn = part('VPN', () => ({ peers: wgPeers(run('wg', ['show', 'wg0', 'dump'])) }));

  return { at: new Date(now).toISOString(), crowdsec, geo, waf, certs, vpn, errors };
}

/** 結果を書く（書きかけを読まれないよう、別の名前に書いてから入れ替える）。 */
function write(result) {
  const tmp = `${PATHS.out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result)}\n`);
  chmodSync(tmp, 0o644);
  renameSync(tmp, PATHS.out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = collect();
  write(result);
  if (result.errors.length) console.error(`読めなかったもの: ${result.errors.join(' ／ ')}`);
}
