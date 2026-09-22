/**
 * @file Google Workspace を操作するツール（第 1 弾）と、引数の定義の単体テスト。見本の接続口で確かめる。
 *
 * @see 仕様書 第9.4.4節 Google Workspace を操作するツールの一覧
 * @see 仕様書 第14.3.2節 CASA に備えた作り
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TOOLS, MockWorkspaceConnector, ToolRegistry, validateToolArgs, type ToolContext } from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const run = (name: string, args: Record<string, unknown>, ctx: ToolContext) => registry.get(name)!.invoke(args, ctx) as Promise<Record<string, any>>;
const makeCtx = (userId = 'u1'): ToolContext & { connector: MockWorkspaceConnector } => ({
  tenantId: 't', userId, runId: 'r', compartment: null, repo: {} as never, files: {} as never,
  connector: new MockWorkspaceConnector(),
});

test('すべての内蔵ツールが引数の定義を持ち、Google を使うツールは権限と段階を宣言している（第14.3.2節 規定 1）', () => {
  for (const t of BUILTIN_TOOLS) {
    assert.ok(t.args, `${t.name} に引数の定義がありません`);
    for (const r of t.args!.required ?? []) assert.ok(t.args!.properties[r], `${t.name}: 必須の ${r} の定義がありません`);
  }
  const google = ['gmail.', 'calendar.', 'tasks.', 'chat.', 'drive.', 'docs.', 'sheets.', 'slides.', 'directory.', 'meet.'];
  for (const t of BUILTIN_TOOLS.filter((x) => google.some((p) => x.name.startsWith(p)))) {
    assert.ok(t.google, `${t.name} に必要な権限の宣言がありません`);
  }
});

test('制限付きの権限を使うツールは Gmail の読み取り・下書きだけ（第14.3.2節 規定 3）', () => {
  const restricted = BUILTIN_TOOLS.filter((t) => t.google?.level === 'restricted').map((t) => t.name).sort();
  assert.deepEqual(restricted, ['gmail.create_draft', 'gmail.get', 'gmail.list', 'gmail.search']);
  assert.ok(BUILTIN_TOOLS.filter((t) => t.name.startsWith('drive.')).every((t) => t.google?.scope === 'drive.file'), 'ドライブは drive.file だけ');
});

test('引数の検証: 必須・型・選択肢を確かめ、数字だけの文字列は数値として受け付ける', () => {
  const schema = registry.get('gmail.send')!.args!;
  assert.deepEqual(validateToolArgs(schema, { to: ['a@x.jp'], subject: 's', body: 'b' }), []);
  assert.ok(validateToolArgs(schema, { to: ['a@x.jp'], body: 'b' }).some((p) => p.includes('subject')));
  assert.ok(validateToolArgs(schema, { to: 'a@x.jp', subject: 's', body: 'b' }).some((p) => p.includes('文字列の配列')));
  assert.deepEqual(validateToolArgs(registry.get('gmail.search')!.args!, { query: 'x', limit: '5' }), []);
  assert.ok(validateToolArgs(registry.get('sheet.render')!.args!, { title: 't', columns: [], rows: [], format: 'pdf' }).some((p) => p.includes('xlsx')));
});

test('危険度: 送る・通知が届くものは external-send、社内の表や ToDo への書き込みは write-internal', () => {
  const risk = (n: string) => registry.get(n)!.risk;
  assert.equal(risk('gmail.send'), 'external-send');
  assert.equal(risk('calendar.update'), 'external-send');
  assert.equal(risk('calendar.cancel'), 'external-send');
  assert.equal(risk('sheets.append'), 'write-internal');
  assert.equal(risk('tasks.complete'), 'write-internal');
  assert.equal(risk('docs.create'), 'draft');
  assert.equal(risk('drive.read'), 'read');
});

test('ドキュメント: 作った文書に追記でき、見本のファイルや他人の文書には追記できない', async () => {
  const ctx = makeCtx();
  const created = await run('docs.create', { title: '議事メモ', body: '1 行目' }, ctx);
  assert.equal(created['source'], 'mock');
  await run('docs.append', { documentId: created['file'].id, text: '2 行目' }, ctx);
  const read = await run('drive.read', { fileId: created['file'].id }, ctx);
  assert.equal(read['text'], '1 行目\n2 行目');
  assert.equal(read['untrusted'], true, '中身はデータとして印を付ける（不変則 I-6）');
  const sample = await run('docs.append', { documentId: 'mock-file-t-1', text: 'x' }, ctx);
  assert.equal(sample['appended'], false);
  const other = await registry.get('docs.append')!.invoke({ documentId: created['file'].id, text: 'x' }, { ...ctx, userId: 'u2' }) as Record<string, unknown>;
  assert.equal(other['appended'], false, '他人が作った文書には追記しない');
});

test('スプレッドシート: 作って、行を足して、読める。ドライブの検索にも出る', async () => {
  const ctx = makeCtx();
  const created = await run('sheets.create', { title: '訪問記録', columns: ['日付', '会社'], rows: [['9/1', '見本商事']] }, ctx);
  const id = created['file'].id;
  assert.equal((await run('sheets.append', { spreadsheetId: id, rows: [['9/2', '見本工業']] }, ctx))['appended'], 1);
  const read = await run('sheets.read', { spreadsheetId: id }, ctx);
  assert.deepEqual(read['columns'], ['日付', '会社']);
  assert.deepEqual(read['rows'], [['9/1', '見本商事'], ['9/2', '見本工業']]);
  const found = await run('drive.search', { query: '訪問' }, ctx);
  assert.deepEqual(found['items'].map((f: { name: string }) => f.name), ['訪問記録']);
  const samples = await run('drive.search', { query: '（見本）' }, ctx);
  assert.equal(samples['count'], 2, '見本のファイルは名前に（見本）と付く');
});

test('Gmail: 検索は本文を返さず、送信は宛先が無ければ送らない', async () => {
  const ctx = makeCtx();
  const found = await run('gmail.search', { query: '発注' }, ctx);
  assert.equal(found['count'], 1);
  assert.equal('body' in found['items'][0], false);
  assert.equal((await run('gmail.send', { to: [], subject: 's', body: 'b' }, ctx))['sent'], false);
  const sent = await run('gmail.send', { to: ['sato@customer.example.jp'], subject: 'Re: 発注', body: '承知しました' }, ctx);
  assert.equal(sent['sent'], true);
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'mail').length, 1);
});

test('カレンダーと ToDo: 変更・取り消し・完了が一覧に反映される。無い ID は理由を返す', async () => {
  const ctx = makeCtx();
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const events = await ctx.connector.calendar.list({ tenantId: 't', userId: 'u1' }, { from, to });
  const target = events[0]!;
  await run('calendar.update', { eventId: target.id, title: '朝会（変更）' }, ctx);
  let after = await ctx.connector.calendar.list({ tenantId: 't', userId: 'u1' }, { from, to });
  assert.ok(after.some((e) => e.id === target.id && e.title === '朝会（変更）'));
  assert.equal(after.filter((e) => e.id === target.id).length, 1, '変更で予定が二重にならない');
  await run('calendar.cancel', { eventId: target.id }, ctx);
  after = await ctx.connector.calendar.list({ tenantId: 't', userId: 'u1' }, { from, to });
  assert.ok(!after.some((e) => e.id === target.id));
  assert.equal((await run('calendar.cancel', { eventId: 'nothing' }, ctx))['cancelled'], false);

  const tasks = await ctx.connector.tasks.list({ tenantId: 't', userId: 'u1' }, {});
  await run('tasks.complete', { taskId: tasks[0]!.id }, ctx);
  const open = await ctx.connector.tasks.list({ tenantId: 't', userId: 'u1' }, {});
  assert.ok(!open.some((t) => t.id === tasks[0]!.id));
});

test('第 2 弾: ファイルの共有は M2Office が作ったファイルだけ。相手がいなければ共有しない。危険度は external-send', async () => {
  const ctx = makeCtx();
  assert.equal(registry.get('drive.share')!.risk, 'external-send');
  const doc = await run('docs.create', { title: '提案書', body: '本文' }, ctx);
  const shared = await run('drive.share', { fileId: doc['file'].id, emails: ['sato@customer.example.jp'], role: 'commenter' }, ctx);
  assert.equal(shared['shared'], true);
  assert.equal(shared['roleLabel'], 'コメント');
  assert.equal((await run('drive.share', { fileId: 'mock-file-t-1', emails: ['x@y.jp'] }, ctx))['shared'], false, '見本のファイル（M2Office が作っていない）は共有しない');
  assert.equal((await run('drive.share', { fileId: doc['file'].id, emails: [] }, ctx))['shared'], false);
  assert.ok(validateToolArgs(registry.get('drive.share')!.args!, { fileId: 'f', emails: ['a@b.jp'], role: 'anyone' }).some((p) => p.includes('reader')), 'リンクによる一般公開のような役割は受け付けない');
});

test('第 2 弾: 社内の人を探せる', async () => {
  const res = await run('directory.search', { query: '人事' }, makeCtx());
  assert.equal(res['count'], 1);
  assert.equal(res['people'][0].department, '人事部');
});

test('第 2 弾: Meet の文字起こしを取れる（中身はデータの印つき）。見つからなければ 30 日で消えることを伝える', async () => {
  const ctx = makeCtx();
  const t = await run('meet.transcript', { query: '営業定例' }, ctx);
  assert.equal(t['available'], true);
  assert.equal(t['untrusted'], true);
  assert.match(t['text'], /佐藤様への提案/);
  const none = await run('meet.transcript', { query: '存在しない会議' }, ctx);
  assert.equal(none['available'], false);
  assert.match(none['reason'], /30 日/);
});

