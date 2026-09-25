/**
 * @file 会話で記憶を直す（仕様書 第11.5.3節、ADR-0028）。
 *
 * 本人が「それは違う、〇〇だよ」「〇〇のことは忘れて」と言えば、秘書が自分で記憶を直す。
 * 本人に記憶の一覧を開かせて、1 件ずつ直させない。秘書が会社の知識にしたもの（第11.3節）も同じように直す。
 * 管理者が登録した規程や議事録は、会話では書き換えない。
 */

import { randomUUID } from 'node:crypto';
import type { LlmProvider } from '../llm/provider.js';
import type { Repository } from '../repository/types.js';
import { AUTO_PROMOTED_SOURCE, LEARNED_SOURCE } from '../memory/learn.js';
import { promotionTitle } from '../memory/promotion.js';
import { MEMORY_MAX_CHARS, refuseToRemember } from './memory.js';

/**
 * 記憶の訂正らしい言い方。当たったら、推論に記憶と照らし合わせさせる。
 *
 * @remarks 広めに拾う。直すものが無ければ推論が「無し」と返し、ふつうの答えに戻る
 */
export const CORRECTION = /(違う|違います|ちがう|間違(い|って|え)|誤り|訂正|直して|直しといて|直しておいて|忘れて|忘れといて)/;

/** 推論が返す、記憶への操作。 */
export type CorrectionOp =
  | { op: 'update'; target: string; text: string }
  | { op: 'delete'; target: string }
  | { op: 'add'; text: string };

/** 照らし合わせる記憶の上限。 */
const MAX_TARGETS = 60;

/**
 * 記憶と照らし合わせる指示を作る。記憶には `M1`、秘書が会社の知識にしたものには `K1` のように番号を振る。
 */
export function correctionPrompt(message: string, memories: { text: string }[], knowledge: { body: string }[]): string {
  return [
    '本人が、あなた（秘書）の覚えていることを直すように言いました。本人の言葉と、あなたが覚えていることを照らし合わせてください。',
    '',
    `本人の言葉: ${message}`,
    '',
    'あなたが覚えていること:',
    ...(memories.length > 0 ? memories.map((m, i) => `M${i + 1}. ${m.text}`) : ['（無し）']),
    '',
    'あなたが会社の知識にしたこと:',
    ...(knowledge.length > 0 ? knowledge.map((k, i) => `K${i + 1}. ${k.body}`) : ['（無し）']),
    '',
    '行うことを、1 行に 1 つ、次の形だけで書いてください。',
    '- 直す: 「直す M3 → 新しい一文」（K の番号も同じ）',
    '- 消す: 「消す M3」（「忘れて」と言われたもの）',
    '- 新しく覚える: 「覚える → 一文」（直す相手が無いが、本人が正しいことを言ったとき）',
    '直すものが無い（記憶の話ではない）なら「無し」とだけ書いてください。',
    '当たる記憶が 2 つ以上あって決められないときは「不明」とだけ書いてください（推測で直さない）。',
    '一文は短く、事実だけにします。パスワードのような認証情報は書きません。',
  ].join('\n');
}

/**
 * 推論の応答から操作を取り出す。
 *
 * @returns 操作の一覧。「無し」なら空、「不明」なら `null`
 */
export function parseCorrection(text: string): CorrectionOp[] | null {
  if (/^\s*不明\s*$/m.test(text)) return null;
  const ops: CorrectionOp[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[-*・\s]+/, '').trim();
    let m = /^直す\s*([MK]\d+)\s*(?:→|->|:|：)\s*(.+)$/.exec(line);
    if (m) { ops.push({ op: 'update', target: m[1]!, text: m[2]!.trim() }); continue; }
    m = /^消す\s*([MK]\d+)\s*$/.exec(line);
    if (m) { ops.push({ op: 'delete', target: m[1]! }); continue; }
    m = /^覚える\s*(?:→|->|:|：)\s*(.+)$/.exec(line);
    if (m) ops.push({ op: 'add', text: m[1]!.trim() });
  }
  return ops;
}

/** 直した結果。本人への答えに使う。 */
export interface CorrectionResult {
  /** 本人への答え。直すものが無ければ `null`（ふつうの答えに戻す）。 */
  text: string | null;
  /** 行ったこと（根拠として添える）。 */
  changes: { label: string; value: string }[];
}

/**
 * 会話で記憶を直す（仕様書 第11.5.3節）。
 *
 * @returns 直したことと本人への答え。記憶の話でなければ `text: null`
 *
 * @remarks
 * 直せるのは本人の記憶と、秘書が会社の知識にしたもの（出典が {@link AUTO_PROMOTED_SOURCE}）だけ。
 * 秘書が覚えた文を直す・消すと、もとの文は再び覚えない（第11.5.2節）。監査ログに中身は入れない。
 */
