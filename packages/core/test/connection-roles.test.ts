/**
 * @file 会社の接続のツールの役割・汎用の業務・道具の絞り込み・承認の画面の単体テスト（仕様書 第47.4節・第47.7節、ADR-0148）。
 *
 * 各社の MCP の確認の手順（準備・見直し・確定）を、ツールの役割と承認で汎用に扱えること、
 * 会社の接続ごとに汎用の業務が自動でできること、確定の合図の引数を推論に見せないことを確かめる。
 */

import { DEFAULT_TENANT_SETTINGS, type AgentDefinition, type RunStep } from '@m2office/shared';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, ExtensionHub, OFFICIAL_AGENTS, ToolRegistry, applyReviewedRoles, composeApprovalPresent, connectionAgent, connectionAgentId,
  connectorTools, heuristicRole, parseSiteInfo, profileConnectionSummary, profileToolRoles, riskOfRole, selectConnectionTools, siteConnectionAgentId, siteInfoTool, validateDefinition,
  type LlmProvider, type McpClient, type Repository, type TenantConnection, type Tool,
} from '../src/index.js';

/** 決めた答えを返す推論。 */
function fixedLlm(answer: (prompt: string) => string): LlmProvider {
  return {
    name: 'stub',
    async complete(req) {
      const prompt = req.messages.map((m) => m.content).join('\n');
      return { text: answer(prompt), tokensUsed: 10 };
    },
  } as unknown as LlmProvider;
}

/** 医院のサイトの MCP のような接続（準備・見直し・確定の 3 段）。 */
const site = (over: Partial<TenantConnection> = {}): TenantConnection => ({
  tenantId: 'a', id: 'clinic-site', name: '医院のサイト', description: '', transport: 'http', url: 'https://mcp.site.example/mcp', auth: { type: 'none' },
  tools: [
    { name: 'get_notice', description: 'お知らせを読む', risk: 'read', role: 'read' },
    { name: 'create_notice_draft', description: '下書きを作る', risk: 'external-send', role: 'prepare' },
    { name: 'prepare_notice_change', description: '予定を作り確認トークンを返す', risk: 'external-send', role: 'prepare', warnings: ['urlChangeWarning'] },
    { name: 'review_notice_change', description: '予定の中身を返す', risk: 'external-send', role: 'review' },
    { name: 'confirm_notice_change', description: 'トークンで適用する', risk: 'external-send', role: 'commit', notes: ['reminder'] },
  ],
  profile: { summary: '医院のサイトのお知らせの作成と公開ができます', site: true, generatedAt: '', reviewedAt: null },
  origin: 'manual', createdBy: 'u', createdAt: '', updatedAt: '',
  ...over,
});

test('名前と目印だけで決める役割は、分からなければ確定（承認を通す側）にする', () => {
  assert.equal(heuristicRole({ name: 'get_page', description: '' }), 'read');
  assert.equal(heuristicRole({ name: 'prepare_notice_change', description: '' }), 'prepare');
  assert.equal(heuristicRole({ name: 'review_notice_change', description: '' }), 'review');
  assert.equal(heuristicRole({ name: 'confirm_operation', description: '' }), 'commit');
  assert.equal(heuristicRole({ name: 'restore_site_css', description: '' }), 'undo');
  assert.equal(heuristicRole({ name: 'move_menu_item', description: '' }), 'commit', '名前で分からないものは確定');
  assert.equal(heuristicRole({ name: 'list_things', description: '', destructive: true }), 'commit', '壊す目印があれば読むにしない');
  assert.equal(heuristicRole({ name: 'whatever', description: '', readOnly: true }), 'read');
});

test('役割から決まる危険度は、読む・見直しは読むだけ、準備は下書き、確定と戻すは社外へ送る', () => {
  assert.equal(riskOfRole('read'), 'read');
  assert.equal(riskOfRole('review'), 'read');
  assert.equal(riskOfRole('prepare'), 'draft');
  assert.equal(riskOfRole('commit'), 'external-send');
  assert.equal(riskOfRole('undo'), 'external-send');
  const tools = applyReviewedRoles(site().tools);
  assert.deepEqual(tools.map((t) => t.risk), ['read', 'draft', 'draft', 'read', 'external-send']);
  assert.ok(tools.every((t) => t.roleReviewed));
});

