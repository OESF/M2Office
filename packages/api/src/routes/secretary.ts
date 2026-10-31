/**
 * @file 秘書への依頼を受け付ける API。どの層（直接応答・取次・対話）で答えたかも返す。
 *
 * 手元のファイルを添えられる（`fileId`、いくつもなら `fileIds`。5 つまで。仕様書 第10.10節）。
 *
 * 最初の画面で秘書が話しかける一言（今日の様子・次の頼みの候補・会話の例。第6.1.5節）も返す。
 *
 * @see 仕様書 第10.9節 応答の経路、第10.10節 秘書にファイルを渡す、第6.1.5節 最初の画面の呼びかけ
 */

import { Hono } from 'hono';
import { SECRETARY_FILES_MAX, type RequestContext } from '@m2office/shared';
import { homeBriefPrompt, parseHomeBrief, pickSome, secretaryExamples, HOME_SUGGESTIONS_MAX, type HomeBrief } from '@m2office/core';
import { claimUntold, listLookups } from '../secretary/lookups.js';
import { homeFacts } from '../secretary/facts.js';
import { personaLines } from '../voice/persona.js';
import type { AppDeps } from '../context.js';

/** 最初の画面の一言を使い回す長さ（ミリ秒。第6.1.5節「作り直し」）。 */
const HOME_BRIEF_TTL_MS = 30 * 60_000;
/** 控えておく人数の上限（超えたら古いものから捨てる）。 */
const HOME_BRIEF_CACHE_MAX = 5000;
/** ヘルプの「秘書にできること（会話の例）」の記事の ID。 */
const EXAMPLES_ARTICLE = 'start-secretary-examples';

/**
 * 秘書への依頼を受け付ける。
 *
 * 応答は 3 層に振り分けられ、どの層で答えたかを返す（仕様書 第10.9節）。
 * 層 1 は LLM を介さないため、費用も遅延も発生しない。
 */
