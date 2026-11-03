/**
 * @file クラウドの形の入口の守りと VPN の様子（仕様書 第23.8.7節「ネットワークの様子」）。運営の画面の「稼働状況」に出す。
 *
 * 入口の守り（CrowdSec・国の遮断・WAF・証明書）と VPN（WireGuard）の数は root でないと読めない。
 * VPS の上で root で 5 分ごとに動く `deploy/vps/edge/m2office-edge-status.mjs` が数だけを機械の置き場に書き、運営の API はそれを読むだけ。
 * 命令は打たない（運営の API に root の権限を持たせない）。相手の IP アドレス・鍵・WAF の記録の中身は、ファイルにも入れない。
 * 数から「平常」「注意」「警戒」の状態と理由を決め、攻撃と WAF の種類を日本語の種類にまとめる（第23.8.7節「セキュリティの状態」）。
 */

import { readFile } from 'node:fs/promises';

/** 集めた結果（`edge-status.json`）。読めなかった部分は `null` で、理由を `errors` に残す。 */
export interface EdgeStatus {
  at: string;
  crowdsec: {
    /** いま止めている相手のうち、この機械で見つけたもの。 */
    local: number | null;
    /** いま止めている相手のうち、世界中の利用者と分け合う一覧のもの。 */
    shared: number | null;
    /** 直近 24 時間に見つけた攻撃の数。 */
    alerts24h: number | null;
    /** 直近 7 日に見つけた攻撃の数（ふだんと比べるため。第 0.510.0 版より前の結果には無い）。 */
    alerts7d?: number;
    /** 直近 24 時間の攻撃の、見張りの名前ごとの数（多い順）。 */
    scenarios24h?: EdgeCount[];
    /** 直近 24 時間の攻撃の、国（ISO 3166 の 2 文字。分からなければ空）ごとの数（多い順）。 */
    countries24h?: EdgeCount[];
  } | null;
  geo: {
    /** 止めている国（`CN,RU,KP`）。止めていなければ空。 */
    countries: string;
    /** 表を入れてから止めた、入ってくる通信と出ていく通信の数。 */
    inBlocked: number | null;
    outBlocked: number | null;
    /** 直近 24 時間に止めた、入ってくる通信と出ていく通信の数（第 0.510.0 版より前の結果には無い）。 */
    in24h?: number | null;
    out24h?: number | null;
    /** 国のアドレスの一覧を最後に作った時刻。 */
    listAt: string | null;
  } | null;
  waf: {
    /** いまの動き（`DetectionOnly`: 記録だけ・`On`: 止める）。 */
    engine: string | null;
    /** 直近 24 時間に規則に当たった要求の数。 */
    hits24h: number | null;
    /** 直近 7 日に規則に当たった要求の数（第 0.510.0 版より前の結果には無い）。 */
    hits7d?: number | null;
    /** 直近 24 時間の、当たった規則の分類（OWASP の `attack-*`。無ければ空）ごとの数（多い順）。 */
    kinds24h?: EdgeCount[];
  } | null;
  certs: {
    count: number;
    /** いちばん近い期限。 */
    nearest: string | null;
  } | null;
  vpn: {
    /** 登録した端末ごとの網の中のアドレスと、最後につながった時刻（つながったことが無ければ `null`）。 */
    peers: { address: string; lastHandshake: string | null }[];
  } | null;
  /** 推移（第23.8.7節「セキュリティの推移」。第 0.514.0 版より前の結果には無い）。 */
  trend?: { hours: EdgeTrendPoint[]; days: EdgeTrendPoint[] };
  errors: string[];
}

/** 推移の 1 区切り（`at` は区切りの始まり）。読めなかった材料は `null`。 */
export interface EdgeTrendPoint {
  at: string;
  alerts: number | null;
  waf: number | null;
  geoIn: number | null;
  geoOut: number | null;
}

/** 名前ごとの数（集める仕組みが多い順に書く）。 */
export interface EdgeCount {
  key: string;
  count: number;
}

/** セキュリティの状態（平常・注意・警戒）。 */
export type EdgeLevel = 'normal' | 'caution' | 'alert';

/** 当てはまった理由の 1 つ。`action` はすること（決めた文。AI に作らせない）。 */
export interface EdgeFinding {
  level: 'caution' | 'alert';
  text: string;
  action: string;
}

/** 入口の守りと VPN の様子（運営の画面の形）。 */
export interface EdgeStatusView {
  /** 結果のファイルがあるか（無ければ、まだ入れていない）。 */
  configured: boolean;
  last: EdgeStatus | null;
  /** 最後に集めたのが 15 分より前（集める仕組みが止まっている）。 */
  stale: boolean;
  /** 証明書のいちばん近い期限が 30 日を切った。 */
  certSoon: boolean;
  /** 端末ごとの、いまつながっているか（最後の接続が 3 分以内）。 */
  peers: { address: string; lastHandshake: string | null; connected: boolean }[];
  /** 状態（入れていなければ `null`）。 */
  level: EdgeLevel | null;
  /** 当てはまった理由（警戒の理由を先に）。 */
  reasons: string[];
  /** 理由ごとの状態とすること（`reasons` と同じ順。第23.8.7節「全体の状態」）。 */
  findings: EdgeFinding[];
  /** 直近 24 時間に来たもの（多い順に 5 つまで）。攻撃の種類・攻撃の国（ISO の 2 文字。分からなければ空）・WAF に当たった要求の種類。 */
  top: { kinds: { label: string; count: number }[]; countries: EdgeCount[]; waf: { label: string; count: number }[] };
}

