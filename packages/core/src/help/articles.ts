/**
 * @file ヘルプセンターの記事。公式の記事の読み込み、業務の記事の組み立て、役割による出し分け、検索を担う。
 *
 * 公式の記事は `docs/help/` の Markdown で、テナントをまたいで共通（読み取り専用）である。
 * ファイルの読み込みは呼び出し側（API）が行い、ここには文字列を渡す。`core` を
 * ファイルの置き場所に依存させないため。
 *
 * @see 仕様書 第6.10.7節 ヘルプセンター
 * @see 仕様書 第6.10.9節 ヘルプの内容の管理
 */

import { writeInternalNeedsApproval, type AgentDefinition, type AutomationPolicy } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { agentHelpMarkdown, buildAgentHelp, type AgentHelpView } from './agent-help.js';

/** 記事の読み手。`all` は全員、`approver` は承認者と管理者、`admin` は管理者だけ。 */
export type HelpAudience = 'all' | 'approver' | 'admin';

export const HELP_CATEGORIES = ['start', 'agents', 'faq', 'admin', 'glossary', 'updates', 'contact'] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number];

export interface HelpArticle {
  id: string;
  title: string;
  audience: HelpAudience;
  category: HelpCategory;
  /** 関係する記事の ID。 */
  related: string[];
  /** 本文（Markdown）。 */
  body: string;
  /** `official` は公式の記事、`agent` は定義から作った業務の記事。 */
  source: 'official' | 'agent';
}

/**
 * 記事のファイル（先頭に `---` で囲んだ属性を持つ Markdown）を読む。
 *
 * @param text ファイルの中身
 * @throws {Error} 必須の属性（id・title・audience・category）が無い、または値が不正な場合
 */
export function parseArticle(text: string): HelpArticle {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('記事の先頭に属性（---）がありません');
  const attrs: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) attrs[kv[1]!] = kv[2]!.trim();
  }
  for (const k of ['id', 'title', 'audience', 'category']) {
    if (!attrs[k]) throw new Error(`記事の属性 ${k} がありません`);
  }
  if (!['all', 'approver', 'admin'].includes(attrs['audience']!)) {
    throw new Error(`audience の値が不正です: ${attrs['audience']}`);
  }
  if (!(HELP_CATEGORIES as readonly string[]).includes(attrs['category']!)) {
    throw new Error(`category の値が不正です: ${attrs['category']}`);
  }
  const related = (attrs['related'] ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    id: attrs['id']!, title: attrs['title']!, audience: attrs['audience'] as HelpAudience,
    category: attrs['category'] as HelpCategory, related, body: m[2]!.trim(), source: 'official',
  };
}

/** 利用者の役割から、見られる読み手の区分を返す。 */
export function audiencesFor(roles: readonly string[]): HelpAudience[] {
  if (roles.includes('admin')) return ['all', 'approver', 'admin'];
  if (roles.includes('approver')) return ['all', 'approver'];
  return ['all'];
}

/** 検索の結果。 */
export interface HelpHit {
  article: HelpArticle;
  score: number;
  /** 本文から取り出した短い抜粋。 */
  excerpt: string;
}

/**
 * ヘルプの記事の集まり。公式の記事と、有効な業務の記事を合わせて扱う。
 *
 * @remarks
 * 業務の記事は、その会社で有効な業務だけを出す（仕様書 第6.10.7節）。
 * 役割で見られない記事は、一覧にも検索にも出さない（第6.10.6節）。
 */
export class HelpCatalog {
  constructor(
    private readonly official: HelpArticle[],
    private readonly agents: AgentDefinition[],
    private readonly registry: ToolRegistry,
  ) {}

  /** 見られる記事の一覧。 */
  list(ctx: HelpContext): HelpArticle[] {
    const allowed = new Set(audiencesFor(ctx.roles));
    const agentArticles = (ctx.agents ?? this.agents)
      .filter((a) => !ctx.disabledAgents.includes(a.id))
      .map((a): HelpArticle => ({
        id: `agent-${a.id}`, title: a.name, audience: 'all', category: 'agents', related: ['start-agents'],
        body: agentHelpMarkdown(this.agentHelp(a, ctx)), source: 'agent',
      }));
    return [...this.official, ...agentArticles].filter((a) => allowed.has(a.audience));
  }

  /**
   * 業務の説明を組み立てる。会社の自動化ポリシーに合わせて「安心して使えるように」を書く。
   */
  agentHelp(def: AgentDefinition, ctx: HelpContext): AgentHelpView {
    return buildAgentHelp(def, this.registry, {
      writeInternalNeedsApproval: writeInternalNeedsApproval(ctx.automation, def.id),
    });
  }