test('推論が決めた役割を使い、壊す目印のあるものは読むにしない。確定の合図は引数にあるものだけを使う', async () => {
  const llm = fixedLlm(() => JSON.stringify({ tools: [
    { name: 'get_page', role: 'read' },
    { name: 'delete_cache', role: 'read' },
    { name: 'posts_update', role: 'commit', confirmArg: 'user_confirmed', warnings: ['urlChangeWarning'] },
    { name: 'publish', role: 'commit', confirmArg: 'not_an_arg' },
  ] }));
  const roles = await profileToolRoles(llm, [
    { name: 'get_page', description: 'ページを読む' },
    { name: 'delete_cache', description: '消す', destructive: true },
    { name: 'posts_update', description: '記事を直す', argNames: ['id', 'user_confirmed'] },
    { name: 'publish', description: '公開する', argNames: ['id'] },
    { name: 'restore_page', description: '戻す' },
  ]);
  const by = (n: string) => roles.find((r) => r.name === n)!;
  assert.equal(by('get_page').role, 'read');
  assert.equal(by('delete_cache').role, 'commit', '壊す目印があれば読むにしない');
  assert.equal(by('posts_update').confirmArg, 'user_confirmed');
  assert.deepEqual(by('posts_update').warnings, ['urlChangeWarning']);
  assert.equal(by('publish').confirmArg, undefined, '引数に無い名前は使わない');
  assert.equal(by('restore_page').role, 'undo', '推論が答えなかったものは名前で決める');
});

test('推論が使えなくても、名前から説明を作る', async () => {
  const plain = await profileConnectionSummary(null, '医院のサイト', [{ name: 'get_notice', role: 'read', description: '' }]);
  assert.match(plain.summary, /医院のサイト/);
  const llm = fixedLlm(() => '{"summary":"お知らせの作成と公開ができます","site":true}');
  assert.deepEqual(await profileConnectionSummary(llm, '医院のサイト', [{ name: 'get_notice', role: 'read', description: '' }]), { summary: 'お知らせの作成と公開ができます', site: true });
});

test('接続の業務は、管理者が役割を見るまで作らない。見たあとは 1 本の会話の段 1 つで、すべての道具を持つ（第48章）', () => {
  assert.equal(connectionAgent(site(), new Set()), null, '役割を見ていなければ作らない');
  const reviewed = site({ tools: applyReviewedRoles(site().tools), profile: { ...site().profile!, reviewedAt: '2026-11-15T00:00:00Z' } });
  const all = new Set(reviewed.tools.map((t) => `clinic-site.${t.name}`));
  const def = connectionAgent(reviewed, all)!;
  assert.equal(def.id, connectionAgentId('clinic-site'));
  assert.equal(def.name, '医院のサイト');
  assert.equal(def.menu, false, 'メニューには出さない（秘書が取り次ぐ）');
  assert.match(def.routeHint!, /お知らせの作成と公開/);
  assert.equal(def.steps.length, 1, '段の型（進める → 承認 → 確定）ではなく、1 本の会話の段 1 つ');
  const [work] = def.steps;
  assert.ok(work?.type === 'agent' && work.conversation, '1 本の会話の段');
  assert.ok(work?.type === 'agent' && work.tools!.includes('clinic-site.confirm_notice_change') && work.tools!.includes('clinic-site.prepare_notice_change'), '確定の道具も持つ（呼んだ所で止める）');
  // 会社のサイトを扱う接続は、サイトの更新の付属の業務にする（第47.7節）
  const asSite = connectionAgent({ ...reviewed, profile: { ...reviewed.profile!, siteName: 'みどり皮膚科' } }, all, { site: true })!;
  assert.equal(asSite.id, siteConnectionAgentId('clinic-site'));
  assert.equal(asSite.id, 'site-updates:site-clinic-site', '利用範囲はサイトの更新と同じ');
  assert.equal(asSite.name, 'サイトの直し案（みどり皮膚科）');
  assert.match(asSite.routeHint!, /会社のサイト「みどり皮膚科」/);
  assert.ok(asSite.steps[0]?.type === 'agent' && asSite.steps[0].conversation?.present.startsWith('「みどり皮膚科」のサイトで'), '承認の 1 行目にサイトを出す');
  // 定義の検証を通る（会話の段は、呼び出しの所で承認を求めるので承認ゲートを持つものとみなす）
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  validateDefinition(def, registry.extend(connectorTools(reviewed)));
  // 読むだけの接続は作らない（秘書の調べものが使う）
  const readOnly = site({ tools: [{ name: 'get_notice', description: '', risk: 'read', role: 'read', roleReviewed: true }], profile: { ...site().profile!, reviewedAt: 'x' } });
  assert.equal(connectionAgent(readOnly, new Set(['clinic-site.get_notice'])), null);
});

