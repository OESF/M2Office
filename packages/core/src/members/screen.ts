/**
 * @file 店頭サイネージに流す会員の特典の 1 枚（仕様書 第40.19節）。いま使える特典を、ポイントの少ない順に 6 つまで 1 枚に組む。
 *
 * 字は M2Office が組む（生成 AI に字を描かせない。お知らせのサイネージの画面と同じ書体と色）。会社の名前・会員の名前は出さない。
 * 中身（特典の名前・ポイント・使える人）と帯の色の印が同じなら作り直さない。作り直したら前の 1 枚を消し、すべての画面の流れの先頭に足す。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMBER_LIMITS, minRankText, type MemberReward } from '@m2office/shared';
import { renderSvgPng } from '../columns/cover.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../announcements/screen-image.js';
import type { SignageService } from '../signage/service.js';
import { thumbnailPng } from '../signage/thumbnail.js';

/** 素材を足す・消すときの操作した人（監査ログ）。 */
const ACTOR = 'system';
const HEX = /^#[0-9a-fA-F]{6}$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s);

/** 1 行の特典（使える人の書き方つき）。 */
export interface RewardLine {
  name: string;
  points: number;
  /** 「ゴールドだけ」「誕生月」など（全員なら空） */
  who: string;
}

/** 流す特典の行（純粋な関数）。ポイントの少ない順に 6 つまで。 */
export function rewardLines(rewards: MemberReward[]): RewardLine[] {
  return [...rewards].sort((a, b) => a.points - b.points).slice(0, MEMBER_LIMITS.signageRewardsMax).map((r) => ({
    name: r.name, points: r.points, who: [r.birthdayOnly ? '誕生月' : '', minRankText(r.minRank)].filter(Boolean).join('・'),
  }));
}

/** 1 枚の SVG（白い地に、上の帯「会員の特典」・見出し・特典の表・一言）。 */
export function rewardScreenSvg(lines: RewardLine[], color: string | null): string {
  const W = SCREEN_WIDTH;
  const H = SCREEN_HEIGHT;
  const accent = color && HEX.test(color) ? color : '#1f3a5f';
  const rowH = 110;
  const tableH = lines.length * rowH;
  const top = 140 + Math.max(60, Math.round((H - 140 - 120 - (150 + tableH)) / 2));
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#fbfaf6"/>`,
    `<rect width="${W}" height="140" fill="${accent}"/>`,
    `<text x="120" y="96" font-family="Noto Sans JP" font-weight="700" font-size="56" fill="#ffffff">会員の特典</text>`,
    `<text x="${W / 2}" y="${top + 100}" text-anchor="middle" font-family="Noto Sans JP" font-weight="700" font-size="96" fill="#1d2733">ポイントで特典と交換できます</text>`,
  ];
  let y = top + 150;
  for (const [i, l] of lines.entries()) {
    if (i % 2 === 0) parts.push(`<rect x="200" y="${y}" width="${W - 400}" height="${rowH}" rx="18" fill="#f0eee6"/>`);
    const base = y + 74;
    parts.push(`<text x="260" y="${base}" font-family="Noto Sans JP" font-weight="700" font-size="60" fill="#1d2733">${esc(cut(l.name, l.who ? 12 : 17))}</text>`);
    if (l.who) parts.push(`<text x="${W - 640}" y="${base}" text-anchor="end" font-family="Noto Sans JP" font-size="44" fill="${accent}">${esc(l.who)}</text>`);
    parts.push(`<text x="${W - 260}" y="${base}" text-anchor="end" font-family="Noto Sans JP" font-weight="700" font-size="64" fill="${accent}">${l.points.toLocaleString('ja-JP')} ポイント</text>`);
    y += rowH;
  }
  parts.push(`<text x="${W / 2}" y="${H - 80}" text-anchor="middle" font-family="Noto Sans JP" font-size="48" fill="#4a5560">会員証はスタッフにお声がけください</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/** 中身の印（特典の行と帯の色）。 */
export const rewardDigest = (lines: RewardLine[], color: string | null) =>
  createHash('sha256').update(JSON.stringify({ lines, color })).digest('hex').slice(0, 16);

/**
 * 流している 1 枚を作り直す。特典が無い・サイネージを使っていなければ、前の 1 枚を外す。
 *
 * @param rewards いま使える特典（会社が流すのを切っていれば空）
 * @param cur いま流している 1 枚の素材と中身の印
 * @returns 結果と、これから流している 1 枚
 */
export async function refreshRewardSignage(
  signage: SignageService, tenantId: string, rewards: MemberReward[], cur: { assetId: string | null; digest: string | null },
): Promise<{ result: 'added' | 'removed' | 'same'; assetId: string | null; digest: string | null }> {
  const settings = await signage.settings(tenantId);
  const lines = settings.enabled ? rewardLines(rewards) : [];
  const drop = async () => {
    if (cur.assetId) await signage.deleteAsset(tenantId, ACTOR, cur.assetId).catch(() => null);
  };
  if (!lines.length) {
    if (!cur.assetId) return { result: 'same', assetId: null, digest: null };
    await drop();
    return { result: 'removed', assetId: null, digest: null };
  }
  const digest = rewardDigest(lines, settings.color);
  if (digest === cur.digest && cur.assetId) return { result: 'same', assetId: cur.assetId, digest };
  const png = renderSvgPng(rewardScreenSvg(lines, settings.color), SCREEN_WIDTH);
  const dir = await mkdtemp(join(tmpdir(), 'm2o-reward-'));
  try {
    const path = join(dir, 'rewards.png');
    await writeFile(path, png);
    const added = await signage.addAsset(tenantId, ACTOR, {
      path, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), mime: 'image/png', name: '会員の特典', thumbnail: thumbnailPng(png),
    });
    if ('error' in added) return { result: 'same', assetId: cur.assetId, digest: cur.digest };
    await drop();
    for (const s of (await signage.overview(tenantId)).screens) await signage.prependToFlows(tenantId, ACTOR, s.id, [{ assetId: added.asset.id, seconds: null }]);
    return { result: 'added', assetId: added.asset.id, digest };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
