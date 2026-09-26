/**
 * @file 基盤が提供するツールの全体と、知識の検索と登録・会議の記録・文書作成のツール。
 *
 * 危険度は仕様書 第9.4節の区分に従う。
 * `external-send` 以上のツールは、定義に承認ゲートが無ければ実行前に拒否される。
 *
 * @see 仕様書 第9.4節 ツールと承認の対応
 */

import { randomUUID } from 'node:crypto';
import type { Tool } from './registry.js';
import { WORKSPACE_TOOLS } from './workspace.js';
import { FILE_TOOLS } from './files.js';
import { RESEARCH_TOOLS } from './research.js';
import { GOOGLE_TOOLS } from './google.js';
import { rewriteNote } from '../knowledge/search.js';
import { approvedArtifact, jstDate } from './approved-artifact.js';

/**
 * 組織知識を検索する。関係の深い節（条など）を、出典を伴って返す（仕様書 第11.7.4節）。
 *
 * @remarks 危険度 read。区画の外の人には区画内の節を返さない。見つからなければ `found: 0` を返し、推測させない。
 */
export const knowledgeSearch: Tool = {
  name: 'knowledge.search',
  risk: 'read',
  activityLabel: '社内の知識を調べています（リサーチ中）',
  helpText: '社内の知識（規程・議事録など）を調べます。区画の外の人には区画内の文書を見せません',
  description: '組織知識を検索し、関係の深い節（条など）を出典つきで返す。出典は citation をそのまま示す',
  args: { properties: { query: { type: 'string', description: '調べる言葉' } }, required: ['query'] },
  async invoke(args, ctx) {
    const query = String(args['query'] ?? '');
    // 言い換えは秘書が考える（第11.7.7.0節）
    const synonyms = ctx.expandQuery ? await ctx.expandQuery(query) : [];
    const { hits, rewrites } = await ctx.repo.searchKnowledge(ctx.tenantId, query, ctx.compartment, synonyms);
    return {
      query,
      hits: hits.map((h) => ({ citation: h.citation, title: h.title, heading: h.heading, source: h.source, body: h.body })),
      found: hits.length,
      // 言い換えで読み替えた言葉。答えに「〜と読み替えて探しました」と示す（第11.7.7節）
      rewrites,
      ...(rewrites.length > 0 ? { note: rewriteNote(rewrites) } : {}),
    };
  },
};

/**
 * スキルの補助のファイルを読む（仕様書 第12.12.2節）。スキルと同じく、本文から参照したファイルを必要なときに開く。
 *
 * @remarks 危険度 read。読めるのは、実行中のスキルに入っていた Markdown・テキストだけ。書き手が用意した業務の資料として扱う
 */
