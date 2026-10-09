/**
 * @file 遠隔の保守の開け閉めを決め、様子を書く（仕様書 第8.6.4節「遠隔の保守」）。maintenance.sh から呼ぶ。
 *
 * 使い方: node maintenance-state.mjs <「機械」の置き場> <トンネルが動いているか 0|1> [tailscale status --json の出力のファイル]
 * 標準出力に、行うこと（`up`・`down`・`none`）を 1 語で返す。開け閉めそのものは呼び出した maintenance.sh が行う。
 *
 * 会社の管理者が「機械」で開けた印（maintenance-request.json の期限）が切れていなければ開け、切れたら閉じる。
 * 開いている間に話した相手（Tailscale の機械の名前）を回ごとに残す。運営は自分で開けられない（印は会社の管理者だけが書く）。
 * 同じ機械の M2Medical が遠隔の保守を持つとき（`M2O_MAINT_FOREIGN=1`）は、開けも閉じもしない（第8.6.9節）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, runningArg, statusFile] = process.argv;
if (!dir || (runningArg !== '0' && runningArg !== '1')) {
  console.error('使い方: node maintenance-state.mjs <置き場> <0|1> [状態のファイル]');
  process.exit(2);
}
const read = (f, def) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return def; } };
const now = new Date(Number(process.env.M2O_NOW_MS || Date.now()));
const running = runningArg === '1';
const req = read(join(dir, 'maintenance-request.json'), {});
// ほかの製品が遠隔の保守を持つとき（M2O_MAINT_FOREIGN=1）は、開けてほしい印を見ない。開いていた M2Office の回は閉じたものとして残す
const foreign = process.env.M2O_MAINT_FOREIGN === '1';
const wanted = !foreign && !!req.until && Date.parse(req.until) > now.getTime();
const state = read(join(dir, 'maintenance.json'), { open: false, sessions: [] });
const sessions = Array.isArray(state.sessions) ? state.sessions : [];
const last = sessions[sessions.length - 1];
const openSession = last && !last.closedAt ? last : null;
// 話した相手（直近に通信のあった相手だけ）
const ts = statusFile ? read(statusFile, {}) : {};
const peers = Object.values(ts.Peer ?? {}).filter((p) => p && p.Active).map((p) => String(p.HostName || p.DNSName || '').replace(/\.$/, '')).filter(Boolean);

let action = 'none';
if (wanted) {
  if (!running) action = 'up';
  if (openSession) {
    openSession.until = req.until;
    openSession.peers = [...new Set([...(openSession.peers ?? []), ...peers])];
  } else {
    sessions.push({ openedAt: now.toISOString(), by: String(req.by ?? ''), until: req.until, closedAt: null, peers });
  }
} else {
  if (running && !foreign) action = 'down';
  if (openSession) {
    openSession.peers = [...new Set([...(openSession.peers ?? []), ...peers])];
    openSession.closedAt = now.toISOString();
  }
}
writeFileSync(join(dir, 'maintenance.json'), JSON.stringify({ open: wanted, checkedAt: now.toISOString(), sessions: sessions.slice(-20) }));
process.stdout.write(action);
