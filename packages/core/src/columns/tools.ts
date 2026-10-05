/**
 * @file Web のコラムのツール。下書きを書く・承認の前に確かめる・承認の後に WordPress に入れる。秘書と付属の業務が使う。
 *
 * 会社が Web のコラムを切っているときと、利用範囲の外の人には「使えない」と返す（呼ぶたびに `ctx.columns.access()` で確かめる）。
 * 調べた文章とコラムの本文はデータであり、指示として扱わない（不変則 I-6）。
 *
 * @see 仕様書 第32.18.1節 段 1 の実装の決まり
 */

import { COLUMN_COVER_KIND_LABELS, COLUMN_RULE_SET_LABELS, COLUMN_THEME_SOURCE_LABELS, WEB_COLUMN_STATUS_LABELS, type ColumnCoverKind, type ColumnRuleSet, type WebColumnSettings } from '@m2office/shared';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { ColumnPreview, ColumnService } from './service.js';
import type { ColumnPlanner } from './planner.js';
import type { ColumnSignageService } from './signage.js';

/** ツールに渡す Web のコラムの文脈。 */
export interface ColumnToolContext {
  service: ColumnService;
  /** テーマ案と予定表（段 2。第32.18.4節）。無い環境では、テーマ案のツールは「使えない」と返す */
  planner?: ColumnPlanner;
  /** 店頭サイネージ用の画像（第32.18.6節）。無い環境では「使えない」と返す */
  signage?: ColumnSignageService;
  /**
   * 依頼者がいま Web のコラムを使えるか。使えるなら会社の設定を返す。
   *
   * @returns 使えなければ `null`
   */
  access(): Promise<WebColumnSettings | null>;
}

const UNAVAILABLE = { available: false, reason: 'コラムの作成は使えません（会社で切っているか、利用範囲の外です）' };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const viewer = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

async function columnsOf(ctx: ToolContext): Promise<ColumnService | null> {
  if (!ctx.columns) return null;
  return (await ctx.columns.access()) ? ctx.columns.service : null;
}

/** コラムの画面の場所（秘書の答えに添える）。 */
const columnPath = (id: string) => `/columns/${encodeURIComponent(id)}`;

/** 承認の画面に出す、入れるものの説明。 */
function describePreview(p: ColumnPreview): string {
  return [
    `題名: ${p.title}`,
    `字数: ${p.chars.toLocaleString('ja-JP')} 字`,
    `残った指摘: ${p.reviewCount} 件`,
    `入れ先: ${p.destination}`,
    p.cover ? `カバー画像: ${COLUMN_COVER_KIND_LABELS[p.cover.kind]}` : '',
    // 承認する人が画像を見て判断できるように、カバーを出す（第32.18.2節。入れ先の業務の入力にカバーのファイルを含める）
    p.cover ? `\n![${p.cover.alt.replace(/[[\]]/g, '')}](/v1/files/${encodeURIComponent(p.cover.fileId)}/view)` : '',
  ].filter(Boolean).join('\n');
}

/**
 * テーマからコラムの下書きを書く（第32.7節）。Web で調べ、出典つきの下書きと赤入れまで行う。
 *
 * @remarks 危険度 `write-internal`。社内のコラムの置き場に書くだけで、WordPress には入れない（入れるのは承認の後の `columns.place`）
 */
export const columnsDraft: Tool = {
  name: 'columns.draft',
  risk: 'write-internal',
  activityLabel: 'コラムを書いています',
  helpText: 'テーマを Web で調べ、出典つきのコラムの下書きを書きます。下書きにするだけで、Web には出しません',
  description: 'テーマ（theme）とリクエスト（memo。任意。画像の希望も書ける）から、Web で調べて出典つきのコラムの下書きを書く。題名・字数・赤入れの数・画面の場所（path）を返す',
  args: {
    properties: {
      theme: { type: 'string', description: 'コラムのテーマ（一言。例: 「子どもの歯みがきのコツ」）' },
      memo: { type: 'string', description: 'リクエスト（書く人の希望・経験・考え。カバー画像の希望も書ける。任意）' },
    },
    required: ['theme'],
  },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const res = await service.create(viewer(ctx), { theme: str(args['theme']), memo: str(args['memo']) }, true);
    if ('error' in res) return { available: false, reason: res.error };
    const c = await service.store.get(ctx.tenantId, res.id);
    if (!c || c.status === 'failed') return { available: false, reason: c?.failure ?? 'コラムを書けませんでした', path: columnPath(res.id) };
    return { available: true, columnId: c.id, title: c.title, reviewCount: c.reviewCount, path: columnPath(c.id) };
  },
};

