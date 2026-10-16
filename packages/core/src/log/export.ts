/**
 * @file システムログの絞り方の読み取りと、ダウンロードの ZIP（仕様書 第16.10.4節）。管理者ページ（ローカルの形）とマスター管理画面（クラウドの形）で同じものを使う。
 */

import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { csvText } from '../files/sheet.js';
import type { SystemLogDigest, SystemLogFilter, SystemLogLine } from './store.js';

/** 画面の 1 回で返す行数。 */
export const SYSTEM_LOG_PAGE = 200;
/** ダウンロードの 1 回の上限の行数。 */
export const SYSTEM_LOG_EXPORT_MAX = 1_000_000;
/** 絞り方の言葉の長さの上限。 */
const Q_MAX = 200;
const LEVELS = ['error', 'warn', 'info'];
const SERVICES = ['api', 'worker', 'ops'];

/**
 * 画面の問い合わせを、システムログの絞り方にする。
 *
 * @param p `from`・`to`（ISO の時刻。既定は直近 1 時間）・`levels`（`error,warn`）・`service`・`q`・`requestId`・`runId`・`before`・`beforeId`
 * @param maxDays 範囲の上限（日）。超えたら `to` から数えて縮める
 */
export function parseLogFilter(p: Record<string, string | undefined>, opts: { limit: number; maxDays: number; now?: Date }): SystemLogFilter {
  const now = opts.now ?? new Date();
  const time = (v: string | undefined, fallback: Date) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t) : fallback;
  };
  const to = time(p['to'], now);
  let from = time(p['from'], new Date(to.getTime() - 3_600_000));
  if (to.getTime() - from.getTime() > opts.maxDays * 86_400_000) from = new Date(to.getTime() - opts.maxDays * 86_400_000);
  const levels = (p['levels'] ?? '').split(',').map((x) => x.trim()).filter((x) => LEVELS.includes(x));
  const before = p['before'] && Number.isFinite(Date.parse(p['before'])) && /^\d{1,19}$/.test(p['beforeId'] ?? '') ? { at: p['before'], id: p['beforeId']! } : null;
  return {
    from: from.toISOString(), to: to.toISOString(), levels: levels.length ? levels : null,
    service: SERVICES.includes(p['service'] ?? '') ? p['service']! : null,
    q: (p['q'] ?? '').trim().slice(0, Q_MAX) || null,
    requestId: (p['requestId'] ?? '').trim().slice(0, 100) || null,
    runId: (p['runId'] ?? '').trim().slice(0, 100) || null,
    before, limit: opts.limit,
  };
}

/** システムログを CSV にする（BOM 付き UTF-8。値は Excel に式として読ませない）。 */
export function logLinesCsv(lines: SystemLogLine[]): string {
  const head = ['時刻', 'レベル', 'プロセス', '文', '会社', '利用者', '要求 ID', '実行 ID', '項目'];
  const cell = (v: string) => {
    const s = csvText(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = lines.map((l) => [l.at, l.level, l.service, l.msg, l.tenantId ?? '', l.userId ?? '', l.requestId ?? '', l.runId ?? '', JSON.stringify(l.fields)].map(cell).join(','));
  return '﻿' + [head.join(','), ...rows].join('\r\n') + '\r\n';
}

/**
 * ダウンロードの ZIP（システムログと `manifest.json`）。
 *
 * @param meta 誰が・どの会社の・どう絞ったか（`manifest.json` に書く）
 * @param digests 範囲の日ごとの改ざんの確かめの値（作り直して比べたもの）
 */
export async function logExportZip(
  lines: SystemLogLine[], format: 'jsonl' | 'csv', meta: Record<string, unknown>, digests: SystemLogDigest[],
): Promise<Uint8Array> {
  const body = format === 'csv' ? logLinesCsv(lines) : lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  const bytes = new TextEncoder().encode(body);
  const name = `system-logs.${format}`;
  const zip = new JSZip();
  zip.file(name, bytes);
  zip.file('manifest.json', JSON.stringify({
    ...meta, generatedAt: new Date().toISOString(), lines: lines.length, truncated: lines.length >= SYSTEM_LOG_EXPORT_MAX,
    files: [{ path: name, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }],
    digests,
  }, null, 2));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
