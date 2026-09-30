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

import type { AgentDefinition, AutomationPolicy } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import { agentHelpMarkdown, buildAgentHelp, type AgentHelpView } from './agent-help.js';
import { extractTerms, matchConcepts, normalizeForSearch, type SearchConcept } from '../knowledge/search.js';

/** 記事の読み手。`all` は全員、`approver` は承認者と管理者、`admin` は管理者だけ。 */
export type HelpAudience = 'all' | 'approver' | 'admin';

export const HELP_CATEGORIES = ['start', 'agents', 'manual', 'faq', 'admin', 'glossary', 'updates', 'contact'] as const;
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
  /** `official` は公式の記事、`agent` は定義から作った業務の記事、`manual` は業務のマニュアルの章。 */
  source: 'official' | 'agent' | 'manual';
  /** 業務の区分（マニュアルの名前。例: `inventory`）。ヘルプの木で、同じ業務の下にまとめる（第6.10.7.3節）。 */
  business?: string;
  /** 木の中の小分け（管理者向けの記事の「はじめに」「設定」「記録」など）。 */
  group?: string;
  /** この内蔵の拡張を使える人だけに出す（マニュアルの章）。 */
  extension?: string;
  /** 木の中の並びの順（記事の `order`。マニュアルの章は 0 がはじめに）。 */
  order?: number;
}

/** ヘルプを出す所。ワークスペースは管理者向けの記事を出さず、管理者ページは管理者向けの記事だけを出す（第6.10.7節）。 */
export type HelpScope = 'workspace' | 'admin';

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
    ...(attrs['business'] ? { business: attrs['business'] } : {}),
    ...(attrs['group'] ? { group: attrs['group'] } : {}),
    ...(/^\d+$/.test(attrs['order'] ?? '') ? { order: Number(attrs['order']) } : {}),
  };
}

/** 業務のマニュアルの `manual.json`（第6.10.7.3節）。 */
export interface ManualMeta {
  /** マニュアルの名前（ヘルプの木の業務の区分の名前）。 */
  title: string;
  /** どの内蔵の拡張のものか。使える人だけに出す。 */
  extension: string;
}

/**
 * 業務のマニュアル（`docs/manual/<id>/`）を、章ごとの記事にする。
 *
 * @param id マニュアルの名前（フォルダーの名前）
 * @param files `README.md` と、番号で始まる章のファイル（`01-….md`）。ほかのファイルは読まない
 * @remarks 章の題は最初の `#` の見出しから取り、本文からは除く。章の順は番号の順（README は 0）。ファイルの読み込みは呼び出し側（API）が行う
 */