export function secretaryRoute(deps: AppDeps) {
  const app = new Hono<{ Variables: { ctx: RequestContext } }>();
  // 最初の画面の一言の控え（会社と人ごと）。材料が同じなら 30 分は AI を呼ばない
  const briefs = new Map<string, { key: string; at: number; brief: HomeBrief }>();
  let examples: string[] | null = null;

  app.post('/', async (c) => {
    const ctx = c.get('ctx');
    const { message, fileId, fileIds } = await c.req.json<{ message: string; fileId?: string; fileIds?: unknown }>();
    // いくつものファイル（第10.10.7節）。文字の ID だけを受け取り、多すぎれば断る
    const files = [...(Array.isArray(fileIds) ? fileIds.filter((f): f is string => typeof f === 'string' && !!f.trim()) : []), ...(fileId?.trim() ? [fileId.trim()] : [])];
    if (files.length > SECRETARY_FILES_MAX) return c.json({ error: `一度に渡せるファイルは ${SECRETARY_FILES_MAX} つまでです` }, 400);
    if (!message?.trim()) {
      return c.json({ error: '依頼の内容を入力してください' }, 400);
    }
    const started = Date.now();
    // デバッグモードでは、依頼と答えを記録に残す（仕様書 第20.4.1節「デバッグモード」）。振り分けの経過はその間に秘書が足す
    deps.debug?.add(ctx.tenant.id, ctx.user.id, 'secretary', `文字の依頼: ${message}`, { message, fileIds: files });
    // ファイルは本人が上げたものだけを読む。他人の ID を書いても読まない（仕様書 第10.10.2節）
    const reply = await deps.secretary.respond(ctx.tenant.id, ctx.user.id, message, files.length > 1 ? files : files[0]);
    deps.debug?.add(ctx.tenant.id, ctx.user.id, 'secretary', `秘書の答え（${reply.layer}・${Date.now() - started} ms）: ${reply.text}`, reply);
    return c.json({ ...reply, elapsedMs: Date.now() - started });
  });

  /**
   * 後ろへ回した調べものの状態（仕様書 第10.11.6・10.11.7節）。
   *
   * @remarks
   * 画面はこれを定期的に読み、**動いているものを処理中として見せる**。
   * 秘書が黙り込んだように見えることを防ぐ、いちばん効く手当てである。
   *
   * 画面を開き直したときも同じものが返る。進み具合は変化したときにしか
   * 変わらないため、送り直しが無いと、途中から見た人には何も動いていないように見える。
   */
  app.get('/lookups', async (c) => {
    const ctx = c.get('ctx');
    const items = await listLookups(deps.repo, ctx.tenant.id, ctx.user.id, await agentNames(deps, ctx.tenant.id));
    return c.json({ items });
  });

  /**
   * まだ伝えていない調べものを受け取る（仕様書 第10.11.7節「持ち越し」）。
   *
   * @remarks
   * **読むだけの口ではない。** 返したものは「伝えた」として記録される。
   * 画面はこれを定期的に呼び、返ってきたものを秘書の応答として出す。
   * 記録を先に取るため、音声の側と二重に伝えることはない。
   */
  app.post('/lookups/claim', async (c) => {
    const ctx = c.get('ctx');
    const items = await claimUntold(deps.repo, ctx.tenant.id, ctx.user.id, new Date(), await agentNames(deps, ctx.tenant.id));
    // 後ろへ回した調べものの結果を画面が受け取った（デバッグモード。第20.4.1節「デバッグモード」）
    for (const it of items) deps.debug?.add(ctx.tenant.id, ctx.user.id, 'secretary', `調べものの結果を画面へ: ${JSON.stringify(it).slice(0, 120)}`, it);
    return c.json({ items });
  });

  /**
   * 最初の画面で秘書が話しかける一言（第6.1.5節、ADR-0119）。
   *
   * @remarks
   * 取れた事実だけを材料に、今日の様子（1〜3 文）と次の頼みの候補（3 つまで）を AI に作らせる。
   * 材料が無い・AI が使えないときは、今日の様子を出さず、候補は会話の例から選ぶ。詫びない。
   * 会話の例の紹介（`example`）は AI を使わず、毎回入れ替える。
   */
  app.get('/home', async (c) => {
    const ctx = c.get('ctx');
    const tenantId = ctx.tenant.id;
    const userId = ctx.user.id;
    const [prefs, company, facts] = await Promise.all([
      deps.repo.getUserSettings(tenantId, userId),
      deps.repo.getTenantSettings(tenantId).catch(() => null),
      homeFacts(deps, tenantId, userId, deps.log),
    ]);
    if (!examples) {
      const article = company ? deps.help.get(EXAMPLES_ARTICLE, { roles: ctx.user.roles, disabledAgents: [], automation: company.automation }) : null;
      examples = article ? secretaryExamples(article.body) : [];
    }
    const [example = null, ...others] = pickSome(examples, HOME_SUGGESTIONS_MAX + 1);
    const fallback = others.slice(0, HOME_SUGGESTIONS_MAX);
    if (facts.length === 0) return c.json({ message: null, suggestions: fallback, example });

    // 材料と本人の設定が同じなら、作った文を使い回す（費用を抑えるため）
    const s = prefs.secretary;
    const key = JSON.stringify([facts, s.name, s.callMe, s.style]);
    const mark = `${tenantId}:${userId}`;
    const kept = briefs.get(mark);
    let brief: HomeBrief | null = kept && kept.key === key && Date.now() - kept.at < HOME_BRIEF_TTL_MS ? kept.brief : null;
    if (!brief) {
      const org = company?.company?.shortName?.trim() || company?.company?.legalName?.trim() || '';
      try {
        const llm = await deps.ai.llmFor(tenantId);
        const res = await llm.complete({
          tier: 'fast', maxOutputTokens: 400,
          messages: homeBriefPrompt(personaLines({ org, displayName: ctx.user.displayName, secretary: s, timeZone: prefs.profile?.timezone }), facts, examples),
        });
        brief = parseHomeBrief(res.text);
      } catch (err) {
        // 鍵が無い・上限に達した・失敗した。今日の様子を出さないだけで、画面は出す
        deps.log.warn('最初の画面の一言を作れませんでした', { err });
        brief = { message: null, suggestions: [] };
      }
      if (briefs.size >= HOME_BRIEF_CACHE_MAX) briefs.delete(briefs.keys().next().value!);
      briefs.delete(mark);
      briefs.set(mark, { key, at: Date.now(), brief });
    }
    return c.json({
      message: brief.message,
      suggestions: brief.suggestions.length > 0 ? brief.suggestions : fallback,
      example: example && !brief.suggestions.includes(example) ? example : null,
    });
  });

  return app;
}

/** その会社の業務の名前を引く（拡張機能の業務を含む）。秘書が頼んだ業務の結果を伝えるときに名前を添える。 */
async function agentNames(deps: AppDeps, tenantId: string): Promise<(agentId: string) => string | undefined> {
  const view = await deps.tenantView(tenantId);
  return (agentId) => view.agents.find((a) => a.id === agentId)?.name;
}