export const skillRead: Tool = {
  name: 'skill.read',
  risk: 'read',
  activityLabel: 'スキルの資料を読んでいます',
  helpText: 'このスキルに入っている資料を読みます',
  description: 'このスキルの補助のファイル（本文で参照しているもの）を読む。path は本文に書かれた相対パス（例: reference.md）',
  args: { properties: { path: { type: 'string', description: 'ファイルの相対パス' } }, required: ['path'] },
  async invoke(args, ctx) {
    const want = String(args['path'] ?? '').replace(/^\.\//, '').trim();
    const files = ctx.skillFiles ?? [];
    const hit = files.find((f) => f.path === want) ?? files.find((f) => f.path.endsWith(`/${want}`) || f.path.split('/').pop() === want);
    return hit
      ? { path: hit.path, text: hit.text }
      : { found: false, reason: `このスキルに ${want} はありません`, files: files.map((f) => f.path) };
  },
};

/** 会議の記録を取得する。プロトタイプでは入力に貼り付けた本文を用いる。 */
export const meetingGetTranscript: Tool = {
  name: 'meeting.get_transcript',
  risk: 'read',
  activityLabel: '会議の記録を読んでいます',
  helpText: '会議の記録（文字起こし）を読みます',
  description: '会議の文字起こしを取得する',
  args: { properties: { transcript: { type: 'string', description: '会議の記録（文字起こし）' } }, required: ['transcript'] },
  async invoke(args) {
    const text = String(args['transcript'] ?? '');
    if (!text.trim()) {
      // 取得できなかった値を推測で埋めない（仕様書 第9.2節）
      return { available: false, reason: '文字起こしを取得できませんでした' };
    }
    return { available: true, text };
  },
};

/** 文書を生成して成果物として保存する。 */
export const documentCreate: Tool = {
  name: 'document.create',
  risk: 'draft',
  activityLabel: '資料を作成しています',
  helpText: '文書を作り、成果物として保存します。社外へは出しません',
  description: '文書を作成し、成果物として保存する',
  args: { properties: { kind: { type: 'string', description: '種類（例: minutes・reply）' }, title: { type: 'string', description: '題名' }, body: { type: 'string', description: '本文' } }, required: ['title', 'body'] },
  async invoke(args, ctx) {
    const id = randomUUID();
    await ctx.repo.createArtifact({
      id,
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      kind: String(args['kind'] ?? 'document'),
      title: String(args['title'] ?? '無題'),
      body: String(args['body'] ?? ''),
      createdAt: new Date().toISOString(),
    });
    return { artifactId: id, title: args['title'] };
  },
};

/** 業務から登録した知識の出典。業務の名前を添えて、どこから来た知識かを示す。 */
const REGISTER_SOURCE = '業務「議事録作成・共有」で作成';

/**
 * 実行で作った成果物を、そのまま組織知識として登録する（仕様書 第9.5.2節の手順 7、ADR-0010）。
 *
 * @remarks
 * 危険度 write-internal。社内の全員の秘書と業務から引けるようになる。
 * 本文は受け取らず、承認より前に作られていた成果物の本文を使う。記録に紛れ込んだ指示で、
 * 承認した人が見ていない文を知識に入れさせないため（不変則 I-6）。
 * 定義の承認ステップをすべて通ったあとでなければ登録しない。知識の ID は実行から決め、1 回の実行で 1 件とする。
 */
export const knowledgeRegister: Tool = {
  name: 'knowledge.register',
  risk: 'write-internal',
  activityLabel: '社内の知識に登録しています',
  helpText: '承認された議事録などを、そのまま社内の知識に登録します。すべての承認のあとに行い、承認した人が見た内容だけを登録します',
  description: 'この実行で作った成果物（承認で確かめたもの）を、本文を変えずに組織知識へ登録する。artifactId には document.create の結果の artifactId をそのまま渡す',
  args: { properties: { artifactId: { type: 'string', description: '登録する成果物の ID（document.create の結果）' } }, required: ['artifactId'] },
  async invoke(args, ctx) {
    const artifactId = String(args['artifactId'] ?? '');
    // 後に承認が残っていれば登録しない。承認②を却下したら知識に入らないようにする
    if (ctx.approvalsAhead === undefined || ctx.approvalsAhead > 0) {
      return { registered: false, reason: 'すべての承認を通ったあとでなければ、知識に登録できません' };
    }
    // すべての承認で承認した人が見た成果物か。最初の承認で止めた時点にあったものでなければならない
    const picked = await approvedArtifact(ctx, artifactId);
    if ('reason' in picked) return { registered: false, reason: `${picked.reason}。知識に登録できません` };
    const { artifact } = picked;
    const steps = await ctx.repo.listRunSteps(ctx.tenantId, ctx.runId);
    // Google から読んだデータで作ったか。書き込み（ToDo の起票・投稿）は中身の出どころではないため数えない
    const isGoogleTool = ctx.isGoogleTool ?? (() => false);
    const googleDerived = steps.some((s) => {
      const tools = (s.output as { tools?: { name?: string; risk?: string }[] } | null)?.tools;
      return Array.isArray(tools) && tools.some((t) => t.risk === 'read' && !!t.name && isGoogleTool(t.name));
    });
    const id = `run-${ctx.runId}`;
    const title = `${artifact.title}（${jstDate(artifact.createdAt)}）`;
    await ctx.repo.saveKnowledge({
      id, tenantId: ctx.tenantId, kind: artifact.kind, title, body: artifact.body,
      source: REGISTER_SOURCE, compartment: ctx.compartment, updatedAt: new Date().toISOString(),
      originRunId: ctx.runId, googleDerived,
    });
    // 登録者は依頼した本人とする（第11.3節の「出典と登録者を記録」）。業務が代わりに行ったことは実行の ID で辿れる
    await ctx.repo.appendAudit({
      id: randomUUID(), tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId,
      action: 'knowledge.register', targetType: 'knowledge', targetId: id,
      detail: { runId: ctx.runId, artifactId, googleDerived }, occurredAt: new Date().toISOString(),
    });
    return { registered: true, knowledgeId: id, title };
  },
};

/** 基盤が提供するツールの全体。エージェント定義はここから選ぶ。 */
export const BUILTIN_TOOLS: Tool[] = [
  knowledgeSearch,
  skillRead,
  knowledgeRegister,
  meetingGetTranscript,
  documentCreate,
  ...WORKSPACE_TOOLS,
  ...FILE_TOOLS,
  ...RESEARCH_TOOLS,
  ...GOOGLE_TOOLS,
];
