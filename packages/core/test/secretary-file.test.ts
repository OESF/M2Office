/**
 * @file 秘書にファイルを渡したときの単体テスト。
 *
 * 後ろへ回すこと（第10.11節）、他人のファイルを読まないこと、文字にすることを確かめる。
 *
 * @see 仕様書 第10.10節 秘書にファイルを渡す、第10.11節 重い依頼を後ろへ回す
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryFileStore, OFFICIAL_AGENTS, Secretary, acceptsFile, fileToText, saveFile,
  TEXT_LIMIT, type LlmProvider, type Repository,
} from '../src/index.js';

const SETTINGS = {
  agents: { disabled: [] as string[] },
  access: { scopes: {} as Record<string, unknown> },
};

/** 推論の代わり。渡されたメッセージを控え、決まった文を返す。 */
function fakeLlm(reply = 'わかりました'): LlmProvider & { seen: { role: string; content: string }[][] } {
  const seen: { role: string; content: string }[][] = [];
  return {
    name: 'fake',
    seen,
    async complete(req) {
      seen.push(req.messages as { role: string; content: string }[]);
      return { text: reply, tokensUsed: 3 };
    },
  } as LlmProvider & { seen: { role: string; content: string }[][] };
}

function fakeRepo() {
  return {
    getTenantSettings: async () => SETTINGS,
    getUserSettings: async () => ({
      secretary: { name: '', callMe: '', style: 'polite' },
      memory: { keepConversations: false },
    }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listMemories: async () => [],
    appendAudit: async () => undefined,
    appendConversation: async () => undefined,
  } as unknown as Repository;
}

test('ファイルが付いていれば、応答の中では読まず、後ろへ回す', async () => {
  const llm = fakeLlm();
  const started: { request: string; fileId?: string }[] = [];
  const s = new Secretary({
    repo: fakeRepo(), llm, connector: {} as never, agents: [],
    fileName: async () => '議事録.pdf',
    startLookup: async (_t, _u, request, fileId) => {
      started.push({ request, fileId });
      return { runId: 'r-1', already: false };
    },
  });

  // 「今日の予定は」は層 1 の照会だが、ファイルが付いていれば後ろへ回す
  const reply = await s.respond('t', 'u1', '今日の予定は', 'f1');
  assert.deepEqual(started, [{ request: '今日の予定は', fileId: 'f1' }]);
  // 応答の中では推論を呼ばない。ここで待たせないことが眼目である
  assert.equal(llm.seen.length, 0);
  assert.equal(reply.lookup?.runId, 'r-1');
});

test('受け付けの返事に、結果を混ぜない（仕様書 第10.11.5節）', async () => {
  const s = new Secretary({
    repo: fakeRepo(), llm: fakeLlm(), connector: {} as never, agents: [],
    fileName: async () => '見積書.pdf',
    startLookup: async () => ({ runId: 'r-1', already: false }),
  });

  const reply = await s.respond('t', 'u1', 'この見積書の金額は', 'f1');
  // 受け付けたことだけを返す。結果はまだ何も無い
  assert.match(reply.text, /お預かりしました/);
  assert.ok(reply.lookup, '後ろへ回したことを示す');
  assert.equal(reply.tokensUsed, 0);
  assert.equal(reply.file?.name, '見積書.pdf');
});

test('同じ依頼が動いていれば、新しく起こさない', async () => {
  const s = new Secretary({
    repo: fakeRepo(), llm: fakeLlm(), connector: {} as never, agents: [],
    fileName: async () => '売上.csv',
    startLookup: async () => ({ runId: 'r-1', already: true }),
  });

  const reply = await s.respond('t', 'u1', '集計して', 'f1');
  assert.match(reply.text, /いまお調べしています/);
  assert.equal(reply.lookup?.runId, 'r-1');
});

test('後ろへ回せなければ、回せなかったことを正直に伝える', async () => {
  const llm = fakeLlm();
  const s = new Secretary({
    repo: fakeRepo(), llm, connector: {} as never, agents: [],
    fileName: async () => '資料.pdf',
    startLookup: async () => null,
  });

  const reply = await s.respond('t', 'u1', 'これを読んで', 'f1');
  assert.match(reply.text, /いまお調べできません/);
  assert.equal(reply.lookup, undefined);
  // 黙って同期で読み直さない
  assert.equal(llm.seen.length, 0);
});

test('他人のファイルは、名前も示さない', async () => {
  const s = new Secretary({
    repo: fakeRepo(), llm: fakeLlm(), connector: {} as never, agents: [],
    fileName: async () => null,
    startLookup: async () => ({ runId: 'r-1', already: false }),
  });

  const reply = await s.respond('t', 'u1', 'これを読んで', 'f-other');
  assert.match(reply.text, /見つかりませんでした/);
  assert.equal(reply.lookup, undefined);
});

test('ファイルを受け取れる業務があれば、取次を提案する（勝手に始めない）', async () => {
  const minutes = OFFICIAL_AGENTS.find((a) => a.id === 'minutes')!;
  const llm = fakeLlm('{"agentId":"minutes","reason":"議事録の依頼"}');
  let startedLookup = false;
  const s = new Secretary({
    repo: fakeRepo(), llm, connector: {} as never, agents: [minutes],
    fileName: async () => '文字起こし.docx',
    startLookup: async () => { startedLookup = true; return { runId: 'r-1', already: false }; },
  });

  const reply = await s.respond('t', 'u1', 'この記録から議事録を作って', 'f1');
  // 承認が要る業務は、秘書が裏で勝手に始めない（第10.11.4節）
  assert.equal(reply.layer, 'light');
  assert.equal(reply.suggestedAgent?.id, 'minutes');
  assert.equal(startedLookup, false, '調べものとしては起こさない');
  assert.equal(reply.file?.name, '文字起こし.docx');
});

test('ファイルを受け取れる業務だけを、取次の候補にする', () => {
  const minutes = OFFICIAL_AGENTS.find((a) => a.id === 'minutes')!;
  const qa = OFFICIAL_AGENTS.find((a) => a.id === 'knowledge-qa')!;
  // AG-02 は文字起こしのファイルを受け取れる（仕様書 第9.5.2節）
  assert.equal(acceptsFile(minutes), true);
  assert.equal(acceptsFile(qa), false);
});

test('他人のファイルは読まない', async () => {
  const store = new MemoryFileStore();
  const saved: Record<string, unknown>[] = [];
  const repo = {
    createFile: async (f: Record<string, unknown>) => { saved.push(f); },
    getFile: async (_t: string, id: string) => saved.find((f) => f['id'] === id) ?? null,
    listApprovalsForFileInput: async () => [],
  } as unknown as Repository;
  const meta = await saveFile(repo, store, {
    tenantId: 't', ownerUserId: 'u-owner', name: 'private.csv', kind: 'csv',
    bytes: new TextEncoder().encode('a,b\n1,2\n'), origin: 'upload', runId: null,
  });

  const mine = await fileToText(repo, store, 't', meta.id, 'u-owner');
  assert.equal(mine.ok, true);
  const theirs = await fileToText(repo, store, 't', meta.id, 'u-other');
  assert.equal(theirs.ok, false);
  assert.equal(theirs.note, 'ファイルが見つかりません');
});

test('CSV を行と列の文字にする', async () => {
  const store = new MemoryFileStore();
  const saved: Record<string, unknown>[] = [];
  const repo = {
    createFile: async (f: Record<string, unknown>) => { saved.push(f); },
    getFile: async (_t: string, id: string) => saved.find((f) => f['id'] === id) ?? null,
    listApprovalsForFileInput: async () => [],
  } as unknown as Repository;
  const meta = await saveFile(repo, store, {
    tenantId: 't', ownerUserId: 'u1', name: '売上.csv', kind: 'csv',
    bytes: new TextEncoder().encode('品目,金額\nりんご,100\n'), origin: 'upload', runId: null,
  });

  const r = await fileToText(repo, store, 't', meta.id, 'u1');
  assert.equal(r.ok, true);
  assert.equal(r.name, '売上.csv');
  assert.match(r.text, /品目\t金額/);
  assert.match(r.text, /りんご\t100/);
});

test('長すぎる中身は切り、切ったことを断る', async () => {
  const store = new MemoryFileStore();
  const saved: Record<string, unknown>[] = [];
  const repo = {
    createFile: async (f: Record<string, unknown>) => { saved.push(f); },
    getFile: async (_t: string, id: string) => saved.find((f) => f['id'] === id) ?? null,
    listApprovalsForFileInput: async () => [],
  } as unknown as Repository;
  // 表は先頭 200 行までを読む。1 行を長くして、200 行で上限を確実に超えさせる
  const long = 'あ'.repeat(150);
  const body = `品目,備考\n${`${long},${long}\n`.repeat(200)}`;
  const meta = await saveFile(repo, store, {
    tenantId: 't', ownerUserId: 'u1', name: '大きい.csv', kind: 'csv',
    bytes: new TextEncoder().encode(body), origin: 'upload', runId: null,
  });

  const r = await fileToText(repo, store, 't', meta.id, 'u1');
  assert.equal(r.ok, true);
  assert.equal(r.text.length, TEXT_LIMIT);
  // 推測で埋めず、切ったことを正直に書く
  assert.match(r.note ?? '', /先頭の 20,000 字だけを読みました/);
});