/** 集める仕組みが止まっているとみなす長さ（15 分）。 */
export const EDGE_STATUS_STALE_MS = 15 * 60_000;
/** 証明書の期限を目立たせる残り（30 日）。 */
export const EDGE_CERT_SOON_MS = 30 * 86_400_000;
/** VPN の端末をつながっているとみなす、最後の接続からの長さ（3 分。WireGuard は使っている間 2 分ごとに鍵を交わす）。 */
export const EDGE_PEER_ONLINE_MS = 3 * 60_000;

/** 急に増えたとみなす、ふだんに対する倍率（3 倍）。 */
export const EDGE_SURGE_RATIO = 3;
/** 急に増えたとみなす件数の下限（ふだんが少ないときに、数件の増えで注意にしない）。攻撃は 20 件、WAF は 100 件。 */
export const EDGE_SURGE_MIN = { alerts: 20, waf: 100 } as const;
/** 画面に出す種類と国の数。 */
export const EDGE_TOP = 5;

/**
 * CrowdSec の見張りの名前を、まとめる種類。上から順に当てはめ、どれにも当たらなければ元の名前のまま出す（推測で言い換えない）。
 * 名前は `crowdsecurity/http-probing` の形（`/` の前は作者）。
 */
const ALERT_KINDS: [RegExp, string][] = [
  [/ssh.*(bf|brute)/, 'SSH のログインの総当たり'],
  [/(^|[-_])(bf|bruteforce)([-_]|$)/, 'ログインの総当たり'],
  [/(cve|vpatch|exploit|log4j|spring4shell|thinkphp)/, '既知の弱点を突く要求'],
  [/sqli/, 'SQL インジェクション'],
  [/xss/, 'クロスサイトスクリプティング'],
  [/(sensitive-files|backdoor|admin-interface|path-traversal)/, '管理画面・秘密のファイルの探り'],
  [/(wordpress|wp-)/, 'WordPress の弱点の探り'],
  [/(bad-user-agent|scan)/, '攻撃の道具による調べ'],
  [/crawl/, '大量の巡回'],
  [/probing/, '存在しないページの探り'],
  [/(dos|flood)/, '大量の要求'],
  [/open-proxy/, '中継の悪用の試み'],
];

/** WAF の規則の分類（OWASP の規則の印）の言い換え。無いものは元の印のまま出す。 */
const WAF_KINDS: Record<string, string> = {
  '': '分類なし',
  'attack-sqli': 'SQL インジェクション',
  'attack-xss': 'クロスサイトスクリプティング',
  'attack-rce': 'OS の命令の注入',
  'attack-lfi': 'サーバーのファイルの読み出し',
  'attack-rfi': '外のファイルの読み込み',
  'attack-php': 'PHP の弱点を突く要求',
  'attack-injection-php': 'PHP の弱点を突く要求',
  'attack-java': 'Java の弱点を突く要求',
  'attack-nodejs': 'Node.js の弱点を突く要求',
  'attack-protocol': '決まりに反する要求',
  'attack-multipart-header': '決まりに反する要求',
  'attack-reputation-scanner': '攻撃の道具による調べ',
  'attack-fixation': 'セッションの乗っ取り',
  'attack-disclosure': '情報の漏れ（応答）',
  'attack-generic': 'そのほかの攻撃',
};

/** CrowdSec の見張りの名前を種類にする。 */
export function alertKindLabel(scenario: string): string {
  const name = scenario.slice(scenario.lastIndexOf('/') + 1).toLowerCase();
  return ALERT_KINDS.find(([re]) => re.test(name))?.[1] ?? scenario;
}

/** WAF の規則の分類を種類にする。 */
export function wafKindLabel(tag: string): string {
  return WAF_KINDS[tag] ?? tag;
}

/** 同じ種類にまとめ、多い順に `EDGE_TOP` まで残す。 */
function mergeTop(rows: EdgeCount[] | undefined, label: (key: string) => string): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows ?? []) m.set(label(r.key), (m.get(label(r.key)) ?? 0) + r.count);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).slice(0, EDGE_TOP).map(([l, count]) => ({ label: l, count }));
}

/**
 * 直近 24 時間の数が、ふだん（その前の 6 日間の 1 日あたりの平均）より急に増えたか。
 *
 * @returns 増えていれば、ふだんの数（四捨五入）。増えていない・比べられなければ `null`
 */
export function edgeSurge(day: number | null | undefined, week: number | null | undefined, min: number): number | null {
  if (typeof day !== 'number' || typeof week !== 'number' || day < min) return null;
  const usual = Math.max(0, week - day) / 6;
  return day >= usual * EDGE_SURGE_RATIO ? Math.round(usual) : null;
}

