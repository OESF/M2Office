/**
 * @file 推論を行わないスタブの LLM。鍵が無くても全体の流れを確かめるためのもの。
 *
 * 指示文の語句からツール呼び出しを組み立てて返す。本番では使わない。
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';

/**
 * 鍵を設定せずに全体の流れを確認するためのスタブ実装。
 *
 * 実際の推論は行わない。システムプロンプトに書かれたツール一覧を読み取り、
 * 指示文の語句に応じて妥当なツール呼び出しを組み立てて返す。
 * これにより、鍵が無くても実行エンジンとツール層の経路を通して検証できる。
 *
 * @remarks
 * 本番では使わない。`LLM_PROVIDER=stub` のときだけ選ばれる。
 */
export class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.at(-1)?.content ?? '';
    const tools = extractToolNames(system);
    const calls = chooseTools(tools, user);

    const lines = ['［スタブ応答］実際の推論は行っていません。'];
    for (const call of calls) {
      lines.push('', '```tool', JSON.stringify(call), '```');
    }
    return { text: lines.join('\n'), tokensUsed: Math.ceil(user.length / 4) + 64 };
  }
}

/** システムプロンプトの「使えるツール:」行からツール名を取り出す。 */
function extractToolNames(system: string): string[] {
  const line = system.split('\n').find((l) => l.startsWith('使えるツール:'));
  if (!line) return [];
  return line
    .replace('使えるツール:', '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'なし');
}

type Call = { name: string; args: Record<string, unknown> };

/**
 * 指示文の語句から、呼ぶべきツールを選ぶ。
 *
 * @remarks
 * 指示文は「# 指示」の段だけを見る。前のステップの結果に含まれる語句で
 * 誤ってツールを選ばないためである。該当が無ければ何も呼ばない。
 */
function chooseTools(tools: string[], prompt: string): Call[] {
  const has = (n: string) => tools.includes(n);
  const instruction = section(prompt, '指示');
  const previous = section(prompt, 'これまでの結果');

  // 語句は「〜を収集」「〜を取得」のように目的語つきで見る。
  // 「収集した内容を要約する」のような後段の指示で、同じツールを呼び直さないため

  // 収集: 読み取り系をまとめて呼ぶ（AG-05）
  if (/を収集/.test(instruction)) {
    const collectors: Call[] = [];
    if (has('calendar.list')) collectors.push({ name: 'calendar.list', args: {} });
    if (has('tasks.list')) collectors.push({ name: 'tasks.list', args: {} });
    if (has('gmail.list')) collectors.push({ name: 'gmail.list', args: { limit: 20 } });
    if (has('approvals.pending')) collectors.push({ name: 'approvals.pending', args: {} });
    if (collectors.length > 0) return collectors;
  }
  if (has('notification.send') && /通知/.test(instruction)) {
    return [{
      name: 'notification.send',
      args: { kind: 'brief', title: '今週のブリーフ（スタブ生成）', body: summarizeForBrief(previous) },
    }];
  }
  if (has('calendar.create') && /予定を作成/.test(instruction)) {
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setUTCHours(4, 0, 0, 0); // 日本時間 13 時
    const end = new Date(start.getTime() + 30 * 60_000);
    return [{
      name: 'calendar.create',
      args: {
        title: extractField(prompt, 'title') || '打ち合わせ',
        start: start.toISOString(), end: end.toISOString(),
        attendees: splitList(extractField(prompt, 'attendees')),
      },
    }];
  }
  if (has('calendar.freebusy') && /空き/.test(instruction)) {
    return [{ name: 'calendar.freebusy', args: { emails: splitList(extractField(prompt, 'attendees')) } }];
  }
  if (has('gmail.create_draft') && /下書き/.test(instruction)) {
    const mailId = /"id":\s*"(mock-mail-[^"]+-1)"/.exec(previous)?.[1] ?? null;
    if (!mailId) return [];
    return [{
      name: 'gmail.create_draft',
      args: {
        replyTo: mailId, to: '', subject: 'Re: （スタブ）',
        body: '［スタブ］いつもお世話になっております。内容を確認のうえ、改めてご連絡いたします。',
      },
    }];
  }
  if (has('gmail.list') && /を取得/.test(instruction)) {
    return [{ name: 'gmail.list', args: { limit: 20 } }];
  }
  if (has('chat.post') && /投稿|共有/.test(instruction)) {
    return [{ name: 'chat.post', args: { space: 'general', text: '議事録を共有します。' } }];
  }
  if (has('tasks.create') && /起票|タスク|ToDo/.test(instruction)) {
    return [{ name: 'tasks.create', args: { title: '決定事項の対応', due: null } }];
  }
  if (has('document.create') && /作成|生成|まとめる|保存/.test(instruction)) {
    const isInbox = /分類/.test(instruction);
    return [{
      name: 'document.create',
      args: isInbox
        ? { kind: 'inbox-triage', title: '受信箱の分類（スタブ生成）',
            body: '［スタブ］要返信・要対応・情報共有のみ・不要の一覧をここにまとめます。' }
        : { kind: 'minutes', title: '議事録（スタブ生成）',
            body: '［スタブ］議題・決定事項・保留事項・担当と期限をここにまとめます。' },
    }];
  }
  if (has('meeting.get_transcript') && /取得/.test(instruction)) {
    return [{
      name: 'meeting.get_transcript',
      args: { transcript: extractField(prompt, 'transcript') },
    }];
  }
  if (has('knowledge.search') && /検索|照会|探す|調べ/.test(instruction)) {
    return [{
      name: 'knowledge.search',
      args: { query: extractField(prompt, 'question') || '規程' },
    }];
  }
  return [];
}

/** プロンプトから「# 見出し」の段を取り出す。無ければ空文字。 */
function section(prompt: string, heading: string): string {
  const parts = prompt.split(/^# /m);
  const hit = parts.find((p) => p.startsWith(`${heading}\n`));
  return hit ? hit.slice(heading.length + 1) : '';
}

function splitList(v: string): string[] {
  return v.split(/[,、\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** 前のステップの結果から件数だけを拾い、ブリーフの本文にする。 */
function summarizeForBrief(previous: string): string {
  const count = (tool: string) => {
    const re = new RegExp(`"name":\\s*"${tool.replace('.', '\\.')}"[\\s\\S]*?"count":\\s*(\\d+)`);
    const m = re.exec(previous);
    return m ? `${m[1]} 件` : '取得できませんでした';
  };
  return [
    '［スタブ］今週のまとめです。',
    `- 予定: ${count('calendar.list')}`,
    `- 未完了のタスク: ${count('tasks.list')}`,
    `- 受信箱: ${count('gmail.list')}`,
    `- 承認待ち: ${count('approvals.pending')}`,
  ].join('\n');
}

/** 入力の JSON から指定した項目を拾う。見つからなければ空文字。 */
function extractField(text: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  return m?.[1] ?? '';
}
