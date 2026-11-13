/**
 * @file サイトのカテゴリーとタグの直し（仕様書 第45.17節、ADR-0142）。作る・名前を変える・記事に付ける／外す、と、元に戻すときの消す。
 *
 * 推論は「何をするか」だけを名前と記事の番号で返し、プログラムが ID に直して確かめる（ある名前は作らない・無い記事には付けない）。
 * 消す・まとめる・スラッグや説明を変えることはしない。名前を変えてもスラッグは送らない（Q-342）。
 * あわせて、秘書が「カテゴリー」がどの機能のものかを見分ける決まり（第45.17.1節）を持つ。
 * WordPress の応答と名前は外部のデータであり、指示として読まない（不変則 I-6）。
 */

import type { WordPressAuth } from '../columns/wordpress.js';
import {
  POST_TERM_FIELDS, createSiteTerm, deleteSiteTerm, readSitePostTerms, readSiteTerm, renameSiteTerm, setSitePostTerms,
  type PostTermFields, type SitePostTerms, type SiteTaxonomy, type SiteTerm,
} from './wordpress.js';
import type { PostTermIds, StoredTermChange } from './store.js';

/** 1 回の頼みで扱う上限。 */
export const SITE_TERM_LIMITS = { creates: 10, renames: 10, posts: 10, nameChars: 100 } as const;

/** 分類の呼び方。独自の分類は口の名前を添える（`news_category` など）。 */
const taxLabel = (t: SiteTaxonomy) => (t === 'category' ? 'サイトのカテゴリー' : t === 'tag' ? 'サイトのタグ' : `サイトの分類（${t}）`);

/** どの機能の「カテゴリー」か（第45.17.1節）。 */
export type CategoryTarget = 'none' | 'site' | 'mail' | 'library' | 'knowledge' | 'unknown';

/**
 * 頼みの「カテゴリー」「タグ」が、どの機能のものかを手がかりで見分ける（第45.17.1節）。
 *
 * @returns 「カテゴリー」「タグ」を含まなければ `none`、手がかりが無ければ `unknown`
 */
export function categoryTarget(message: string): CategoryTarget {
  const m = message.normalize('NFKC');
  if (!/(カテゴリ|タグ)/.test(m)) return 'none';
  if (/(サイト|ブログ|ホームページ|HP|WordPress|ワードプレス|wordpress|記事|投稿)/i.test(m)) return 'site';
  if (/(メール|プロジェクト)/.test(m)) return 'mail';
  if (/(資料|ナレッジ)/.test(m)) return 'library';
  if (/(規程|知識)/.test(m)) return 'knowledge';
  return 'unknown';
}

/** 聞き返しへの答えが、サイトとメールのどちらを指すか（「サイトの」「メールのほう」）。 */
export function categoryAnswer(message: string): 'site' | 'mail' | null {
  const m = message.normalize('NFKC');
  const site = /(サイト|ブログ|ホームページ|HP|WordPress|ワードプレス|記事)/i.test(m);
  const mail = /メール/.test(m);
  if (site === mail) return null;
  return site ? 'site' : 'mail';
}

/** 推論が返す、サイトのカテゴリーとタグの直しの案。 */
export interface TermPlanInput {
  create: { taxonomy: SiteTaxonomy; name: string; parent: string | null }[];
  rename: { taxonomy: SiteTaxonomy; id: string; name: string }[];
  assign: { post: string; add: { taxonomy: SiteTaxonomy; name: string }[]; remove: { taxonomy: SiteTaxonomy; name: string }[] }[];
}

const tax = (v: unknown): 'category' | 'tag' => (v === 'tag' ? 'tag' : 'category');
const str = (v: unknown, max = SITE_TERM_LIMITS.nameChars) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const idOf = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? String(v) : '');

