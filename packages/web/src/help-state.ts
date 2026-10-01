/**
 * @file ヘルプの目次の木の開き方と、開いていた記事を端末に覚える（仕様書 第6.10.7節。第 0.215.0 版）。
 *
 * ヘルプを開き直したとき、ほかの作業から戻ったときに、前と同じ区分を開き、同じ記事を出すために使う。
 * 覚えるのはこのブラウザだけで、サーバーには送らない。ワークスペースと管理者ページで別々に覚える。
 * ブラウザが覚えられない（非公開の窓など）ときは、何も覚えずに既定の形で開く。
 */

/** 木の枝の、開き方を決めるのに要るところだけ。 */
export interface HelpBranch {
  key: string;
  /** はじめは閉じておく枝。 */
  closed?: boolean;
  items: { id: string }[];
  nodes?: HelpBranch[];
}

/** 端末に覚える中身。 */
export interface HelpViewState {
  /** 開いている枝の鍵。`null` なら、まだ一度も開け閉めしていない（既定の形）。 */
  open: string[] | null;
  /** 開いていた記事。目次へ戻ったら `null`。 */
  article: string | null;
}

/** 覚える場所の名前。中身の形を変えたら版を上げる。 */
const keyOf = (scope: string) => `m2o.help.v1.${scope}`;

/** 端末に覚えた状態を読む。読めなければ既定の形。 */
export function loadHelpState(scope: string): HelpViewState {
  try {
    const raw = window.localStorage.getItem(keyOf(scope));
    if (!raw) return { open: null, article: null };
    const v = JSON.parse(raw) as Partial<HelpViewState>;
    return {
      open: Array.isArray(v.open) ? v.open.filter((k): k is string => typeof k === 'string') : null,
      article: typeof v.article === 'string' ? v.article : null,
    };
  } catch {
    return { open: null, article: null };
  }
}

/** 端末に覚える。覚えられなくても画面は止めない。 */
export function saveHelpState(scope: string, state: HelpViewState): void {
  try {
    window.localStorage.setItem(keyOf(scope), JSON.stringify(state));
  } catch {
    // 非公開の窓などで覚えられないときは、覚えずに続ける
  }
}

/** 木のすべての枝。 */
export function allBranches(tree: HelpBranch[]): HelpBranch[] {
  return tree.flatMap((n) => [n, ...allBranches(n.nodes ?? [])]);
}

/** 既定の形で開く枝（はじめは閉じておく枝を除く）。 */
export function defaultOpenKeys(tree: HelpBranch[]): string[] {
  return allBranches(tree).filter((n) => !n.closed).map((n) => n.key);
}

/** 記事を含む枝の鍵（上から順）。含まなければ空。 */
export function branchesHolding(tree: HelpBranch[], articleId: string): string[] {
  for (const n of tree) {
    if (n.items.some((i) => i.id === articleId)) return [n.key];
    const below = branchesHolding(n.nodes ?? [], articleId);
    if (below.length) return [n.key, ...below];
  }
  return [];
}

/**
 * 開いている枝に、記事を含む枝を足す（開いている記事が木の中で見えるように）。
 *
 * @returns 足すものが無ければ、渡した配列をそのまま返す（覚え直しを起こさない）
 */
export function openTo(open: string[], tree: HelpBranch[], articleId: string | null): string[] {
  if (!articleId) return open;
  const need = branchesHolding(tree, articleId).filter((k) => !open.includes(k));
  return need.length ? [...open, ...need] : open;
}