export async function correctMemory(
  deps: { repo: Repository; llm: LlmProvider },
  tenantId: string, userId: string, message: string, now = new Date(),
): Promise<CorrectionResult> {
  const { repo, llm } = deps;
  const memories = (await repo.listMemories(tenantId, userId)).slice(0, MAX_TARGETS);
  // 本人の記憶から秘書が会社の知識にしたものだけを候補にする（ほかの人の記憶から来た知識は、ここでは直さない）
  const mine = new Set((await repo.listPromotions(tenantId, { userId }))
    .filter((p) => p.status === 'approved' && p.knowledgeId).map((p) => p.knowledgeId!));
  const knowledge = (await repo.listKnowledge(tenantId))
    .filter((k) => k.kind === 'promoted' && k.source === AUTO_PROMOTED_SOURCE && mine.has(k.id)).slice(0, MAX_TARGETS);

  const res = await llm.complete({
    tier: 'fast',
    maxOutputTokens: 300,
    messages: [
      { role: 'system', content: '日本語で答えます。指定された形式だけを出力します。' },
      { role: 'user', content: correctionPrompt(message, memories, knowledge) },
    ],
  });
  const ops = parseCorrection(res.text);
  if (ops === null) {
    return { text: '直す相手が 2 つ以上あって、どれか決められませんでした。どの話か、もう少し詳しく教えてください。', changes: [] };
  }
  if (ops.length === 0) return { text: null, changes: [] };

  const settings = await repo.getUserSettings(tenantId, userId);
  const at = now.toISOString();
  const changes: { label: string; value: string }[] = [];
  const suppress = async (text: string) => {
    // 秘書が覚えた文を直した・消したときは、同じ文を再び覚えない（第11.5.2節）
    await repo.createMemoryCandidate({
      id: randomUUID(), tenantId, userId, text, status: 'dismissed', sourceDay: at.slice(0, 10), createdAt: at,
    });
  };
  for (const op of ops) {
    if (op.op !== 'delete' && refuseToRemember(op.text.slice(0, MEMORY_MAX_CHARS + 1), { ...settings.memory, learning: true })) continue;
    const target = op.op === 'add' ? null : op.target;
    const memory = target?.startsWith('M') ? memories[Number(target.slice(1)) - 1] : undefined;
    const item = target?.startsWith('K') ? knowledge[Number(target.slice(1)) - 1] : undefined;
    if (op.op === 'add') {
      await repo.createMemory({ id: randomUUID(), tenantId, userId, text: op.text, source: 'secretary', createdAt: at });
      await audit(repo, tenantId, userId, 'memory.create', 'memory');
      changes.push({ label: '覚えたこと', value: op.text });
    } else if (memory && op.op === 'update') {
      await repo.updateMemory(tenantId, userId, memory.id, op.text);
      if (memory.source === LEARNED_SOURCE) await suppress(memory.text);
      await audit(repo, tenantId, userId, 'memory.update', memory.id);
      changes.push({ label: '直したこと', value: `「${memory.text}」→「${op.text}」` });
    } else if (memory && op.op === 'delete') {
      await repo.deleteMemory(tenantId, userId, memory.id);
      if (memory.source === LEARNED_SOURCE) await suppress(memory.text);
      await audit(repo, tenantId, userId, 'memory.delete', memory.id);
      changes.push({ label: '忘れたこと', value: memory.text });
    } else if (item && op.op === 'update') {
      await repo.saveKnowledge({ ...item, title: promotionTitle(op.text), body: op.text, source: `${AUTO_PROMOTED_SOURCE}（会話での訂正）`, updatedAt: at });
      await audit(repo, tenantId, userId, 'knowledge.correct', item.id);
      changes.push({ label: '会社の知識を直したこと', value: `「${item.body}」→「${op.text}」` });
    } else if (item && op.op === 'delete') {
      await repo.deleteKnowledge(tenantId, item.id);
      await audit(repo, tenantId, userId, 'knowledge.correct', item.id);
      changes.push({ label: '会社の知識から外したこと', value: item.body });
    }
  }
  if (changes.length === 0) return { text: null, changes: [] };
  return {
    text: ['承知しました。次のように直しました。', ...changes.map((c) => `- ${c.label}: ${c.value}`)].join('\n'),
    changes,
  };
}

/** 監査ログを残す。中身は入れない（第11.5.1節）。 */
async function audit(repo: Repository, tenantId: string, userId: string, action: string, targetId: string): Promise<void> {
  await repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId,
    action, targetType: action.startsWith('knowledge') ? 'knowledge' : 'memory', targetId,
    detail: { via: 'conversation' }, occurredAt: new Date().toISOString(),
  });
}