/** 推論の答えを、決めた形だけ取り出す。 */
export function readTermPlan(v: Record<string, unknown> | null): TermPlanInput {
  const arr = (x: unknown) => (Array.isArray(x) ? x as Record<string, unknown>[] : []);
  return {
    create: arr(v?.['create']).map((c) => ({ taxonomy: tax(c['taxonomy']), name: str(c['name']), parent: str(c['parent']) || null })).filter((c) => c.name),
    rename: arr(v?.['rename']).map((c) => ({ taxonomy: tax(c['taxonomy']), id: idOf(c['id']), name: str(c['name']) })).filter((c) => c.id && c.name),
    assign: arr(v?.['assign']).map((c) => ({
      post: idOf(c['post']),
      add: arr(c['add']).map((x) => ({ taxonomy: tax(x['taxonomy']), name: str(x['name']) })).filter((x) => x.name),
      remove: arr(c['remove']).map((x) => ({ taxonomy: tax(x['taxonomy']), name: str(x['name']) })).filter((x) => x.name),
    })).filter((c) => c.post && (c.add.length || c.remove.length)),
  };
}

const same = (a: string, b: string) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
const similar = (a: string, b: string) => {
  const x = a.normalize('NFKC').toLowerCase();
  const y = b.normalize('NFKC').toLowerCase();
  return x !== y && x.length >= 1 && y.length >= 1 && (x.includes(y) || y.includes(x));
};

/**
 * 推論の案を、ID に直して確かめた直しにする（第45.17.2節）。
 *
 * @returns 直しと、作らなかったもの・似た名前などの添え書き
 */
export function buildTermChanges(
  plan: TermPlanInput, terms: SiteTerm[], posts: SitePostTerms[], fields: PostTermFields = POST_TERM_FIELDS,
): { changes: StoredTermChange[]; notes: string[] } {
  // 推論は「カテゴリー」「タグ」で答える。記事の種類の分類（独自の分類を含む）に置き換える（第45.20.3節）
  const real = (t: SiteTaxonomy): SiteTaxonomy | null => (t === 'tag' ? fields.tag?.taxonomy ?? null : fields.category?.taxonomy ?? null);
  plan = {
    create: plan.create.flatMap((c) => { const t = real(c.taxonomy); return t ? [{ ...c, taxonomy: t }] : []; }),
    rename: plan.rename.flatMap((c) => { const t = real(c.taxonomy); return t ? [{ ...c, taxonomy: t }] : []; }),
    assign: plan.assign.map((a) => ({
      ...a,
      add: a.add.flatMap((x) => { const t = real(x.taxonomy); return t ? [{ ...x, taxonomy: t }] : []; }),
      remove: a.remove.flatMap((x) => { const t = real(x.taxonomy); return t ? [{ ...x, taxonomy: t }] : []; }),
    })),
  };
  const isCat = (t: SiteTaxonomy) => t === fields.category?.taxonomy;
  const changes: StoredTermChange[] = [];
  const notes: string[] = [];
  const of = (t: SiteTaxonomy) => terms.filter((x) => x.taxonomy === t);
  const created: { taxonomy: SiteTaxonomy; name: string }[] = [];
  for (const c of plan.create.slice(0, SITE_TERM_LIMITS.creates)) {
    if (of(c.taxonomy).some((t) => same(t.name, c.name)) || created.some((x) => x.taxonomy === c.taxonomy && same(x.name, c.name))) {
      notes.push(`${taxLabel(c.taxonomy)}「${c.name}」はもうあるので、作りません`);
      continue;
    }
    const like = of(c.taxonomy).filter((t) => similar(t.name, c.name)).map((t) => `「${t.name}」`);
    if (like.length) notes.push(`${taxLabel(c.taxonomy)}「${c.name}」に似た ${like.slice(0, 3).join('')} があります`);
    let parentId: string | null = null;
    let parentName: string | null = null;
    if (isCat(c.taxonomy) && c.parent) {
      const p = of(c.taxonomy).find((t) => t.id === c.parent || same(t.name, c.parent!));
      if (p) { parentId = p.id; parentName = p.name; } else if (created.some((x) => x.taxonomy === c.taxonomy && same(x.name, c.parent!))) parentName = c.parent;
      else notes.push(`親にする「${c.parent}」が見つからないので、「${c.name}」は親なしで作ります`);
    }
    created.push({ taxonomy: c.taxonomy, name: c.name });
    changes.push({ op: 'create', taxonomy: c.taxonomy, name: c.name, parentId, parentName, createdId: null, result: 'pending', reason: '' });
  }
  for (const r of plan.rename.slice(0, SITE_TERM_LIMITS.renames)) {
    const t = of(r.taxonomy).find((x) => x.id === r.id);
    if (!t) { notes.push(`名前を変える${taxLabel(r.taxonomy)}が見つかりません`); continue; }
    if (same(t.name, r.name)) continue;
    if (of(r.taxonomy).some((x) => x.id !== r.id && same(x.name, r.name))) { notes.push(`${taxLabel(r.taxonomy)}「${r.name}」はもうあるので、「${t.name}」の名前は変えません`); continue; }
    changes.push({ op: 'rename', taxonomy: r.taxonomy, termId: t.id, before: t.name, after: r.name, result: 'pending', reason: '' });
  }
  for (const a of plan.assign.slice(0, SITE_TERM_LIMITS.posts)) {
    const post = posts.find((p) => p.id === a.post);
    if (!post) { notes.push('付ける記事が見つかりません'); continue; }
    const add: { taxonomy: SiteTaxonomy; id: string | null; name: string }[] = [];
    for (const x of a.add) {
      const t = of(x.taxonomy).find((y) => same(y.name, x.name));
      if (t && (isCat(x.taxonomy) ? post.categories : post.tags).includes(t.id)) continue;
      if (t) add.push({ taxonomy: x.taxonomy, id: t.id, name: t.name });
      else if (created.some((y) => y.taxonomy === x.taxonomy && same(y.name, x.name))) add.push({ taxonomy: x.taxonomy, id: null, name: x.name });
      else notes.push(`${taxLabel(x.taxonomy)}「${x.name}」が無いので、「${post.title}」に付けません（作るなら、作ると頼んでください）`);
    }
    const remove: { taxonomy: SiteTaxonomy; id: string; name: string }[] = [];
    for (const x of a.remove) {
      const t = of(x.taxonomy).find((y) => same(y.name, x.name));
      if (t && (isCat(x.taxonomy) ? post.categories : post.tags).includes(t.id)) remove.push({ taxonomy: x.taxonomy, id: t.id, name: t.name });
    }
    if (!add.length && !remove.length) continue;
    changes.push({
      op: 'assign', postId: post.id, postTitle: post.title, postLink: post.link, beforeModified: post.modifiedGmt, ...(fields.kind !== 'post' ? { fields } : {}),
      before: { categories: post.categories, tags: post.tags }, add, remove, exact: null, after: null, result: 'pending', reason: '',
    });
  }
  return { changes, notes };
}