/**
 * 承認へ進めるコラムを確かめる（題名・字数・残った指摘・入れ先・入れられない理由）。
 *
 * @remarks 危険度 `read`。見るだけ
 */
export const columnsPreview: Tool = {
  name: 'columns.preview',
  risk: 'read',
  activityLabel: 'コラムを確かめています',
  helpText: 'コラムの題名・字数・残った指摘・入れ先を確かめます。見るだけです',
  description: 'コラム（columnId）の今の版の題名・字数・残った赤入れの数・入れ先・入れられない理由（problems）を返す',
  args: { properties: { columnId: { type: 'string', description: 'コラムの ID' } }, required: ['columnId'] },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const p = await service.preview(viewer(ctx), str(args['columnId']));
    if (!p) return { available: false, reason: 'コラムが見つかりません' };
    return { available: true, columnId: p.id, version: p.version, title: p.title, chars: p.chars, reviewCount: p.reviewCount, destination: p.destination, problems: p.problems };
  },
};

/**
 * 承認されたコラムを、会社の WordPress に下書きとして入れる（第32.10節）。WordPress につないでいなければ承認済みにする。
 *
 * @remarks 危険度 `external-send`。承認の段の直後でしか呼べない。承認の前の確かめ（`prepare`）で版の指紋を記録し、
 * 承認の後に版が変わっていれば入れない。公開はしない（公開は WordPress の側で押す）
 */
export const columnsPlace: Tool = {
  name: 'columns.place',
  risk: 'external-send',
  activityLabel: 'コラムを WordPress に入れています',
  helpText: '承認されたコラムを、会社の WordPress に下書きとして入れます。公開は WordPress の側で行います',
  description: '承認されたコラム（columnId）を、会社の WordPress に下書きとして入れる。WordPress につないでいなければ承認済みにする',
  args: { properties: { columnId: { type: 'string', description: 'コラムの ID' } }, required: ['columnId'] },
  planKey: (args) => `column:${str(args['columnId'])}`,
  async prepare(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const p = await service.preview(viewer(ctx), str(args['columnId'])).catch(() => null);
    if (!p) return { kind: 'problem', reason: 'コラムが見つかりません' };
    if (p.problems.length > 0) return { kind: 'problem', reason: p.problems.join('／') };
    return { kind: 'ready', args: { columnId: p.id, digest: p.digest }, shown: describePreview(p), audience: 'external' };
  },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const res = await service.place(viewer(ctx), str(args['columnId']), str(args['digest']));
    if ('error' in res) return { available: false, reason: res.error };
    if (res.scheduledAt) return { available: true, placed: false, scheduledAt: res.scheduledAt, note: '予約にしました。公開の日時に入れます' };
    return res.placed
      ? { available: true, placed: true, editUrl: res.editUrl, note: 'WordPress に下書きとして入れました。公開は WordPress の編集の画面で行ってください' }
      : { available: true, placed: false, note: '承認済みにしました。貼るだけのページを使っていれば、そこに出ます。コラムの画面から本文を写しても使えます' };
  },
};

/** 比べる形の言葉（空白と記号を除き、小文字にする）。 */
const norm = (s: string) => s.toLowerCase().replace(/[\s　「」『』【】（）()［］・、。!！?？]/g, '');

/**
 * コラムのカバー画像を作り直す（第32.18.2節）。題名やテーマの言葉でコラムを探し、頼まれた種類と雰囲気で作り直す。
 *
 * @remarks 危険度 `write-internal`。社内のコラムの置き場に新しい版を足すだけで、WordPress には入れない
 */
