/**
 * @file クラウドの形の入口の守りと VPN の様子（仕様書 第23.8.7節「ネットワークの様子」）。運営の画面の「稼働状況」に出す。
 *
 * 入口の守り（CrowdSec・国の遮断・WAF・証明書）と VPN（WireGuard）の数は root でないと読めない。
 * VPS の上で root で 5 分ごとに動く `deploy/vps/edge/m2office-edge-status.mjs` が数だけを機械の置き場に書き、運営の API はそれを読むだけ。
 * 命令は打たない（運営の API に root の権限を持たせない）。相手の IP アドレス・鍵・WAF の記録の中身は、ファイルにも入れない。
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
  } | null;
  geo: {
    /** 止めている国（`CN,RU,KP`）。止めていなければ空。 */
    countries: string;
    /** 表を入れてから止めた、入ってくる通信と出ていく通信の数。 */
    inBlocked: number | null;
    outBlocked: number | null;
    /** 国のアドレスの一覧を最後に作った時刻。 */
    listAt: string | null;
  } | null;
  waf: {
    /** いまの動き（`DetectionOnly`: 記録だけ・`On`: 止める）。 */
    engine: string | null;
    /** 直近 24 時間に規則に当たった要求の数。 */
    hits24h: number | null;
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
  errors: string[];
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
}

/** 集める仕組みが止まっているとみなす長さ（15 分）。 */
export const EDGE_STATUS_STALE_MS = 15 * 60_000;
/** 証明書の期限を目立たせる残り（30 日）。 */
export const EDGE_CERT_SOON_MS = 30 * 86_400_000;
/** VPN の端末をつながっているとみなす、最後の接続からの長さ（3 分。WireGuard は使っている間 2 分ごとに鍵を交わす）。 */
export const EDGE_PEER_ONLINE_MS = 3 * 60_000;

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
  return {
    configured: !!last,
    last,
    stale: !!last && now - Date.parse(last.at) > EDGE_STATUS_STALE_MS,
    certSoon: Number.isFinite(nearest) && nearest - now < EDGE_CERT_SOON_MS,
    peers: (last?.vpn?.peers ?? []).map((p) => ({
      ...p,
      // 最後に集めた時刻で見る（集めた後の経過で、つながっていた端末を切れたことにしない）
      connected: !!p.lastHandshake && Date.parse(last!.at) - Date.parse(p.lastHandshake) <= EDGE_PEER_ONLINE_MS,
    })),
  };
}
