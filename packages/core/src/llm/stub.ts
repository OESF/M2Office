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
    const call = chooseTool(tools, user);

    const lines = ['［スタブ応答］実際の推論は行っていません。'];
    if (call) {
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

/** 指示文の語句から、呼ぶべきツールを 1 つ選ぶ。 */
function chooseTool(
  tools: string[],
  instruction: string,
): { name: string; args: Record<string, unknown> } | null {
  const has = (n: string) => tools.includes(n);

  // 動詞を手がかりに選ぶ。順序は「より限定的な語」から見る
  if (has('chat.post') && /投稿|共有/.test(instruction)) {
    return { name: 'chat.post', args: { space: 'general', text: '議事録を共有します。' } };
  }
  if (has('tasks.create') && /起票|タスク|ToDo/.test(instruction)) {
    return { name: 'tasks.create', args: { title: '決定事項の対応', due: null } };
  }
  if (has('document.create') && /作成|生成|まとめる/.test(instruction)) {
    return {
      name: 'document.create',
      args: {
        kind: 'minutes',
        title: '議事録（スタブ生成）',
        body: '［スタブ］議題・決定事項・保留事項・担当と期限をここにまとめます。',
      },
    };
  }
  if (has('meeting.get_transcript') && /取得/.test(instruction)) {
    return {
      name: 'meeting.get_transcript',
      args: { transcript: extractField(instruction, 'transcript') },
    };
  }
  if (has('knowledge.search') && /検索|照会|探す|調べ/.test(instruction)) {
    return {
      name: 'knowledge.search',
      args: { query: extractField(instruction, 'question') || '規程' },
    };
  }
  return tools[0] ? { name: tools[0], args: {} } : null;
}

/** 入力の JSON から指定した項目を拾う。見つからなければ空文字。 */
function extractField(text: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  return m?.[1] ?? '';
}
