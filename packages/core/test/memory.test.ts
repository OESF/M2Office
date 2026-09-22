/**
 * @file 個人記憶の単体テスト。覚えるきっかけと、覚えないものの判定を確かめる。
 *
 * @see 仕様書 第11.5.1節、ADR-0012
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type AuditEvent, type UserSettings } from '@m2office/shared';
import {
  DIRECT_QUERIES, MEMORY_MAX_CHARS, MockWorkspaceConnector, memoryTextOf, refuseToRemember,
  type Repository,
} from '../src/index.js';
import type { Memory } from '../src/repository/types.js';

/** 秘書の層 1 が記憶を扱うのに必要な操作だけを持つ、記憶上の永続化層。 */
class MemoryRepo {
  settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  memories: Memory[] = [];
  audits: AuditEvent[] = [];
  async getUserSettings() { return this.settings; }
  async saveUserSettings(_t: string, _u: string, section: string, value: unknown) {
    (this.settings as unknown as Record<string, unknown>)[section] = value;
  }
  async createMemory(m: Memory) { this.memories.push(m); }
  async listMemories() { return this.memories; }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
}

/** 層 1 の照会を、秘書と同じ順序で選ぶ。 */
function match(message: string) {
  return DIRECT_QUERIES.find(
    (q) => q.patterns.some((p) => p.test(message)) && !q.excludes?.some((p) => p.test(message)),
  );
}

async function ask(repo: MemoryRepo, message: string) {
  const query = match(message);
  assert.ok(query, `層 1 で扱えない: ${message}`);
  return {
    id: query.id,
    ...(await query.answer({
      tenantId: 't', userId: 'u', message,
      repo: repo as unknown as Repository, connector: new MockWorkspaceConnector(),
    })),
  };
}

test('指示から、覚える一文だけを取り出す', () => {
  assert.equal(memoryTextOf('山田さんは経理の担当だと覚えておいて'), '山田さんは経理の担当だ');
  assert.equal(memoryTextOf('見積書の宛名は「御中」で統一、を覚えておいてください'), '見積書の宛名は「御中」で統一');
  assert.equal(memoryTextOf('覚えて: 月次の締めは第 3 営業日'), '月次の締めは第 3 営業日');
  assert.equal(memoryTextOf('覚えておいて'), '');
});

test('覚えないもの: 学習の停止・対象外の言葉・認証情報・長すぎるもの', () => {
  const on = { learning: true, excludes: ['人事評価'] };
  assert.equal(refuseToRemember('山田さんは経理の担当だ', on), null);
  assert.deepEqual(refuseToRemember('何か', { learning: false, excludes: [] }), { reason: 'learning-off' });
  assert.deepEqual(refuseToRemember('人事評価の結果は保留', on), { reason: 'excluded', word: '人事評価' });
  assert.deepEqual(refuseToRemember('社内システムのパスワードは abc123', on), { reason: 'credentials' });
  assert.deepEqual(refuseToRemember('APIキーは xyz', on), { reason: 'credentials' });
  assert.deepEqual(refuseToRemember('あ'.repeat(MEMORY_MAX_CHARS + 1), on), { reason: 'too-long' });
  assert.deepEqual(refuseToRemember('', on), { reason: 'empty' });
});

test('「覚えておいて」と頼まれたら覚え、監査ログに中身を残さない', async () => {
  const repo = new MemoryRepo();
  const res = await ask(repo, '山田さんは経理の担当だと覚えておいて');
  assert.equal(res.id, 'memory-remember');
  assert.deepEqual(repo.memories.map((m) => m.text), ['山田さんは経理の担当だ']);
  assert.equal(repo.memories[0]!.source, 'secretary');
  assert.match(res.text, /覚えました/);

  const audit = repo.audits.find((a) => a.action === 'memory.create');
  assert.ok(audit);
  assert.equal(JSON.stringify(audit.detail).includes('山田'), false, '監査ログに記憶の中身を入れない');
});

test('学習を止めている間は、頼まれても覚えない', async () => {
  const repo = new MemoryRepo();
  repo.settings.memory.learning = false;
  const res = await ask(repo, '来週は出張だと覚えておいて');
  assert.equal(repo.memories.length, 0);
  assert.match(res.text, /覚えない設定/);
});

test('「〜は覚えないで」は、対象外の言葉として残す', async () => {
  const repo = new MemoryRepo();
  const res = await ask(repo, '人事評価のことは覚えないで');
  assert.equal(res.id, 'memory-forget');
  assert.deepEqual(repo.settings.memory.excludes, ['人事評価']);
  assert.equal(repo.memories.length, 0, '覚える側の照会に取られない');

  // 以後、その言葉を含む指示は覚えない
  const after = await ask(repo, '人事評価は 3 月だと覚えておいて');
  assert.equal(repo.memories.length, 0);
  assert.match(after.text, /覚えない言葉/);
});

test('「何を覚えてる？」には、本人の記憶を返す', async () => {
  const repo = new MemoryRepo();
  await ask(repo, '月次の締めは第 3 営業日だと覚えておいて');
  const res = await ask(repo, '私について何を覚えてる？');
  assert.equal(res.id, 'memory-list');
  assert.match(res.text, /1 件/);
  assert.deepEqual(res.evidence.map((e) => e.value), ['月次の締めは第 3 営業日だ']);

  const empty = await ask(new MemoryRepo(), '何を覚えていますか');
  assert.match(empty.text, /何も覚えていません/);
});
