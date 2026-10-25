/**
 * @file 業務「文書の作成」のツール。文書を作り、作ったものを覚え、直す・一覧・共有する（仕様書 第9.5.5.2節「文書の作成の扱い」、Q-266）。
 *
 * 作ったスライドと同じ置き場（種類 `doc`）を使う。作り直しは同じファイルの本文を入れ替え（URL と共有はそのまま）、
 * 人が Google ドキュメントで手を入れた後なら上書きせずに新しいファイルに作る。会社で共有は会社の Workspace のドメインへの閲覧だけ。
 */

import { randomUUID } from 'node:crypto';
import { SLIDE_DECK_SHARING_LABEL, type SlideDeckSummary } from '@m2office/shared';
import type { Tool, ToolContext } from './registry.js';
import { HAND_EDIT_GRACE_MS, draftLinks } from '../slides/decks.js';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const S = (description: string) => ({ type: 'string' as const, description });
const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** 本文の上限（文字）。 */
const BODY_MAX = 60_000;

/**
 * 文書を作る。前に作った文書を直すときは、同じファイルの本文を入れ替える。
 *
 * @remarks
 * 危険度: `draft`。依頼した本人のドライブに作り、共有はしない（会社で共有するのは `docs.share`）。
 * 作ったものは作った人ごとに覚える（種類 `doc`。本文は作り直すため）。権限 `drive.file`
 */
export const docsDraft: Tool = {
  name: 'docs.draft',
  risk: 'draft',
  activityLabel: '文書を作成しています',
  helpText: 'あなたのドライブに Google ドキュメントを作ります。前に作った文書を直すこともできます。共有はしません',
  description: '本人のドライブに Google ドキュメントを作る（共有しない）。body は Markdown（見出し・箇条書き・表）。'
    + '前に作った文書を直すときは draftId（docs.get で読んだもの）と、頼みの分だけ直した本文を渡す（同じファイルの本文が入れ替わる）。request には依頼の文を渡す',
  args: {
    properties: {
      title: S('題名'),
      body: S('本文（Markdown）'),
      draftId: S('直す、前に作った文書の ID（直すときだけ）'),
      request: S('依頼の文（直す頼みも。覚えておき、次に直すときに読む）'),
    },
    required: ['title', 'body'],
  },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const title = str(args['title']).slice(0, 200) || '無題の文書';
    const body = str(args['body']);
    if (!body) return { error: '本文（body）を渡してください' };
    const warnings: string[] = [];
    if (body.length > BODY_MAX) warnings.push(`本文が長いため、${BODY_MAX} 文字までにしました`);
    const text = body.slice(0, BODY_MAX);
    const p = who(ctx);
    const draftId = str(args['draftId']);
    const prev = draftId && ctx.slideDecks ? await ctx.slideDecks.store.get(ctx.tenantId, draftId) : null;
    if (draftId && (!prev || prev.userId !== ctx.userId || prev.kind !== 'doc')) return { error: '直す文書が見つかりません（作った人だけが直せます。docs.list で探してください）' };
    // 作り直す先。人が手を入れた後なら上書きしない（手で直したものを消さない）
    let replaced = null;
    let asNew = false;
    if (prev) {
      const mock = prev.presentationId.startsWith('mock-');
      const state = await ctx.connector.slides.fileState(p, prev.presentationId).catch(() => null);
      if (!mock && (!state || state.trashed)) {
        warnings.push('前のファイルがドライブに見つからなかったため、新しいファイルに作りました');
      } else if (state && Date.parse(state.modifiedTime) > Date.parse(prev.builtAt) + HAND_EDIT_GRACE_MS) {
        asNew = true;
        warnings.push('前のファイルに手で直した跡があったので、上書きせずに新しいファイルに作りました');
      } else {
        replaced = await ctx.connector.docs.replace(p, { documentId: prev.presentationId, title, body: text });
        if (!replaced && !mock) warnings.push('前のファイルを書き換えられなかったため、新しいファイルに作りました');
      }
    }
    const file = replaced ?? await ctx.connector.docs.create(p, { title, body: text, folderId: null });
    const now = new Date().toISOString();
    const builtAt = (await ctx.connector.slides.fileState(p, file.id).catch(() => null))?.modifiedTime || now;
    const keep = prev && !asNew;
    const request = str(args['request']).slice(0, 2000);
    const draft = ctx.slideDecks ? {
      id: keep ? prev.id : randomUUID(), kind: 'doc' as const, tenantId: ctx.tenantId, userId: ctx.userId, presentationId: file.id,
      title, design: null, template: null, theme: null, sharing: keep ? prev.sharing : 'private' as const,
      request: [keep ? prev.request : '', request].filter(Boolean).join('\n直す頼み: ').slice(-4000),
      plan: null, body: text, imagePrompts: {}, runId: ctx.runId, builtAt, createdAt: keep ? prev.createdAt : now, updatedAt: now,
    } : null;
    if (draft) await ctx.slideDecks!.store.save(draft);
    // 成果物は本文そのもの（画面はボタンと本文を出す。リンクは文に書かない）
    const artifactId = randomUUID();
    await ctx.repo.createArtifact({
      id: artifactId, runId: ctx.runId, tenantId: ctx.tenantId, kind: 'document', title,
      body: [text, ...(warnings.length ? ['', '---', ...warnings.map((w) => `注意: ${w}`)] : [])].join('\n'),
      ...(draft ? { slideDeckId: draft.id } : {}),
      createdAt: now,
    });
    const source = ctx.connector.sourceFor(ctx.tenantId);
    return {
      artifactId, draftId: draft?.id ?? null, documentId: file.id, url: draftLinks('doc', file.id).url, title,
      sharing: draft ? SLIDE_DECK_SHARING_LABEL[draft.sharing] : null, rebuilt: !!replaced, warnings, ...(source === 'mock' ? { source } : {}),
    };
  },
};

