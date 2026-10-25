/**
 * @file 業務「表の作成」のツール。表を作り、作ったものを覚え、直す・一覧・共有する（仕様書 第9.5.5.2節「表の作成の扱いとテンプレート」、Q-268）。
 *
 * 作ったスライド・文書と同じ置き場（種類 `sheet`）を使う。作り直しは同じファイルの表を書き直し（URL と共有はそのまま）、
 * 人が Google スプレッドシートで手を入れた後・テンプレートを変えたときは新しいファイルに作る。
 * テンプレート（Google スプレッドシートのテンプレート ギャラリーから作ったもの）は見た目だけを使う（ADR-0111）。
 */

import { randomUUID } from 'node:crypto';
import { SLIDE_DECK_SHARING_LABEL, type SlideDeckSummary } from '@m2office/shared';
import type { Tool, ToolContext } from './registry.js';
import { HAND_EDIT_GRACE_MS, draftLinks } from '../slides/decks.js';
import { SlideThemeUnavailableError } from '../slides/theme.js';
import { STANDARD, chooseTemplate } from './doc-drafts.js';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const S = (description: string) => ({ type: 'string' as const, description });
const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** 表の大きさの上限。 */
const COLUMNS_MAX = 50;
const ROWS_MAX = 2000;

/** 引数の列と行を、文字の表にする（上限で切る）。 */
function tableOf(args: Record<string, unknown>, warnings: string[]): { columns: string[]; rows: string[][] } {
  const columns = (Array.isArray(args['columns']) ? args['columns'] : []).map((c) => String(c ?? '').trim()).slice(0, COLUMNS_MAX);
  const raw = Array.isArray(args['rows']) ? args['rows'] : [];
  if (raw.length > ROWS_MAX) warnings.push(`行が多いため、${ROWS_MAX} 行までにしました`);
  const rows = raw.slice(0, ROWS_MAX).map((r) => (Array.isArray(r) ? r : [r]).slice(0, COLUMNS_MAX).map((v) => (v === null || v === undefined ? '' : String(v))));
  return { columns, rows };
}

/**
 * 表を作る。前に作った表を直すときは、同じファイルの表を書き直す。
 *
 * @remarks
 * 危険度: `draft`。依頼した本人のドライブに作り、共有はしない（会社で共有するのは `sheets.share`）。
 * 作ったものは作った人ごとに覚える（種類 `sheet`。列と行は作り直すため）。権限 `drive.file`。値は式として読ませない
 */