export const columnsCover: Tool = {
  name: 'columns.cover',
  risk: 'write-internal',
  activityLabel: 'コラムのカバーを作り直しています',
  helpText: 'コラムのカバー画像を作り直します（型・AI の挿絵・会社の写真）。新しい版になるだけで、Web には出しません',
  description: 'コラムのカバー画像を作り直す。column はコラムの題名かテーマの言葉（無ければいちばん新しいコラム）。kind は template（型）・ai（AI 作成の画像）・photo（会社の写真）、hint は雰囲気（「もっと明るく」など）。previous を true にすると、作り直す前の画像に戻す。1 つに決まらなければ候補を返す',
  args: {
    properties: {
      column: { type: 'string', description: 'コラムの題名かテーマの言葉' },
      kind: { type: 'string', description: '背景の種類', enum: ['template', 'ai', 'photo'] },
      hint: { type: 'string', description: '雰囲気の頼み（「もっと明るく」など）' },
      previous: { type: 'boolean', description: '作り直す前の画像に戻す' },
    },
  },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const words = norm(str(args['column']));
    const all = (await service.store.list(ctx.tenantId, 100)).filter((c) => c.status !== 'writing' && c.status !== 'failed');
    const found = words ? all.filter((c) => norm(`${c.title}${c.theme}`).includes(words)) : all.slice(0, 1);
    if (found.length === 0) return { available: false, reason: 'そのコラムが見つかりません' };
    if (found.length > 1) return { available: false, reason: 'コラムが 1 つに決まりません', candidates: found.slice(0, 8).map((c) => c.title || c.theme) };
    const c = found[0]!;
    const kind = ['template', 'ai', 'photo'].includes(str(args['kind'])) ? (str(args['kind']) as ColumnCoverKind) : undefined;
    const who = { tenantId: ctx.tenantId, userId: ctx.userId };
    const err = args['previous'] === true
      ? await service.useCover(who, c.id, 'previous')
      : await service.recover(who, c.id, { ...(kind ? { kind } : {}), hint: str(args['hint']) });
    if (err) return { available: false, reason: err };
    const v = (await service.store.versions(ctx.tenantId, c.id))[0];
    return {
      available: true, title: c.title || c.theme, path: columnPath(c.id),
      cover: v?.cover ? COLUMN_COVER_KIND_LABELS[v.cover.kind] : null, note: v?.cover?.note || null,
    };
  },
};

const RULE_SETS: ColumnRuleSet[] = ['medical', 'health-products', 'legal'];
const ruleList = (v: unknown): ColumnRuleSet[] => (Array.isArray(v) ? v.filter((x): x is ColumnRuleSet => RULE_SETS.includes(x as ColumnRuleSet)) : []);

/**
 * コラムの赤入れで当てる表現の決まりを直す（第32.18.3節）。足す・外す・AI に任せる。管理者だけ。
 *
 * @remarks 危険度 `write-internal`。会社の設定を直すだけで、社外には何も送らない
 */
export const columnsRules: Tool = {
  name: 'columns.rules',
  risk: 'write-internal',
  activityLabel: 'コラムの表現の決まりを直しています',
  helpText: 'コラムの赤入れで当てる表現の決まり（医療広告・薬機法・士業）を直します。管理者だけが直せます',
  description: 'コラムの赤入れで当てる表現の決まりを直す。add と remove に medical（医療広告ガイドライン）・health-products（薬機法・健康増進法）・legal（士業の広告の規程）を入れる。auto を true にすると AI に任せる形に戻す。今の決まりを返す',
  args: {
    properties: {
      add: { type: 'array', description: '足す決まり', items: { type: 'string', description: '決まり', enum: RULE_SETS } },
      remove: { type: 'array', description: '外す決まり', items: { type: 'string', description: '決まり', enum: RULE_SETS } },
      auto: { type: 'boolean', description: 'AI に任せる形に戻す' },
    },
  },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service) return UNAVAILABLE;
    const res = await service.setRules({ tenantId: ctx.tenantId, userId: ctx.userId }, {
      add: ruleList(args['add']), remove: ruleList(args['remove']), auto: args['auto'] === true,
    });
    if ('error' in res) return { available: false, reason: res.error };
    return {
      available: true, by: res.by === 'ai' ? 'AI が選ぶ' : '人が直した',
      rules: ['景品表示法（どの会社にも当てる）', ...res.rules.map((r) => COLUMN_RULE_SET_LABELS[r])],
    };
  },
};