/**
 * 作った文書の一覧（本人のものと、会社で共有されたもの）。
 *
 * @remarks 危険度: `read`。M2Office が覚えている一覧を読むだけ
 */
export const docsList: Tool = {
  name: 'docs.list',
  risk: 'read',
  activityLabel: '作った文書を探しています',
  helpText: 'あなたが作った文書と、会社で共有された文書の一覧を読みます',
  description: '作った文書の一覧を返す（新しい順。mine は本人が作ったもの、shared は会社で共有されたもの）。各項目は id・title・sharing・updatedAt。'
    + '前に作った文書を直す・共有する頼みで、どの文書かを探すのに使う',
  args: { properties: {} },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(_args, ctx) {
    if (!ctx.slideDecks) return { error: '作った文書の一覧を使えません' };
    const { mine, shared } = await ctx.slideDecks.list(who(ctx), 'doc');
    const pick = (d: SlideDeckSummary) => ({ id: d.id, title: d.title, sharing: SLIDE_DECK_SHARING_LABEL[d.sharing], updatedAt: d.updatedAt, ...(d.ownerName ? { owner: d.ownerName } : {}) });
    return { mine: mine.slice(0, 30).map(pick), shared: shared.slice(0, 30).map(pick) };
  },
};

/**
 * 前に作った文書の本文と頼みを読む（直すため）。
 *
 * @remarks 危険度: `read`。本人のものと会社で共有されたものだけ読める
 */
export const docsGet: Tool = {
  name: 'docs.get',
  risk: 'read',
  activityLabel: '前の文書を読んでいます',
  helpText: '前に作った文書の本文を読みます（直すため）',
  description: '前に作った文書の本文（Markdown）・頼み・共有の範囲を返す。直す頼みのときは、この本文を頼みの分だけ直して docs.draft に draftId と一緒に渡す',
  args: { properties: { draftId: S('文書の ID（docs.list の id）') }, required: ['draftId'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    if (!ctx.slideDecks) return { error: '作った文書を読めません' };
    const d = await ctx.slideDecks.get(who(ctx), str(args['draftId']));
    if (!d || d.kind !== 'doc') return { error: '文書が見つかりません' };
    return {
      draftId: d.id, title: d.title, sharing: SLIDE_DECK_SHARING_LABEL[d.sharing], request: d.request, mine: d.userId === ctx.userId, body: d.body ?? '',
      ...(d.userId === ctx.userId ? {} : { note: 'ほかの人の文書は直せません。直したいときは、この本文で新しく作ってください（draftId を渡さない）' }),
    };
  },
};

/**
 * 作った文書の共有の範囲を切り替える（自分だけ・会社で共有）。
 *
 * @remarks
 * 危険度: `write-internal`。会社の Google Workspace のドメインへの閲覧だけで、社外には出さない。
 * ドメインを確かめられなければ共有しない（仕様書 第9.5.5.2節「文書の作成の扱い」、境界 2）
 */
export const docsShare: Tool = {
  name: 'docs.share',
  risk: 'write-internal',
  activityLabel: '文書の共有を切り替えています',
  helpText: '作った文書を、会社の中で共有するか、自分だけにするかを切り替えます。社外には共有しません',
  description: '作った文書の共有の範囲を切り替える。sharing は「会社で共有」（会社の Google Workspace の人が見られる。編集はできない）か「自分だけ」。'
    + '作った人だけが切り替えられる。会社のドメインを確かめられないときは共有せず、理由を返す',
  args: { properties: { draftId: S('文書の ID（docs.draft の draftId か docs.list の id）'), sharing: S('「会社で共有」か「自分だけ」') }, required: ['draftId', 'sharing'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    if (!ctx.slideDecks) return { error: '作った文書の共有を切り替えられません' };
    const d = await ctx.slideDecks.store.get(ctx.tenantId, str(args['draftId']));
    if (!d || d.kind !== 'doc') return { error: '文書が見つかりません' };
    const sharing = String(args['sharing'] ?? '').includes('会社') || args['sharing'] === 'company' ? 'company' : 'private';
    const got = await ctx.slideDecks.share(who(ctx), d.id, sharing);
    if ('error' in got) return { error: got.error };
    return { draftId: got.id, title: got.title, sharing: SLIDE_DECK_SHARING_LABEL[got.sharing] };
  },
};

/** 業務「文書の作成」のツール。 */
export const DOC_DRAFT_TOOLS: Tool[] = [docsDraft, docsList, docsGet, docsShare];
