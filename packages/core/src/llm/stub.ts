/**
 * @file 推論を行わないスタブの LLM。鍵が無くても全体の流れを確かめるためのもの。
 *
 * 指示文の語句からツール呼び出しを組み立てて返す。本番では使わない。
 */

import type { EvalCase } from '@m2office/shared';
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

  /**
   * @param evalsFor 業務エージェントの評価のケース（見本の応答を含む）を引く。
   *   拡張機能の業務エージェントを鍵なしで動かすために使う（仕様書 第12.9.4節）
   */
  constructor(private readonly evalsFor?: (agentId: string) => EvalCase[] | undefined) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const replay = this.replay(req);
    if (replay) return replay;

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

  /**
   * 見本の応答を再生する。見本を持たない業務エージェントなら `null`（従来の推測に任せる）。
   *
   * @remarks
   * 見本を持つ業務エージェントでは、入力が一致しないときも推測でツールを呼ばない。
   * 拡張機能の業務の中身をスタブは知らないため、それらしい誤った成果物を作らないようにする。
   */
  private replay(req: LlmRequest): LlmResponse | null {
    const ctx = req.context;
    const cases = ctx ? (ctx.evals ?? this.evalsFor?.(ctx.agentId) ?? []).filter((c) => c.stub) : [];
    if (!ctx || cases.length === 0) return null;
    const hit = cases.find((c) => stableJson(c.input) === stableJson(ctx.input));
    const tokensUsed = Math.ceil(JSON.stringify(ctx.input).length / 4) + 32;
    if (!hit) {
      return {
        text: `［スタブ応答］この入力に対する見本の応答がありません（評価のケース: ${cases.map((c) => c.name).join('、')}）。`,
        tokensUsed,
      };
    }
    const calls = (hit.stub?.[ctx.stepId] ?? []).map((c) => ({
      ...c, args: fillPlaceholders(c.args, ctx.stepResults ?? {}) as Record<string, unknown>,
    }));
    const lines = [`［スタブ応答］見本の応答を再生しています（評価のケース「${hit.name}」）。`];
    for (const call of calls) lines.push('', '```tool', JSON.stringify(call), '```');
    return { text: lines.join('\n'), tokensUsed };
  }
}

/**
 * 見本の応答の引数にある `{{ステップ ID}}` を、そのステップのツールの結果に置き換える（仕様書 第12.11.4節）。
 *
 * @remarks 結果が無いステップを指していれば「（取得できませんでした）」に置き換える。推測で埋めない。
 */
function fillPlaceholders(v: unknown, results: Record<string, string>): unknown {
  if (typeof v === 'string') {
    return v.replace(/\{\{\s*([a-z0-9][a-z0-9-]*)\s*\}\}/g, (_, id: string) => results[id] ?? '（取得できませんでした）');
  }
  if (Array.isArray(v)) return v.map((x) => fillPlaceholders(x, results));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillPlaceholders(x, results)]));
  }
  return v;
}

/** キーの順序によらず同じ文字列になる JSON。入力の一致を比べるために使う。 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
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
    const calls: Call[] = [{ name: 'chat.post', args: { space: 'general', text: '議事録を共有します。' } }];
    // 共有とあわせて知識へ登録する（AG-02。仕様書 第9.5.2節）。成果物の ID は作成の手順の結果から拾う
    const artifactId = /"artifactId":\s*"([^"]+)"/.exec(previous)?.[1];
    if (has('knowledge.register') && /知識/.test(instruction) && artifactId) {
      calls.push({ name: 'knowledge.register', args: { artifactId } });
    }
    return calls;
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
        : { kind: 'minutes', title: `${extractField(prompt, 'title') || '会議'}の議事録（スタブ生成）`,
            body: minutesStub(previous) },
    }];
  }
  if (/取得/.test(instruction)) {
    // 記録の取り方は、ファイル → 貼り付け → Meet の順（仕様書 第9.5.2節）
    const fileId = extractField(prompt, 'fileId');
    if (has('file.read_text') && fileId) return [{ name: 'file.read_text', args: { fileId } }];
    const transcript = extractField(prompt, 'transcript');
    if (has('meeting.get_transcript')) return [{ name: 'meeting.get_transcript', args: { transcript } }];
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

/**
 * 議事録の見本。取得の手順で得た記録をそのまま「記録」の節に入れる。
 *
 * @remarks 推論をしないため、決定事項を取り出したふりはしない。記録が無ければそう書く
 */
function minutesStub(previous: string): string {
  // 推論の応答文（同じ "text" の名前を持つ）ではなく、記録を取ったツールの結果から拾う。
  // 記録は、渡されたファイル（file.read_text）か Meet（meeting.get_transcript）から来る（仕様書 第9.5.2節）
  const from = (tool: string) =>
    new RegExp(`"name":\\s*"${tool}"[\\s\\S]*?"result":\\s*\\{[\\s\\S]*?"text":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(previous)?.[1];
  const text = from('file\\.read_text') ?? from('meeting\\.get_transcript');
  const record = text ? (JSON.parse(`"${text}"`) as string) : '（記録を取得できませんでした）';
  return [
    '## 決定事項',
    '［スタブ］推論を行っていないため、取り出していません。',
    '',
    '## 記録',
    record,
  ].join('\n');
}

/** 入力の JSON から指定した項目を拾う。見つからなければ空文字。 */
function extractField(text: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  return m?.[1] ?? '';
}