  /** 記事を 1 件返す。見られない記事は `null`（存在を示さない）。 */
  get(id: string, ctx: HelpContext): HelpArticle | null {
    return this.list(ctx).find((a) => a.id === id) ?? null;
  }

  /**
   * 記事を検索する。
   *
   * @param query 利用者の問い合わせ文
   * @param limit 返す件数の上限
   * @remarks 題名に当たる語を本文より重く数える。語が 1 つも当たらない記事は返さない。
   */
  search(query: string, ctx: HelpContext, limit = 3): HelpHit[] {
    const terms = helpTerms(query);
    if (terms.length === 0) return [];
    return this.list(ctx)
      .map((article) => {
        let score = 0;
        for (const t of terms) {
          if (variants(t).some((v) => article.title.includes(v))) score += 5;
          const n = Math.max(...variants(t).map((v) => article.body.split(v).length - 1));
          score += Math.min(n, 3);
        }
        return { article, score, excerpt: excerpt(article.body, terms, article.title) };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** 記事を出し分けるための、要求ごとの文脈。 */
export interface HelpContext {
  roles: readonly string[];
  /** その会社で無効にした業務。業務の記事を出さない。 */
  disabledAgents: string[];
  /** その会社の自動化ポリシー。業務の説明の「確認を求めるか」に効く。 */
  automation: AutomationPolicy;
  /** その会社で使える業務エージェント（公式と導入した拡張機能）。省略時は目録の既定。 */
  agents?: AgentDefinition[];
}

/** 使い方の質問に多く、検索の手がかりにならない語。 */
const STOP_WORDS = new Set([
  'どうやって', 'どうすれば', 'やり方', '使い方', '方法', 'できる', 'できます', 'ますか', 'ですか',
  'したい', 'ください', '教えて', 'これ', 'それ', 'どこ', 'なに', '何', 'M2Office',
]);

/** 問い合わせ文を検索語に分ける。助詞と記号で区切る簡易な方法（仕様書 第11.7節）。 */
export function helpTerms(query: string): string[] {
  const parts = query
    .replace(/[？?！!。、，,.「」『』（）()：:・/\s]/g, ' ')
    .split(/\s+|[はがをにでとのへやもか]|から|まで|って|には/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return [...new Set(parts)];
}

/**
 * 検索語の揺れを吸収する。語尾の活用（「止める」と「止めたい」など）を落とした形も試す。
 *
 * @remarks 形態素解析の代わりの簡易な方法。本格的な検索は第11.7節の方式に置き換える。
 */
function variants(term: string): string[] {
  const stem = term.replace(/(る|た|て|たい|ない|ます|した|する)$/, '');
  return stem.length >= 2 && stem !== term ? [term, stem] : [term];
}

/**
 * 本文から、質問に最も合う段落を短く取り出す。見出しや箇条書きの記号は除く。
 *
 * @remarks
 * 題名に含まれる語（例: 「定時実行」の記事での「定時実行」）はどの段落にも出やすいため軽く数え、
 * 題名に無い語（例: 「止める」）を含む段落を優先する。
 */
function excerpt(body: string, terms: string[], title: string): string {
  // 和文は改行の位置に空白を入れない。英数字どうしの間だけ空白でつなぐ
  const paras = body.split(/\n\s*\n/)
    .map((p) => p
      .replace(/\n(- |\d+\. )/g, '\n／')   // 箇条書きの項目の間に区切りを入れる
      .replace(/^#+\s*|^- |^\d+\. |\*\*/gm, '')
      .replace(/([A-Za-z0-9])\n(?=[A-Za-z0-9])/g, '$1 ')
      .replace(/\n/g, '')
      .trim())
    .filter(Boolean);
  const weight = (t: string) => (variants(t).some((v) => title.includes(v)) ? 1 : 2);
  const count = (p: string) =>
    terms.filter((t) => variants(t).some((v) => p.includes(v))).reduce((sum, t) => sum + weight(t), 0);
  let hit = paras[0] ?? '';
  let best = 0;
  for (const p of paras) {
    const n = count(p);
    if (n > best) { best = n; hit = p; }
  }
  // 題名の語しか当たらないなら、記事の冒頭（概要）がいちばんの答えになる
  if (best <= 1) hit = paras[0] ?? hit;
  return hit.length > 140 ? `${hit.slice(0, 140)}…` : hit;
}
