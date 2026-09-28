/**
 * @file ツールの型と、エージェントが呼べるツールの登録簿。
 *
 * @see 仕様書 第9.4節 ツールと承認の対応
 */

import type { RiskLevel } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { WorkspaceConnector } from '../connectors/types.js';
import type { FileStore } from '../files/store.js';
import type { ResearchProvider } from '../research/provider.js';
import type { CardToolContext } from '../cards/tools.js';

/** ツール呼び出しの文脈。テナント境界と実行の同一性を持ち回る。 */
export interface ToolContext {
  tenantId: string;
  /** 実行を依頼した利用者。ツールはこの利用者の権限で動く（不変則 I-9）。 */
  userId: string;
  runId: string;
  /** 実行中のエージェントが属する権限区画。区画外は `null`。 */
  compartment: string | null;
  repo: Repository;
  /** メール・予定・タスク・チャットへの接続口。Google を直接呼ばない。 */
  connector: WorkspaceConnector;
  /** ファイルの中身の置き場。 */
  files: FileStore;
  /** Web での調査の提供者（`web.research` が使う。仕様書 第9.4.2節）。 */
  research?: ResearchProvider;
  /**
   * 呼び出したステップより後に、定義に残っている承認ステップの数。
   *
   * @remarks
   * すべての承認を通ってからでなければ行わない操作（`knowledge.register`。仕様書 第9.5.2節）が使う。
   * 実行エンジンの外から呼ぶ場合は持たない。持たないときは、そうした操作を行わない。
   */
  approvalsAhead?: number;
  /** ツール名から、Google の権限を持つツールか（`Tool.google` の宣言があるか）を返す。 */
  isGoogleTool?: (name: string) => boolean;
  /**
   * 画像から文字を読み取る（OCR。仕様書 第9.4.1節、Q-56）。
   *
   * @remarks
   * 推論を持たない環境（鍵が無い・見本）では持たない。持たなければ OCR を行わず、
   * 「読み取れなかった」と明示する。
   */
  ocr?: (req: { bytes: Uint8Array; mimeType: string }) => Promise<string>;
  /** スキルの補助のファイル（仕様書 第12.12.2節）。実行中の業務がスキルのときだけある。 */
  skillFiles?: { path: string; text: string }[];
  /** 組織知識を探す前に、言い換えを秘書に考えさせる（仕様書 第11.7.7.0節）。無ければ言い換えなしで探す。 */
  expandQuery?: (query: string) => Promise<string[][]>;
  /**
   * 名刺管理（内蔵の拡張。仕様書 第27章）。使えるかどうか（会社の入り切り・利用範囲）は、道具が呼ぶたびに確かめる。
   *
   * @remarks 無ければ名刺の道具は「使えない」と返す
   */
  cards?: CardToolContext;
}

/** 引数 1 つの定義（JSON Schema の一部）。 */
export interface ArgSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** 推論と開発者に見せる説明。 */
  description: string;
  /** 取りうる値（文字列のとき）。 */
  enum?: string[];
  /** 配列の要素の定義。 */
  items?: ArgSpec;
}

/** ツールの引数の定義（JSON Schema の `type: object` の一部。仕様書 第9.4.4節）。 */
export interface ToolArgsSchema {
  properties: Record<string, ArgSpec>;
  required?: string[];
}

/** Google の権限の段階（仕様書 第14.3.1節）。 */
export type GoogleScopeLevel = 'non-sensitive' | 'sensitive' | 'restricted';

/** ツールが必要とする Google の権限（仕様書 第14.3.2節 規定 1）。 */
export interface GoogleScope {
  /** スコープの名前（`https://www.googleapis.com/auth/` の後ろ。例: `gmail.readonly`）。 */
  scope: string;
  /** 段階。申請の前に Google の公式の一覧で確かめる（見込み）。 */
  level: GoogleScopeLevel;
}

/**
 * ツールが求める Google の権限をすべて返す（主な権限と、ほかに要る権限）。
 *
 * @remarks 求める権限の一覧・管理者ページの権限の表・開発者マニュアルは、これを通して数える。
 */
export function toolGoogleScopes(tool: { google?: GoogleScope; googleAlso?: GoogleScope[] }): GoogleScope[] {
  return tool.google ? [tool.google, ...(tool.googleAlso ?? [])] : [];
}

/**
 * ツールの定義。
 *
 * @remarks
 * 危険度は基盤側が持つ。エージェント定義から上書きできない
 * （仕様書 第9.2.2節、第9.4節）。
 */
