/**
 * @file 会話の中の承認への言葉での直しと取りやめ（仕様書 第47.5節、ADR-0148）。
 *
 * 秘書に頼んだ業務が承認を待っている間に、本人が「やめて」と言えば、その承認を却下する。
 * 「期限は来週にして」のように直しを頼めば、その承認を却下し（直しの言葉を記録に残す）、直しを入れて業務をやり直す。
 * **言葉では承認しない**（Q-369）。承認はボタンを押して行う。社外に出る操作の取り違えを防ぐため。
 *
 * @remarks
 * 本人が判断できる承認（`approver: requester`）だけを扱う。ほかの人が判断する承認には触れない。
 * 直しかどうかは、承認を待っているときだけ、軽い推論で確かめる（関係の無い頼みを直しと取り違えないため）。
 */

import type { LlmProvider } from '../llm/provider.js';
import { parseJsonObject } from '../decisions/format.js';

/** 秘書が言葉で扱える、本人の承認待ち。 */
export interface PendingTalkApproval {
  approvalId: string;
  runId: string;
  agentId: string;
  agentVersion: number;
  agentName: string;
  /** 依頼したときの業務の入力（やり直すときに直しを足す）。 */
  input: Record<string, unknown>;
  /** 承認の画面の 1 行目（何の承認か）。 */
  summary: string;
  /**
   * 1 本の会話の呼び出しの承認か（仕様書 第48.4節）。そうなら、直しは却下の理由として同じ会話に返し（業務をやり直さない）、
   * 取りやめは理由なしの却下で業務を終える
   */
  conversation?: boolean;
  createdAt: string;
}

/** 言葉の直し・取りやめを扱う口（API が承認の判断につなぐ）。 */
export interface ApprovalTalkDeps {
  /** 本人が判断する承認待ち（新しい順）。 */
  pending(tenantId: string, userId: string): Promise<PendingTalkApproval[]>;
  /** 承認を却下する（言葉を理由として残す）。 */
  reject(tenantId: string, userId: string, approvalId: string, comment: string): Promise<void>;
}

/** 言葉で扱う承認待ちの古さの上限（これより前の承認は、会話の続きとはみなさない）。 */
export const APPROVAL_TALK_HOURS = 12;

/** 取りやめの言い方（文の全体）。 */
// @wordlist 安全の側（第49.4節）
export const APPROVAL_STOP = /^(?:やっぱり|やはり|いや[、,]?\s*)?(?:それは|さっきのは|今のは)?(?:やめて|やめよう|やめます|やめておいて|中止して?|取りやめて|取り消して|出さないで|公開しないで|送らないで|載せないで|キャンセルして)(?:ください|下さい)?[。．！!]*$/;

/** 直しの言い方（文のどこかに）。これに当たったときだけ、推論で直しかを確かめる。 */
export const APPROVAL_MODIFY = /(にして|に変えて|に直して|に差し替えて|[をはも](?:直して|変えて|足して|消して|外して|削って|入れて|加えて|付けて|やめて)|にしたい|がいい|のほうが|ではなく|じゃなくて)/;

/**
 * 頼みが、承認を待っているその業務への直しか（推論で確かめる）。
 *
 * @returns 推論が使えない・答えないときは `false`（直しと決めつけない）
 * @remarks 危険度: read（推論に依頼と頼みの言葉を渡すだけ）
 */
export async function isApprovalCorrection(llm: LlmProvider, message: string, pending: PendingTalkApproval): Promise<{ correction: boolean; tokensUsed: number }> {
  const request = typeof pending.input['request'] === 'string' ? pending.input['request'] : '';
  try {
    const res = await llm.complete({
      tier: 'fast', maxOutputTokens: 200,
      messages: [
        {
          role: 'system',
          content: [
            'あなたは、会社の秘書の振り分けの係です。',
            '利用者が業務に頼んだことが、いま承認を待っています。利用者の新しい言葉が、その承認を待っている内容への直し（期限・文・宛先・題名などを変えてほしい）かを判断してください。',
            '別の新しい頼み（ほかの予定・ほかの調べもの）なら false です。',
            '答えは JSON だけで、{"correction":true} か {"correction":false} にしてください。',
          ].join('\n'),
        },
        { role: 'user', content: `承認を待っている業務: ${pending.agentName}\n頼んだこと: ${request.slice(0, 1500)}\n承認の内容: ${pending.summary.slice(0, 300)}\n\n新しい言葉: ${message.slice(0, 800)}` },
      ],
    });
    return { correction: parseJsonObject(res.text)?.['correction'] === true, tokensUsed: res.tokensUsed };
  } catch {
    return { correction: false, tokensUsed: 0 };
  }
}

/** やり直すときの依頼の文（もとの依頼に直しを足す）。 */
export function correctedRequest(input: Record<string, unknown>, message: string): Record<string, unknown> {
  const request = typeof input['request'] === 'string' ? input['request'] : '';
  return { ...input, request: `${request}\n\n直し: ${message}`.trim() };
}