export const sheetsDraft: Tool = {
  name: 'sheets.draft',
  risk: 'draft',
  activityLabel: '表を作成しています',
  helpText: 'あなたのドライブに Google スプレッドシートの表を作ります。前に作った表を直すこともできます。共有はしません',
  description: '本人のドライブに Google スプレッドシートの表を作る（共有しない。見出しの行・1 行おきの塗りなどの見た目を付ける）。columns は列名、rows は行の配列（数は数字だけ）。'
    + '前に作った表を直すときは draftId（sheets.get で読んだもの）と、頼みの分だけ直した列と行を渡す（同じファイルの表が書き直される）。request には依頼の文を渡す。'
    + 'template にテンプレートの名前か theme:<ID>（無ければ会社の既定。「標準」なら使わない）を渡すと、そのテンプレートの見た目（字体・配色・見出しの書式）で作る',
  args: {
    properties: {
      title: S('題名'),
      columns: { type: 'array', description: '列名の配列' },
      rows: { type: 'array', description: '行の配列（各行は値の配列）' },
      draftId: S('直す、前に作った表の ID（直すときだけ）'),
      template: S('テンプレートの名前か theme:<ID>（任意。「標準」なら使わない）'),
      request: S('依頼の文（直す頼みも。覚えておき、次に直すときに読む）'),
    },
    required: ['title', 'columns'],
  },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const title = str(args['title']).slice(0, 200) || '無題の表';
    const warnings: string[] = [];
    const { columns, rows } = tableOf(args, warnings);
    if (columns.length === 0) return { error: '列（columns）を渡してください' };
    const p = who(ctx);
    const draftId = str(args['draftId']);
    const prev = draftId && ctx.slideDecks ? await ctx.slideDecks.store.get(ctx.tenantId, draftId) : null;
    if (draftId && (!prev || prev.userId !== ctx.userId || prev.kind !== 'sheet')) return { error: '直す表が見つかりません（作った人だけが直せます。sheets.list で探してください）' };
    const chosen = await chooseTemplate(ctx, str(args['template']), prev, 'sheet');
    if (chosen.warning) warnings.push(chosen.warning);
    let template = chosen.template;
    let replaced = null;
    let asNew = false;
    let replaceOld = false;
    if (prev) {
      const mock = prev.presentationId.startsWith('mock-');
      const state = await ctx.connector.slides.fileState(p, prev.presentationId).catch(() => null);
      if (!mock && (!state || state.trashed)) {
        warnings.push('前のファイルがドライブに見つからなかったため、新しいファイルに作りました');
      } else if (state && Date.parse(state.modifiedTime) > Date.parse(prev.builtAt) + HAND_EDIT_GRACE_MS) {
        asNew = true;
        warnings.push('前のファイルに手で直した跡があったので、上書きせずに新しいファイルに作りました');
      } else if ((prev.theme ?? null) !== (template?.id ?? null)) {
        replaceOld = true;
      } else {
        replaced = await ctx.connector.sheets.rewrite(p, { spreadsheetId: prev.presentationId, title, columns, rows });
        if (!replaced && !mock) warnings.push('前のファイルを書き換えられなかったため、新しいファイルに作りました');
      }
    }
    let file = replaced;
    if (!file && template) {
      try {
        file = await ctx.connector.sheets.createFromTemplate(p, { templateId: template.presentationId, templateName: template.name, title, columns, rows });
      } catch (err) {
        if (!(err instanceof SlideThemeUnavailableError)) throw err;
        warnings.push(`${err.message}。標準の見た目で作りました`);
        template = null;
      }
    }
    file ??= await ctx.connector.sheets.create(p, { title, columns, rows, folderId: null });
    // テンプレートを変えて新しいファイルにしたら、共有の範囲を引き継ぎ、前のファイルをごみ箱へ
    if (prev && replaceOld && prev.presentationId !== file.id) {
      if (prev.sharing === 'company' && ctx.slideDecks) {
        const domain = await ctx.slideDecks.companyDomain(p);
        if ('domain' in domain) await ctx.connector.slides.share(p, file.id, domain.domain).catch(() => false);
        else warnings.push(domain.reason);
      }
      await ctx.connector.slides.trash(p, prev.presentationId).catch(() => false);
      warnings.push('テンプレートを変えたため新しいファイルにし、前のファイルはドライブのごみ箱に移しました');
    }
    const now = new Date().toISOString();
    const builtAt = (await ctx.connector.slides.fileState(p, file.id).catch(() => null))?.modifiedTime || now;
    const keep = prev && !asNew;
    const request = str(args['request']).slice(0, 2000);
    const draft = ctx.slideDecks ? {
      id: keep ? prev.id : randomUUID(), kind: 'sheet' as const, tenantId: ctx.tenantId, userId: ctx.userId, presentationId: file.id,
      title, design: template?.name ?? null, template: null, theme: template?.id ?? null, sharing: keep ? prev.sharing : 'private' as const,
      request: [keep ? prev.request : '', request].filter(Boolean).join('\n直す頼み: ').slice(-4000),
      plan: null, body: null, table: { columns, rows }, imagePrompts: {}, runId: ctx.runId, builtAt, createdAt: keep ? prev.createdAt : now, updatedAt: now,
    } : null;
    if (draft) await ctx.slideDecks!.store.save(draft);
    // 成果物は表そのもの（Markdown の表。画面はボタンと表を出す）
    const cell = (v: string) => v.replace(/\|/g, '｜').replace(/\n/g, ' ');
    const preview = [`| ${columns.map(cell).join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`, ...rows.slice(0, 50).map((r) => `| ${columns.map((_, k) => cell(r[k] ?? '')).join(' | ')} |`)];
    if (rows.length > 50) preview.push('', `（ほか ${rows.length - 50} 行）`);
    const artifactId = randomUUID();
    await ctx.repo.createArtifact({
      id: artifactId, runId: ctx.runId, tenantId: ctx.tenantId, kind: 'spreadsheet', title,
      body: [...preview, ...(warnings.length ? ['', '---', ...warnings.map((w) => `注意: ${w}`)] : [])].join('\n'),
      ...(draft ? { slideDeckId: draft.id } : {}),
      createdAt: now,
    });
    const source = ctx.connector.sourceFor(ctx.tenantId);
    return {
      artifactId, draftId: draft?.id ?? null, spreadsheetId: file.id, url: draftLinks('sheet', file.id).url, title, rowCount: rows.length,
      template: template?.name ?? STANDARD, sharing: draft ? SLIDE_DECK_SHARING_LABEL[draft.sharing] : null, rebuilt: !!replaced, warnings,
      ...(source === 'mock' ? { source } : {}),
    };
  },
};