export interface Tool {
  name: string;
  /** 危険度。承認の要否を決める。 */
  risk: RiskLevel;
  description: string;
  /**
   * 活動の表示名。ダッシュボードで「いま何をしているか」を業務の言葉で示す（仕様書 第6.7.7節）。
   * 例: 「社内の知識を調べています（リサーチ中）」
   */
  activityLabel: string;
  /**
   * すること。ヘルプの「この業務がすること」に使う（仕様書 第6.10.5節）。
   * 送信しない・承認のあとに行う、のような利用者が気にする点を必ず書く。
   */
  helpText: string;
  /** 引数の定義。推論への説明・呼び出しの検証・開発者マニュアルの一覧に使う（仕様書 第9.4.4節）。 */
  args?: ToolArgsSchema;
  /**
   * 会社の接続（MCP）の道具なら、その接続の名前と相手の道具の名前（仕様書 第12.11節）。
   *
   * @remarks 承認の画面で「Slack へ送ります（slack_send_message）」のように出すのに使う。内蔵の道具は持たない
   */
  connection?: { id: string; name: string; tool: string; labels?: Record<string, string> };
  /** 必要な Google の権限。Google を使わないツールは持たない（仕様書 第14.3.2節）。 */
  google?: GoogleScope;
  /**
   * 主な権限（`google`）のほかに要る Google の権限（例: `chat.post` がスペースを名前で探すための一覧の権限）。
   * 求める権限の一覧には、主な権限と同じく入る。{@link toolGoogleScopes} で両方を引く。
   */
  googleAlso?: GoogleScope[];
  /**
   * 承認の前の確かめ（仕様書 第9.3.3節、ADR-0024）。承認の前の組み立てで、操作を記録する前に呼ぶ。
   *
   * @remarks
   * **読む操作だけを行う。** 書き込みも送信もしない。持たないツールは、確かめずに記録する。
   * 例外は投げない（確かめられなかったときは `unchecked` を返す）。
   */
  prepare?(args: Record<string, unknown>, ctx: ToolContext): Promise<PreparedCall>;
  /**
   * 承認の前の組み立てで、同じ鍵の操作が後から記録されたら、前のものを置き換える（推論が言い直した）。
   *
   * @remarks 1 つの段で 1 度しか行わない操作に付ける（同じスペースへの投稿など）。持たない道具は、引数が違えば別の操作として記録する
   */
  planKey?(args: Record<string, unknown>): string;
  invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/**
 * 承認の前の確かめの結果（ADR-0024）。
 *
 * - `ready`: 行える。`args` で記録し、承認のあとはそのまま行う。`shown` は承認の画面に出す、確かめた名前
 * - `problem`: 行えない。記録せず、承認の画面に理由を出す
 * - `unchecked`: 確かめられなかった（Google に届かないなど）。元の引数で記録し、承認の画面に添える
 */
export type PreparedCall =
  | {
    kind: 'ready'; args: Record<string, unknown>; shown?: string;
    /**
     * 送り先が社内だけと確かめられたか（仕様書 第9.4.0節、ADR-0028）。`internal` なら、送る道具でも承認の段を自動で通してよい。
     * 返さなければ、送る道具（`external-send`）は社外とみなす
     */
    audience?: 'internal' | 'external';
  }
  | { kind: 'problem'; reason: string }
  | { kind: 'unchecked'; reason: string };

/**
 * 利用できるツールの登録簿。
 *
 * @remarks
 * エージェント定義の `tools` に列挙されたものだけが呼び出せる（最小権限）。
 * 登録簿に無いツール名は、定義が要求していても呼び出さない。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 登録済みのツールの名前。 */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * この登録簿に、ツールを足した新しい登録簿を作る。元の登録簿は変えない。
   *
   * @remarks
   * 拡張機能のコネクタが提供するツールを、会社ごとに足すために使う（仕様書 第12.11節）。
   * 同じ名前のツールがすでにあれば、足さずに元のものを残す。内蔵のツールを上書きさせないため。
   */
  extend(tools: Iterable<Tool>): ToolRegistry {
    const next = new ToolRegistry();
    for (const t of this.tools.values()) next.register(t);
    for (const t of tools) if (!next.get(t.name)) next.register(t);
    return next;
  }

  /** 定義が許可したツールのうち、登録済みのものだけを返す。 */
  allowed(names: string[]): Tool[] {
    return names.map((n) => this.tools.get(n)).filter((t): t is Tool => !!t);
  }
}

/**
 * 引数を定義に照らして確かめる。
 *
 * @returns 見つかった問題。空なら呼んでよい
 *
 * @remarks
 * 定義に無い引数は拒否しない（ツールの側で無視するか、`notification.send` のように理由を返す）。
 * 数値は、数字だけの文字列も受け付ける（推論が文字列で返すことがあるため）。
 */
export function validateToolArgs(schema: ToolArgsSchema, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    const v = args[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) problems.push(`${key} がありません`);
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (!matches(spec, v)) problems.push(`${key} は ${typeName(spec)} で渡してください`);
    else if (spec.enum && !spec.enum.includes(String(v))) problems.push(`${key} は ${spec.enum.join('・')} のいずれかです`);
  }
  return problems;
}

function matches(spec: ArgSpec, v: unknown): boolean {
  switch (spec.type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim());
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v) && (!spec.items || v.every((x) => matches(spec.items!, x)));
    case 'object': return typeof v === 'object' && !Array.isArray(v);
  }
}

function typeName(spec: ArgSpec): string {
  const names = { string: '文字列', number: '数値', boolean: 'true か false', array: '配列', object: 'オブジェクト' } as const;
  return spec.type === 'array' && spec.items ? `${names[spec.items.type]}の配列` : names[spec.type];
}