/** Web のコラムのツール。 */
/**
 * テーマ案と予定表を読む（「今週のテーマ案は？」「コラムの予定は？」。第32.18.4節）。
 *
 * @remarks 危険度 `read`
 */
export const columnsThemes: Tool = {
  name: 'columns.themes',
  risk: 'read',
  activityLabel: 'コラムのテーマ案を調べています',
  helpText: 'まだ使っていないコラムのテーマ案（なぜ今か・材料の印）と、今月と来月の予定表の回を読みます',
  description: 'まだ使っていないコラムのテーマ案（theme・why・source）と、予定表の回（date・入れたコラムの題名と状態）を返す',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const service = await columnsOf(ctx);
    if (!service || !ctx.columns?.planner) return UNAVAILABLE;
    const [themes, plan] = await Promise.all([ctx.columns.planner.themes(ctx.tenantId), ctx.columns.planner.plan(ctx.tenantId)]);
    return {
      available: true, path: '/columns',
      themes: themes.slice(0, 10).map((t) => ({ theme: t.theme, why: t.why, source: COLUMN_THEME_SOURCE_LABELS[t.source], rewrite: !!t.columnId })),
      plan: plan.map((s) => ({ date: s.date, title: s.title || null, status: s.status ? WEB_COLUMN_STATUS_LABELS[s.status] : '空き' })),
      note: themes.length ? null : 'まだテーマ案がありません。「テーマ案を出して」と頼めば作ります',
    };
  },
};

/**
 * テーマ案を作る・案から書き始める（「テーマ案を出して」「来月の分を 4 本用意して」。第32.18.4節）。
 *
 * @remarks 危険度 `write-internal`。社内のコラムの置き場に書くだけで、Web には出さない（出すのは承認の後）
 */
export const columnsPrepare: Tool = {
  name: 'columns.prepare',
  risk: 'write-internal',
  activityLabel: 'コラムを用意しています',
  helpText: 'コラムのテーマ案を作ります。本数を言われたら、上から順にテーマ案で書き始めます（予定表があれば空いている回に入れます）。Web には出しません',
  description: 'count が無ければテーマ案を作って返す。count（1〜8）があれば、上から count 本のテーマ案で下書きを書き始める（予定表があれば空いている回に入れる）',
  args: { properties: { count: { type: 'number', description: '書き始める本数（無ければテーマ案を作るだけ）' } } },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    if (!service || !ctx.columns?.planner) return UNAVAILABLE;
    const planner = ctx.columns.planner;
    if (typeof args['count'] !== 'number') {
      const r = await planner.generateThemes(ctx.tenantId, ctx.userId, new Date(), false);
      if ('error' in r) return { available: false, reason: r.error };
      return { available: true, path: '/columns', themes: r.added.map((t) => ({ theme: t.theme, why: t.why, source: COLUMN_THEME_SOURCE_LABELS[t.source] })) };
    }
    const r = await planner.prepare(viewer(ctx), args['count']);
    if ('error' in r) return { available: false, reason: r.error };
    const items = await Promise.all(r.columnIds.map((id) => service.store.get(ctx.tenantId, id)));
    return {
      available: true, path: '/columns', note: '書き始めました。書き上がると下書きになります。直して承認へ進めると出ます',
      columns: items.filter(Boolean).map((c) => ({ theme: c!.theme, plannedFor: c!.plannedFor ?? null, path: columnPath(c!.id) })),
    };
  },
};

