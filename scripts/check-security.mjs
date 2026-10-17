/**
 * @file 依存の既知の脆弱性の点検（仕様書 第16.11.3節 G-11・第14.3.2節の 8）。リリースの前と、週に 1 回の自動の点検で回す。
 *
 * `npm audit` で、ロックファイルに入っている依存（開発の道具を含む）の既知の脆弱性を数える。
 * 「高」以上が 1 つでもあれば 1 で終わる。点検の窓口（npm の登録所）に届かなければ 2 で終わり、「確かめられなかった」と示す（通ったとは言わない）。
 *
 * 使い方:
 *   npm run security:check
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const r = spawnSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(r.stdout || '{}');
} catch {
  report = null;
}
const counts = report?.metadata?.vulnerabilities;
if (!counts || report?.error) {
  console.error(`依存の脆弱性を確かめられませんでした（${report?.error?.summary ?? r.stderr?.trim().split('\n')[0] ?? '応答がありません'}）`);
  process.exit(2);
}
const label = { critical: '重大', high: '高', moderate: '中', low: '低', info: '情報' };
const found = Object.entries(report.vulnerabilities ?? {}).map(([name, v]) => ({ name, severity: v.severity, direct: v.isDirect, fix: !!v.fixAvailable }));
for (const v of found.sort((a, b) => Object.keys(label).indexOf(a.severity) - Object.keys(label).indexOf(b.severity))) {
  console.log(`- ${label[v.severity] ?? v.severity}: ${v.name}${v.direct ? '（直接の依存）' : ''}${v.fix ? '（直った版あり）' : '（直った版なし）'}`);
}
const serious = (counts.critical ?? 0) + (counts.high ?? 0);
console.log(`依存の脆弱性の点検: 重大 ${counts.critical ?? 0}・高 ${counts.high ?? 0}・中 ${counts.moderate ?? 0}・低 ${counts.low ?? 0}`);
if (serious > 0) {
  console.error('「高」以上の脆弱性があります。直った版に上げてから、リリースしてください');
  process.exit(1);
}