export function parseManual(id: string, meta: ManualMeta, files: { name: string; text: string }[]): HelpArticle[] {
  const out: HelpArticle[] = [];
  for (const f of files) {
    const num = /^(\d{2})-.+\.md$/.exec(f.name);
    if (f.name !== 'README.md' && !num) continue;
    const order = num ? Number(num[1]) : 0;
    const lines = f.text.replace(/\r\n/g, '\n').split('\n');
    const at = lines.findIndex((l) => /^#\s+/.test(l));
    const heading = at >= 0 ? lines[at]!.replace(/^#\s+/, '').trim() : '';
    const title = order === 0 ? 'はじめに' : heading || f.name;
    const body = (at >= 0 ? [...lines.slice(0, at), ...lines.slice(at + 1)] : lines).join('\n').trim();
    out.push({
      id: `manual-${id}-${String(order).padStart(2, '0')}`, title, audience: 'all', category: 'manual', related: [], body,
      source: 'manual', business: id, extension: meta.extension, order,
    });
  }
  return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 出す所に合うか（第6.10.7節）。用語と問い合わせはどちらにも出す。 */
function inScope(a: HelpArticle, scope: HelpScope | undefined): boolean {
  if (!scope) return true;
  if (a.category === 'glossary' || a.category === 'contact') return true;
  if (scope === 'admin') return a.category === 'admin' || (a.category === 'updates' && a.audience === 'admin');
  return a.audience !== 'admin';
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

  /**
   * 見られる記事の一覧。
   *
   * @param scope 出す所（省略時はすべて。秘書の答えの材料など）
   */
  list(ctx: HelpContext, scope?: HelpScope): HelpArticle[] {
    const allowed = new Set(audiencesFor(ctx.roles));
    const agentArticles = (ctx.agents ?? this.agents)
      .filter((a) => !ctx.disabledAgents.includes(a.id))
      .map((a): HelpArticle => ({
        id: `agent-${a.id}`, title: a.name, audience: 'all', category: 'agents', related: ['start-agents'],
        body: agentHelpMarkdown(this.agentHelp(a, ctx)), source: 'agent',
      }));
    // マニュアルの章は、その業務を使える人だけに出す（第6.10.7.3節）。使える業務を渡されなければ出さない
    const usable = new Set(ctx.extensions ?? []);
    return [...this.official, ...agentArticles]
      .filter((a) => allowed.has(a.audience) && (!a.extension || usable.has(a.extension)) && inScope(a, scope));
  }

  /** 業務の説明を組み立てる（仕様書 第6.10.5節）。 */
  agentHelp(def: AgentDefinition, ctx: HelpContext): AgentHelpView {
    return buildAgentHelp(def, ctx.registry ?? this.registry);
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
   * @remarks
   * 言葉の取り出しと点数は組織知識の検索と同じもの（第11.7.3節）を使う。題名に当たる言葉を本文より重く数える。
   * **題名に言葉が 1 つも当たらない記事は、2 つ以上の言葉をすべて本文で満たすときだけ返す。**
   * 「有給休暇は何日？」のような社内規程の質問に、本文の例に「有給」とあるだけの記事を返さないため（第6.10.6節）。
   * 最上位の 3 割に満たない記事も返さない。
   */
  search(query: string, ctx: HelpContext, limit = 3, scope?: HelpScope): HelpHit[] {
    const concepts = helpConcepts(query);
    if (concepts.length === 0) return [];
    const terms = concepts.flatMap((c) => c.alternatives);
    const scored = this.list(ctx, scope)
      .map((article) => {
        const m = matchConcepts(concepts, { heading: article.title, path: [], body: article.body });
        const relevant = m.inHeading > 0 || (m.total >= 2 && m.matched === m.total);
        const score = relevant ? m.score * weightOf(article.category) : 0;
        return { article, score: Math.round(score * 100) / 100 };
      })
      .filter((h) => h.score >= 1)
      .sort((a, b) => b.score - a.score);
    const top = scored[0]?.score ?? 0;
    return scored
      .filter((h) => h.score >= top * 0.3)
      .slice(0, limit)
      .map((h) => ({ ...h, excerpt: excerpt(h.article.body, terms, h.article.title) }));
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
  /** その会社で使えるツール（コネクタのツールを含む）。省略時は内蔵のツール。 */
  registry?: ToolRegistry;
  /** 本人が使える内蔵の拡張の ID。マニュアルの章を出す。省略時は出さない（秘書の答えの材料には入れない。第6.10.7.3節）。 */
  extensions?: readonly string[];
}

/**
 * 更新情報の記事の重み。
 *
 * @remarks
 * **更新情報は「いつ何が変わったか」の記録であり、使い方の案内ではない**（仕様書 第6.10.7.1節）。
 * 題名に業務の言葉が入るため（例:「秘書と会話できるようになりました」）、そのままでは
 * 「秘書の使い方を教えて」で使い方の記事に勝ってしまう。下げて、案内のほうを先に出す。
 * 消しはしない。版を重ねるほど数が増えるため、**下げ方は版の数によらず一定**にする。
 */
const UPDATES_WEIGHT = 0.4;

/** 記事の区分ごとの、検索の重み。 */
function weightOf(category: HelpCategory): number {
  return category === 'updates' ? UPDATES_WEIGHT : 1;
}

/** 使い方の質問に多く、検索の手がかりにならない語。 */
const STOP_WORDS = new Set([
  '方法', '使い方', 'やり方', '使い', '教え', '知り', '聞き', '場合', 'm2office',
]);

/** 漢字 1 文字に送り仮名が続く語（「見られ」「止め」「取れ」）。助詞で始まる送り仮名は除く。 */
const KANJI_STEM = /(?<![\p{Script=Han}])\p{Script=Han}(?![はがをにでとのへやもか])[\p{Script=Hiragana}]{1,2}/gu;

/**
 * 問い合わせ文を、ヘルプの記事の検索の言葉にする。
 *
 * @remarks
 * 組織知識と同じ取り出し方（`extractTerms`）に、漢字 1 文字の動詞の語幹（「見られ」など）を足す。
 * 長い言葉に含まれる短い言葉（「定時実行」の「定時」「実行」）は、長い言葉の言い換えとしてまとめ、
 * 同じ言葉を二重に数えないようにする。
 *
 * @example helpConcepts('定時実行を止めたい') // → [{ term: '定時実行', alternatives: ['定時実行', '定時', '実行'] }, { term: '止め', … }]
 */
export function helpConcepts(query: string): SearchConcept[] {
  const q = normalizeForSearch(query);
  const stems = [...q.matchAll(KANJI_STEM)].map((m) => m[0]);
  const raw = [...new Set([...extractTerms(query), ...stems])].filter((t) => !STOP_WORDS.has(t));
  const longs = raw.filter((t) => !raw.some((u) => u !== t && u.includes(t)));
  return longs.map((t) => ({ term: t, alternatives: [t, ...raw.filter((u) => u !== t && t.includes(u))] }));
}

/** 問い合わせ文を検索語に分ける（`helpConcepts` の言葉を平らにしたもの）。 */
export function helpTerms(query: string): string[] {
  return [...new Set(helpConcepts(query).flatMap((c) => c.alternatives))];
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