test('会社のサイトの接続は、サイトの更新を入れている会社でだけ、サイトの更新の付属の業務になる。別の業務は作らない', async () => {
  const connections: TenantConnection[] = [site({ tools: applyReviewedRoles(site().tools), profile: { ...site().profile!, reviewedAt: 'x' } })];
  let siteUpdatesOn = false;
  const repo = {
    listInstalledExtensions: async () => [], listDisabledConnectorTools: async () => [],
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, siteUpdates: { ...DEFAULT_TENANT_SETTINGS.siteUpdates, enabled: siteUpdatesOn } }),
    listPrivateExtensions: async () => [], listConnections: async () => connections, saveConnection: async () => undefined,
  } as unknown as Repository;
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const hub = new ExtensionHub({ repo, registry, official: OFFICIAL_AGENTS, packages: [] });
  let view = await hub.forTenant('a');
  assert.ok(!view.isAvailable(siteConnectionAgentId('clinic-site')), 'サイトの更新を入れていなければ作らない');
  assert.ok(!view.isAvailable(connectionAgentId('clinic-site')), 'サイトの接続の別の業務は作らない');
  siteUpdatesOn = true;
  view = await hub.forTenant('a');
  assert.ok(view.isAvailable(siteConnectionAgentId('clinic-site')));
  assert.ok(!view.agents.some((a) => a.id === connectionAgentId('clinic-site')));
  const lookup = view.agents.find((a) => a.id === 'secretary-lookup')!;
  assert.ok(lookup.tools.includes('clinic-site.get_notice'), '読む道具は秘書の調べものも使う');
  assert.ok(!lookup.tools.includes('clinic-site.review_notice_change'), '見直しは準備と組で使うので渡さない');
  assert.ok(!lookup.tools.includes('clinic-site.prepare_notice_change'), '準備（下書き）は渡さない');
});

test('確定の合図の引数は推論に見せず、呼ぶときに M2Office が真にする（読むだけに下げたツールでは付けない）', async () => {
  const sent: Record<string, unknown>[] = [];
  const client: McpClient = {
    async listTools() { return { ok: true as const, tools: [] }; },
    async callTool(_u, _n, args) { sent.push(args); return { ok: true as const, text: '{"ok":true}', truncated: false }; },
  };
  const c = site({
    tools: [
      { name: 'posts_update', description: '記事を直す', risk: 'external-send', role: 'commit', confirmArg: 'user_confirmed', args: { properties: { id: { type: 'string' }, user_confirmed: { type: 'boolean' } }, required: ['id', 'user_confirmed'] } },
      { name: 'posts_peek', description: '読む', risk: 'read', role: 'commit', confirmArg: 'user_confirmed', args: { properties: { user_confirmed: { type: 'boolean' } } } },
    ],
  });
  const [update, peek] = connectorTools(c, client);
  assert.deepEqual(Object.keys(update!.args!.properties), ['id'], '推論には合図の引数を見せない');
  assert.deepEqual(update!.args!.required, ['id']);
  await update!.invoke({ id: '7' }, { tenantId: 'a', userId: 'u' } as never);
  assert.deepEqual(sent[0], { id: '7', user_confirmed: true });
  assert.ok('user_confirmed' in peek!.args!.properties, '読むだけに下げたツールでは外さない');
  await peek!.invoke({}, { tenantId: 'a', userId: 'u' } as never);
  assert.deepEqual(sent[1], {}, '読むだけに下げたツールでは付けない（承認を通らないため）');
});

test('道具の多い接続では、要るものを先に選ぶ。内蔵の道具は選ばずにすべて渡す', async () => {
  const mk = (name: string, connection: boolean): Tool => ({
    name, risk: 'read', description: name, activityLabel: '', helpText: '', async invoke() { return null; },
    ...(connection ? { connection: { id: 'x', name: 'x', tool: name } } : {}),
  });
  const few = [mk('knowledge.search', false), ...Array.from({ length: 5 }, (_, i) => mk(`x.t${i}`, true))];
  const same = await selectConnectionTools(fixedLlm(() => '{}'), few, '依頼');
  assert.equal(same.tools.length, 6);
  assert.equal(same.selected, null);
  const many = [mk('knowledge.search', false), ...Array.from({ length: 40 }, (_, i) => mk(`x.t${i}`, true))];
  const picked = await selectConnectionTools(fixedLlm(() => '{"tools":["x.t3","x.t7","nope"]}'), many, 'お知らせを書いて');
  assert.deepEqual(picked.tools.map((t) => t.name), ['knowledge.search', 'x.t3', 'x.t7']);
  assert.deepEqual(picked.selected, ['x.t3', 'x.t7']);
  const none = await selectConnectionTools(fixedLlm(() => 'わかりません'), many, 'お知らせを書いて');
  assert.equal(none.tools.length, 41, '選べなければすべて渡す（業務を止めない）');
});