/**
 * 承認済みのコラムから、店頭サイネージ用の画像を作り始める（秘書から。第32.18.6節）。ワーカーが後ろで作る。
 *
 * @remarks 危険度 `write-internal`。作るだけで、サイネージの画面には流さない（流すのは承認の後の `columns.signage_publish`）
 */
export const columnsSignageMake: Tool = {
  name: 'columns.signage_make',
  risk: 'write-internal',
  activityLabel: 'コラムからサイネージの画面用の画像を作り始めています',
  helpText: '承認済みのコラムから、サイネージの画面に流す画像（1 枚か紙芝居）を作り始めます。流すのは承認の後です',
  description: '承認済みのコラムから、店頭サイネージ用の画像を作り始める。column はコラムの題名かテーマの言葉（無ければいちばん新しい承認済みのコラム）。kind は slides（画像）か video（動画）。1 つに決まらなければ候補を返す',
  args: {
    properties: {
      column: { type: 'string', description: 'コラムの題名かテーマの言葉' },
      kind: { type: 'string', description: '画像か動画', enum: ['slides', 'video'] },
    },
  },
  async invoke(args, ctx) {
    const service = await columnsOf(ctx);
    const signage = ctx.columns?.signage;
    if (!service || !signage) return UNAVAILABLE;
    const words = norm(str(args['column']));
    const all = (await service.store.list(ctx.tenantId, 100)).filter((c) => ['approved', 'scheduled', 'placed'].includes(c.status));
    const found = words ? all.filter((c) => norm(`${c.title}${c.theme}`).includes(words)) : all.slice(0, 1);
    if (found.length === 0) return { available: false, reason: words ? 'その承認済みのコラムが見つかりません' : '承認済みのコラムがありません' };
    if (found.length > 1) return { available: false, reason: 'コラムが 1 つに決まりません', candidates: found.slice(0, 8).map((c) => c.title || c.theme) };
    const c = found[0]!;
    const r = await signage.make(viewer(ctx), c.id, str(args['kind']) === 'video' ? 'video' : 'slides');
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, title: c.title || c.theme, path: columnPath(c.id), making: true };
  },
};

/**
 * 作った店頭サイネージ用の画像を流す（付属の業務「コラムをサイネージに流す」が承認の後に呼ぶ。第32.18.6節）。
 *
 * @remarks 危険度 `external-send`（サイネージの画面はお客様が見る）。承認の画面に一言・流す画面・期間と画像を出す。承認の後に変わっていたら流さない
 */
export const columnsSignagePublish: Tool = {
  name: 'columns.signage_publish',
  risk: 'external-send',
  activityLabel: 'コラムの画像をサイネージの画面に流しています',
  helpText: 'コラムから作った画像を、承認の後にサイネージの画面の流れに置きます',
  description: '店頭サイネージ用の組（setId）を、承認の後にサイネージの画面の流れの先頭に置く',
  args: { properties: { setId: { type: 'string', description: 'サイネージ用の組の ID' } }, required: ['setId'] },
  planKey: (args) => `column-signage:${str(args['setId'])}`,
  async prepare(args, ctx) {
    const signage = (await columnsOf(ctx)) ? ctx.columns?.signage : undefined;
    if (!signage) return { kind: 'problem', reason: UNAVAILABLE.reason };
    const p = await signage.preview(ctx.tenantId, str(args['setId']));
    if ('error' in p) return { kind: 'problem', reason: p.error };
    return { kind: 'ready', args: { setId: str(args['setId']), digest: p.digest }, audience: 'external', shown: p.shown };
  },
  async invoke(args, ctx) {
    const signage = (await columnsOf(ctx)) ? ctx.columns?.signage : undefined;
    if (!signage) return UNAVAILABLE;
    const r = await signage.publish(viewer(ctx), str(args['setId']), str(args['digest']));
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, published: true, screens: r.screens };
  },
};

export const COLUMN_TOOLS: Tool[] = [columnsDraft, columnsPreview, columnsPlace, columnsCover, columnsRules, columnsThemes, columnsPrepare, columnsSignageMake, columnsSignagePublish];