/** 直し 1 つを、人が読む 1 行にする（承認の画面・記録）。 */
export function termLine(c: StoredTermChange, terms: SiteTerm[] = []): string {
  if (c.op === 'create') return `${taxLabel(c.taxonomy)}「${c.name}」を作る${c.parentName ? `（親: 「${c.parentName}」）` : ''}`;
  if (c.op === 'rename') return `${taxLabel(c.taxonomy)}の名前を「${c.before}」から「${c.after}」に変える（URL は変えない）`;
  if (c.op === 'delete') return `${taxLabel(c.taxonomy)}「${c.name}」を消す（作ったものを元に戻す）`;
  const name = (taxonomy: SiteTaxonomy, id: string) => terms.find((t) => t.taxonomy === taxonomy && t.id === id)?.name ?? id;
  if (c.exact) {
    const f = c.fields ?? POST_TERM_FIELDS;
    const list = [...c.exact.categories.map((id) => name(f.category?.taxonomy ?? 'category', id)), ...c.exact.tags.map((id) => `#${name(f.tag?.taxonomy ?? 'tag', id)}`)];
    return `記事「${c.postTitle}」のサイトのカテゴリーとタグを元に戻す（${list.join('・') || 'なし'}）`;
  }
  const parts = [
    ...c.add.map((x) => `${taxLabel(x.taxonomy)}「${x.name}」を付ける`),
    ...c.remove.map((x) => `${taxLabel(x.taxonomy)}「${x.name}」を外す`),
  ];
  const catTax = (c.fields ?? POST_TERM_FIELDS).category?.taxonomy ?? 'category';
  const left = c.before.categories.filter((id) => !c.remove.some((x) => x.taxonomy === catTax && x.id === id));
  const noCategory = catTax === 'category' && left.length === 0 && !c.add.some((x) => x.taxonomy === catTax);
  return `記事「${c.postTitle}」に、${parts.join('・')}${noCategory ? '（カテゴリーが無くなるので、WordPress が「未分類」に入れます）' : ''}`;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
const sameTerms = (a: PostTermIds, b: PostTermIds) => sameIds(a.categories, b.categories) && sameIds(a.tags, b.tags);

/**
 * 承認された直しを、順に WordPress に入れる（作る → 名前を変える → 付ける・外す → 消す）。作ったものの ID は、後の付けるに使う。
 *
 * @returns 結果を書き込んだ直し
 */
export async function applyTermChanges(wp: WordPressAuth, changes: StoredTermChange[]): Promise<StoredTermChange[]> {
  const out: StoredTermChange[] = [];
  const createdIds = new Map<string, string>();
  const keyOf = (taxonomy: SiteTaxonomy, name: string) => `${taxonomy}\u0000${name.normalize('NFKC').toLowerCase()}`;
  const order = (c: StoredTermChange) => ({ create: 0, rename: 1, assign: 2, delete: 3 })[c.op];
  const indexed = changes.map((c, i) => ({ c, i })).sort((a, b) => order(a.c) - order(b.c) || a.i - b.i);
  const results = new Array<StoredTermChange>(changes.length);
  for (const { c, i } of indexed) results[i] = await applyOne(wp, c, createdIds, keyOf);
  for (const r of results) out.push(r);
  return out;
}

async function applyOne(
  wp: WordPressAuth, c: StoredTermChange, createdIds: Map<string, string>, keyOf: (t: SiteTaxonomy, n: string) => string,
): Promise<StoredTermChange> {
  if (c.op === 'create') {
    const parent = c.parentId ?? (c.parentName ? createdIds.get(keyOf('category', c.parentName)) ?? null : null);
    const r = await createSiteTerm(wp, c.taxonomy, c.name, parent);
    if ('error' in r) return { ...c, result: 'failed', reason: r.error };
    createdIds.set(keyOf(c.taxonomy, c.name), r.id);
    return { ...c, parentId: parent, createdId: r.id, result: 'applied', reason: '' };
  }
  if (c.op === 'rename') {
    const now = await readSiteTerm(wp, c.taxonomy, c.termId);
    if (!now) return { ...c, result: 'failed', reason: 'WordPress に見つかりません（消されたかもしれません）' };
    if (now.name !== c.before) return { ...c, result: 'conflict', reason: '直し案の後に、WordPress で名前が変えられていました' };
    const err = await renameSiteTerm(wp, c.taxonomy, c.termId, c.after);
    return err ? { ...c, result: 'failed', reason: err } : { ...c, result: 'applied', reason: '' };
  }
  if (c.op === 'delete') {
    const now = await readSiteTerm(wp, c.taxonomy, c.termId);
    if (!now) return { ...c, result: 'applied', reason: 'もう WordPress にありません' };
    if (now.count > 0) return { ...c, result: 'conflict', reason: `記事が ${now.count} 件付いているので、消しませんでした` };
    const err = await deleteSiteTerm(wp, c.taxonomy, c.termId);
    return err ? { ...c, result: 'failed', reason: err } : { ...c, result: 'applied', reason: '' };
  }
  const f = c.fields ?? POST_TERM_FIELDS;
  const now = await readSitePostTerms(wp, c.postId, f);
  if ('error' in now) return { ...c, result: 'failed', reason: now.error };
  // 直し案の後に、人が WordPress でこの記事のカテゴリーとタグを変えていれば、上書きしない
  if (!sameTerms({ categories: now.categories, tags: now.tags }, c.before)) {
    return { ...c, result: 'conflict', reason: '直し案を作った後に、WordPress でこの記事のカテゴリーかタグが変えられていました' };
  }
  let target: PostTermIds;
  if (c.exact) target = c.exact;
  else {
    const resolve = (x: { taxonomy: SiteTaxonomy; id: string | null; name: string }) => x.id ?? createdIds.get(keyOf(x.taxonomy, x.name)) ?? null;
    const addIds = c.add.map((x) => ({ taxonomy: x.taxonomy, id: resolve(x) }));
    if (addIds.some((x) => !x.id)) return { ...c, result: 'failed', reason: '付けるカテゴリーかタグを作れなかったので、付けませんでした' };
    const pick = (t: SiteTaxonomy, base: string[]) => [...new Set([...base.filter((id) => !c.remove.some((x) => x.taxonomy === t && x.id === id)), ...addIds.filter((x) => x.taxonomy === t).map((x) => x.id!)])];
    target = { categories: pick(f.category?.taxonomy ?? 'category', c.before.categories), tags: pick(f.tag?.taxonomy ?? 'tag', c.before.tags) };
  }
  const r = await setSitePostTerms(wp, c.postId, target, f);
  if ('error' in r) return { ...c, result: 'failed', reason: r.error };
  const after = await readSitePostTerms(wp, c.postId, f);
  return { ...c, after: 'error' in after ? target : { categories: after.categories, tags: after.tags }, result: 'applied', reason: '' };
}

/**
 * 入れた直しを元に戻す直しにする（第45.17.3節）。作ったものは消す（記事が付いていれば、入れるときに消さずに伝える）、
 * 名前は前の名前に、付けた・外したものは前のとおりに。入れた後に人が変えていれば戻さない。
 *
 * @returns 戻す直しと、戻せないものの理由
 */
export async function revertTermChanges(wp: WordPressAuth, changes: StoredTermChange[]): Promise<{ changes: StoredTermChange[]; blocked: string[] }> {
  const out: StoredTermChange[] = [];
  const blocked: string[] = [];
  for (const c of changes.filter((x) => x.result === 'applied')) {
    if (c.op === 'create' && c.createdId) {
      out.push({ op: 'delete', taxonomy: c.taxonomy, termId: c.createdId, name: c.name, result: 'pending', reason: '' });
    } else if (c.op === 'rename') {
      const now = await readSiteTerm(wp, c.taxonomy, c.termId);
      if (!now || now.name !== c.after) { blocked.push(`${taxLabel(c.taxonomy)}「${c.after}」（入れた後に WordPress で変えられています）`); continue; }
      out.push({ op: 'rename', taxonomy: c.taxonomy, termId: c.termId, before: c.after, after: c.before, result: 'pending', reason: '' });
    } else if (c.op === 'assign' && c.after) {
      const now = await readSitePostTerms(wp, c.postId, c.fields ?? POST_TERM_FIELDS);
      if ('error' in now || !sameTerms({ categories: now.categories, tags: now.tags }, c.after)) {
        blocked.push(`記事「${c.postTitle}」（入れた後に WordPress で変えられています）`);
        continue;
      }
      out.push({
        op: 'assign', postId: c.postId, postTitle: c.postTitle, postLink: c.postLink, beforeModified: now.modifiedGmt,
        before: c.after, add: [], remove: [], exact: c.before, after: null, result: 'pending', reason: '', ...(c.fields ? { fields: c.fields } : {}),
      });
    }
  }
  return { changes: out, blocked };
}

/** 90 日を過ぎた直しの、名前と記事の題名を消す（記録だけを残す）。 */
export function purgedTerm(c: StoredTermChange): StoredTermChange {
  if (c.op === 'assign') return { ...c, postTitle: '', add: c.add.map((x) => ({ ...x, name: '' })), remove: c.remove.map((x) => ({ ...x, name: '' })) };
  if (c.op === 'rename') return { ...c, before: '', after: '' };
  return { ...c, name: '' };
}