test('承認の画面に、相手の見直しの結果（直す前と後）と、相手の注意を言葉のまま出す', () => {
  const c = site({ tools: applyReviewedRoles(site().tools) });
  const registry = new ToolRegistry().extend(connectorTools(c));
  const def = { id: 'connection-clinic-site', steps: [{ id: 'work', type: 'agent', instruction: '' }, { id: 'approve', type: 'approval', present: '確かめてください', approverRole: [] }, { id: 'commit', type: 'agent', instruction: '' }] } as unknown as AgentDefinition;
  const ext = (text: string) => ({ source: 'external', connector: 'clinic-site', text, truncated: false });
  const steps: RunStep[] = [{
    id: 's1', runId: 'r', seq: 0, stepId: 'work', kind: 'agent', status: 'succeeded', input: {}, startedAt: '', endedAt: '',
    output: {
      text: '休診のお知らせを用意しました',
      tools: [
        { name: 'clinic-site.prepare_notice_change', risk: 'draft', result: ext(JSON.stringify({ confirmationToken: 'a'.repeat(64), urlChangeWarning: 'URL が変わります。以前の URL は表示されなくなります' })) },
        { name: 'clinic-site.review_notice_change', risk: 'read', result: ext(JSON.stringify({
          current: { title: '診療時間', contentHtml: '<p>月曜は休診</p>', slug: 'a' },
          proposed: { title: '診療時間', contentHtml: '<p>月曜と木曜は休診</p>', slug: 'a' },
          changedFields: ['contentHtml'],
        })) },
      ],
    },
  } as unknown as RunStep];
  const text = composeApprovalPresent({ def, gate: def.steps[1] as never, gateSeq: 1, steps, artifacts: [], plan: null, registry });
  assert.match(text, /医院のサイトの見直しの結果/);
  assert.match(text, /contentHtml/);
  assert.match(text, /月曜は休診/);
  assert.match(text, /月曜と木曜は休診/);
  assert.doesNotMatch(text, /\*\*title\*\*/, '変わらない項目は出さない');
  assert.match(text, /注意（相手の言葉のまま）/);
  assert.match(text, /URL が変わります。以前の URL は表示されなくなります/);
  assert.equal(text.split('\n')[0], '確かめてください', '1 行目は定義の present');
});

test('引数ひとつで表示にできる準備の道具は確定にする。長い説明は後ろの手がかりも渡す', async () => {
  const seen: string[] = [];
  const llm = fixedLlm((prompt) => {
    seen.push(prompt);
    return JSON.stringify({ tools: [{ name: 'add_slide', role: 'prepare' }, { name: 'search_pages', role: 'read' }, { name: 'create_page_draft', role: 'prepare' }] });
  });
  const long = `${'書き方の決まり。'.repeat(150)}下書き・公開待ちの固定ページを作ります。公開済みのページには使えません。`;
  const roles = await profileToolRoles(llm, [
    { name: 'add_slide', description: '既定では非表示で作ります', argNames: ['imageId', 'hidden'] },
    { name: 'search_pages', description: 'ページを探す', argNames: ['query', 'status'] },
    { name: 'create_page_draft', description: long, argNames: ['title', 'contentHtml'] },
  ]);
  assert.equal(roles.find((r) => r.name === 'add_slide')!.role, 'commit', 'hidden で最初から表示にできる');
  assert.equal(roles.find((r) => r.name === 'search_pages')!.role, 'read', '読む道具の status は絞り込み');
  assert.equal(roles.find((r) => r.name === 'create_page_draft')!.role, 'prepare');
  assert.match(seen[0]!, /下書き・公開待ちの固定ページを作ります/, '頭より後ろの手がかりも渡す');
});

test('サイトの情報の道具を選び、答えから名前と https の URL だけを読む', () => {
  const tools = [
    { name: 'get_page', role: 'read' as const, args: { required: ['id'] } },
    { name: 'get_site_info', role: 'read' as const, args: { required: [] } },
  ];
  assert.equal(siteInfoTool(tools)?.name, 'get_site_info');
  assert.equal(siteInfoTool([{ name: 'get_site_info', role: 'commit' as const }]), null, '読む道具だけ');
  assert.deepEqual(parseSiteInfo('{"name":"みどり皮膚科","url":"https://site.example/wp/1/"}'), { siteName: 'みどり皮膚科', siteUrl: 'https://site.example/wp/1/' });
  assert.deepEqual(parseSiteInfo('{"name":"x","url":"javascript:alert(1)"}'), { siteName: 'x' }, 'https でない URL は読まない');
  assert.deepEqual(parseSiteInfo('読めない'), {});
});