/** 作った表の一覧（本人のものと、会社で共有されたもの）。 @remarks 危険度: `read` */
export const sheetsList: Tool = {
  name: 'sheets.list',
  risk: 'read',
  activityLabel: '作った表を探しています',
  helpText: 'あなたが作った表と、会社で共有された表の一覧を読みます',
  description: '作った表の一覧を返す（新しい順。mine は本人が作ったもの、shared は会社で共有されたもの）。各項目は id・title・sharing・updatedAt。前に作った表を直す・共有する頼みで、どの表かを探すのに使う',
  args: { properties: {} },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(_args, ctx) {
    if (!ctx.slideDecks) return { error: '作った表の一覧を使えません' };
    const { mine, shared } = await ctx.slideDecks.list(who(ctx), 'sheet');
    const pick = (d: SlideDeckSummary) => ({ id: d.id, title: d.title, sharing: SLIDE_DECK_SHARING_LABEL[d.sharing], updatedAt: d.updatedAt, ...(d.ownerName ? { owner: d.ownerName } : {}) });
    return { mine: mine.slice(0, 30).map(pick), shared: shared.slice(0, 30).map(pick) };
  },
};

/** 前に作った表の列と行と頼みを読む（直すため）。 @remarks 危険度: `read`。本人のものと会社で共有されたものだけ */
export const sheetsGet: Tool = {
  name: 'sheets.get',
  risk: 'read',
  activityLabel: '前の表を読んでいます',
  helpText: '前に作った表を読みます（直すため）',
  description: '前に作った表の列（columns）・行（rows）・頼み・共有の範囲を返す。直す頼みのときは、この表を頼みの分だけ直して sheets.draft に draftId と一緒に渡す',
  args: { properties: { draftId: S('表の ID（sheets.list の id）') }, required: ['draftId'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    if (!ctx.slideDecks) return { error: '作った表を読めません' };
    const d = await ctx.slideDecks.get(who(ctx), str(args['draftId']));
    if (!d || d.kind !== 'sheet') return { error: '表が見つかりません' };
    return {
      draftId: d.id, title: d.title, sharing: SLIDE_DECK_SHARING_LABEL[d.sharing], request: d.request, mine: d.userId === ctx.userId,
      columns: d.table?.columns ?? [], rows: d.table?.rows ?? [],
      ...(d.userId === ctx.userId ? {} : { note: 'ほかの人の表は直せません。直したいときは、この表で新しく作ってください（draftId を渡さない）' }),
    };
  },
};

/**
 * 作った表の共有の範囲を切り替える（自分だけ・会社で共有）。
 *
 * @remarks 危険度: `write-internal`。会社の Google Workspace のドメインへの閲覧だけで、社外には出さない（境界 2）
 */
export const sheetsShare: Tool = {
  name: 'sheets.share',
  risk: 'write-internal',
  activityLabel: '表の共有を切り替えています',
  helpText: '作った表を、会社の中で共有するか、自分だけにするかを切り替えます。社外には共有しません',
  description: '作った表の共有の範囲を切り替える。sharing は「会社で共有」（会社の Google Workspace の人が見られる。編集はできない）か「自分だけ」。作った人だけが切り替えられる',
  args: { properties: { draftId: S('表の ID（sheets.draft の draftId か sheets.list の id）'), sharing: S('「会社で共有」か「自分だけ」') }, required: ['draftId', 'sharing'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    if (!ctx.slideDecks) return { error: '作った表の共有を切り替えられません' };
    const d = await ctx.slideDecks.store.get(ctx.tenantId, str(args['draftId']));
    if (!d || d.kind !== 'sheet') return { error: '表が見つかりません' };
    const sharing = String(args['sharing'] ?? '').includes('会社') || args['sharing'] === 'company' ? 'company' : 'private';
    const got = await ctx.slideDecks.share(who(ctx), d.id, sharing);
    if ('error' in got) return { error: got.error };
    return { draftId: got.id, title: got.title, sharing: SLIDE_DECK_SHARING_LABEL[got.sharing] };
  },
};

/** 業務「表の作成」のツール。 */
export const SHEET_DRAFT_TOOLS: Tool[] = [sheetsDraft, sheetsList, sheetsGet, sheetsShare];