/**
 * 状態と理由を決める（第23.8.7節「セキュリティの状態」）。
 *
 * @param stale 集める仕組みが止まっている
 * @param certSoon 証明書の期限が 30 日を切った
 */
export function edgeLevel(last: EdgeStatus, stale: boolean, certSoon: boolean, now: number): { level: EdgeLevel; reasons: string[]; findings: EdgeFinding[] } {
  const found: EdgeFinding[] = [];
  const add = (level: EdgeFinding['level'], text: string, action: string) => found.push({ level, text, action });
  const n = (v: number) => v.toLocaleString('ja-JP');
  if (stale) add('alert', '集める仕組みが止まっています', 'いまの様子が分かりません。技術者に知らせる（journalctl -u m2office-edge-status）');
  if (typeof last.geo?.out24h === 'number' && last.geo.out24h > 0) {
    add('alert', `出ていく通信を国の遮断で止めました（直近 24 時間 ${n(last.geo.out24h)} 件）`, 'サーバーの中から止めた国へつなごうとしているものがあります。乗っ取りを疑い、すぐに技術者に連絡する');
  }
  const nearest = last.certs?.nearest ? Date.parse(last.certs.nearest) : NaN;
  if (Number.isFinite(nearest) && nearest <= now) add('alert', '証明書の期限が切れています', '利用者が画面を開けません。すぐに技術者に連絡する（証明書の自動の更新が止まっている）');
  else if (certSoon) add('caution', '証明書の期限まで 30 日を切りました', 'ふつうは自動で延びます。数日たっても延びなければ、技術者に知らせる');
  const cs = last.crowdsec;
  const csUsual = edgeSurge(cs?.alerts24h, cs?.alerts7d, EDGE_SURGE_MIN.alerts);
  if (csUsual !== null) {
    add('caution', `攻撃が急に増えました（直近 24 時間 ${n(cs!.alerts24h!)} 件・ふだん ${n(csUsual)} 件）`, '止める役は働いています。セキュリティの表で種類と国を確かめ、2 日続いたら技術者に知らせる');
  }
  const wafUsual = edgeSurge(last.waf?.hits24h, last.waf?.hits7d, EDGE_SURGE_MIN.waf);
  if (wafUsual !== null) {
    add('caution', `WAF に当たる要求が急に増えました（直近 24 時間 ${n(last.waf!.hits24h!)} 件・ふだん ${n(wafUsual)} 件）`, 'セキュリティの表で種類を確かめ、技術者に知らせる（WAF が「記録だけ」の間は止めていない）');
  }
  if (cs?.shared === 0) add('caution', 'CrowdSec が中央とつながっていません', '世界中で分け合う一覧が届いていません。技術者に知らせる');
  if (last.errors.length > 0) add('caution', '一部を読めませんでした', 'セキュリティの表の「取得できなかった」を確かめ、技術者に知らせる');
  const findings = [...found.filter((f) => f.level === 'alert'), ...found.filter((f) => f.level === 'caution')];
  return { level: findings.some((f) => f.level === 'alert') ? 'alert' : findings.length ? 'caution' : 'normal', reasons: findings.map((f) => f.text), findings };
}

/** 結果のファイルを読む（無い・壊れているときは `null`）。 */
export async function readEdgeStatus(file: string): Promise<EdgeStatus | null> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as EdgeStatus;
    return typeof j.at === 'string' && Array.isArray(j.errors) ? j : null;
  } catch {
    return null;
  }
}

/**
 * 運営の画面の形にする。
 *
 * @param last 結果（無ければ「入れていない」）
 */
export function edgeStatusView(last: EdgeStatus | null, now: number = Date.now()): EdgeStatusView {
  const nearest = last?.certs?.nearest ? Date.parse(last.certs.nearest) : NaN;
  const stale = !!last && now - Date.parse(last.at) > EDGE_STATUS_STALE_MS;
  const certSoon = Number.isFinite(nearest) && nearest - now < EDGE_CERT_SOON_MS;
  const judged = last ? edgeLevel(last, stale, certSoon, now) : null;
  return {
    configured: !!last,
    last,
    stale,
    certSoon,
    level: judged?.level ?? null,
    reasons: judged?.reasons ?? [],
    findings: judged?.findings ?? [],
    top: {
      kinds: mergeTop(last?.crowdsec?.scenarios24h, alertKindLabel),
      countries: (last?.crowdsec?.countries24h ?? []).slice(0, EDGE_TOP),
      waf: mergeTop(last?.waf?.kinds24h, wafKindLabel),
    },
    peers: (last?.vpn?.peers ?? []).map((p) => ({
      ...p,
      // 最後に集めた時刻で見る（集めた後の経過で、つながっていた端末を切れたことにしない）
      connected: !!p.lastHandshake && Date.parse(last!.at) - Date.parse(p.lastHandshake) <= EDGE_PEER_ONLINE_MS,
    })),
  };
}
