/**
 * @file ヘルプの画面部品。ヘルプセンター、記事の表示、画面の「？」、初回の案内、業務の説明。
 *
 * 画面のどこからでも記事を開けるよう、`openHelp()` でヘルプセンターへ移る合図を出す。
 * 合図はワークスペースと管理者ページがそれぞれ受け取る。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

import {
  Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode,
} from 'react';
import { parseInline, parseMarkdown, type MdList } from './markdown.js';
import { api, describeError, type AgentHelpView, type HelpArticleMeta, type HelpScope } from './api.js';
import { AGENT_GROUP_LABELS } from '@m2office/shared';
import { Icon } from './nav.js';
import { allBranches, defaultOpenKeys, loadHelpState, openTo, saveHelpState } from './help-state.js';

/** ヘルプセンターで記事を開く合図の名前。 */
const OPEN_EVENT = 'm2o:open-help';

/**
 * ヘルプセンターで記事を開く。
 *
 * @param articleId 開く記事。省略するとヘルプセンターの最初の画面
 */
export function openHelp(articleId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: articleId ?? null }));
}

/** `openHelp()` の合図を受け取る。 */
export function useOpenHelp(handler: (articleId: string | null) => void): void {
  useEffect(() => {
    const listener = (e: Event) => handler((e as CustomEvent<string | null>).detail);
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
  }, [handler]);
}

/**
 * 開いているポップアップを、外を押したときと Esc で閉じる（仕様書 第6.10.5.1節）。
 *
 * @param open 開いているか
 * @param onClose 閉じるときに呼ぶ
 * @returns 包む要素に付ける `ref`
 */
function useDismiss(open: boolean, onClose: () => void) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // 開いた瞬間の押下で閉じないよう、次の周回から見る
    const timer = setTimeout(() => document.addEventListener('mousedown', away), 0);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, onClose]);
  return box;
}

/**
 * 画面の「？」。押すと短い説明を出し、「詳しく」で記事を開く（仕様書 第6.10.4節）。
 *
 * @param article 記事の ID。`npm test` が実在を確かめる
 */
export function HelpTip({ article, children }: { article: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss(open, useCallback(() => setOpen(false), []));
  return (
    <span className="helptip" ref={box}>
      <button className="helptip-btn" aria-label="説明を見る" aria-expanded={open} onClick={() => setOpen(!open)}>？</button>
      {open && (
        <span className="helptip-pop" role="note">
          {children}
          <button className="link-btn" onClick={() => { setOpen(false); openHelp(article); }}>詳しく見る</button>
        </span>
      )}
    </span>
  );
}

/** 画面の題名に添える説明（仕様書 第6.10.4.4節）。開いている小分けのことを書く。 */
export interface PageHelp {
  /** 開く記事の ID。その小分けを扱う記事。無ければ区分の記事 */
  article: string;
  /** 「？」を押したときに出す短い説明 */
  text: string;
}

/**
 * 画面の題名（`区分 › 小分け`）と、その横の「？」（仕様書 第6.10.4.4節）。
 *
 * @param trail 題名の並び（例: `['知識', '言い換え']`）。空の要素は飛ばす
 * @param help 開いている小分けの説明。記事の無い画面では渡さない（「？」を出さない）
 *
 * @remarks
 * **「？」は 1 画面に 1 つ、ここにだけ置く。** 区分全体の説明をすべての小分けで使い回したり、
 * 囲みの中に見出しの無い「？」を別に置いたりすると、どちらを押せばよいか分からなくなる。
 */
export function PageTitle({ trail, help }: { trail: readonly string[]; help?: PageHelp | null }) {
  return (
    <h1>
      {trail.filter(Boolean).join(' › ')}
      {help && <>{' '}<HelpTip article={help.article}>{help.text}</HelpTip></>}
    </h1>
  );
}

/** 業務の説明のポップアップの幅（仕様書 第6.10.5.1節）。画面が狭ければ縮める。 */
const HELP_POP_WIDTH = 560;

/** ヘルプを開く前の画面へ戻す道（仕様書 第6.10.7.2節）。戻り先が無ければ何も出さない。 */
function BackLink({ back }: { back?: { label: string; go: () => void } }) {
  if (!back) return null;
  return (
    <button className="back-link" onClick={back.go}>
      <Icon name="back" />
      {back.label}へ戻る
    </button>
  );
}

/** 木の 1 つの枝（区分・業務）。`items` は葉（記事）、`nodes` は下の枝。 */
interface TreeNode { key: string; label: string; items: HelpArticleMeta[]; nodes?: TreeNode[]; closed?: boolean; itemsFirst?: boolean }

/** 更新情報の版（`updates-v0-11-0` → [0, 11, 0]）。新しい順に並べるため。 */
const versionOf = (id: string) => (/v(\d+)-(\d+)-(\d+)/.exec(id) ?? []).slice(1).map(Number);
const newestFirst = (a: HelpArticleMeta, b: HelpArticleMeta) => {
  const x = versionOf(a.id); const y = versionOf(b.id);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return a.id.localeCompare(b.id);
};
/** 記事の `order` の順（無いものは後ろ）。 */
const byOrder = (a: HelpArticleMeta, b: HelpArticleMeta) => (a.order ?? 99) - (b.order ?? 99);
/** 管理者ページの木では「（管理者）」を省く（管理者向けの記事だけを出すため）。 */
const shortTitle = (t: string) => t.replace(/（管理者）$/, '');
/** 管理者向けの記事の小分けの順。無い小分けは後ろへ。 */
const ADMIN_GROUPS = ['はじめに', '設定', '記録'];

/**
 * ヘルプの木を組み立てる（仕様書 第6.10.7節）。
 *
 * ワークスペース: はじめに・業務・よくある質問・更新情報。「業務」の下は、ダッシュボードの業務のまとまりと同じ形にする:
 * 公式の業務は分野（メール・予定など）の区分、内蔵の拡張はその区分（要点の記事・付属の業務・マニュアルの章）、
 * ほかの拡張機能は拡張機能の名前の区分。まとまりを持たない業務だけ「業務」の直下に置く。
 * 管理者ページ: 管理者向けの記事を小分け（はじめに・設定・記録）ごとに・管理者向けの更新情報。
 * 用語と問い合わせは木に入れず、木の下の小さな入口にする。
 */
function buildTree(items: HelpArticleMeta[], manuals: { id: string; title: string }[], scope: HelpScope): TreeNode[] {
  const updates: TreeNode = { key: 'updates', label: '更新情報', items: items.filter((i) => i.category === 'updates').sort(newestFirst), closed: true };
  if (scope === 'admin') {
    const admin = items.filter((i) => i.category === 'admin');
    const groups = [...new Set(admin.map((i) => i.group ?? 'そのほか'))]
      .sort((a, b) => (ADMIN_GROUPS.indexOf(a) + 1 || 99) - (ADMIN_GROUPS.indexOf(b) + 1 || 99));
    return [...groups.map((g) => ({ key: `admin:${g}`, label: g, items: admin.filter((i) => (i.group ?? 'そのほか') === g).sort(byOrder) })), updates];
  }
  const agents = items.filter((i) => i.category === 'agents');
  // 公式の業務の分野の区分（メール・予定など）。分野の決まった順（ダッシュボードと同じ）、そのほかの拡張機能は後ろ
  const fieldOrder = Object.values(AGENT_GROUP_LABELS);
  const rank = (g: string) => (fieldOrder.indexOf(g) + 1) || 99;
  const groupNames = [...new Set(agents.filter((i) => !i.business && i.group).map((i) => i.group!))].sort((x, y) => rank(x) - rank(y));
  const groups: TreeNode[] = groupNames.map((g) => ({
    key: `group:${g}`, label: g, items: agents.filter((i) => !i.business && i.group === g), closed: true,
  }));
  // 内蔵の拡張の区分: 要点の記事、付属の業務、マニュアルの章の順
  const businessIds = [...new Set(items.filter((i) => i.business).map((i) => i.business!))];
  const businesses: TreeNode[] = businessIds.map((id) => {
    const own = items.filter((i) => i.business === id);
    const guide = own.filter((i) => i.category !== 'manual' && i.category !== 'agents').sort(byOrder);
    const chapters = own.filter((i) => i.category === 'manual').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const manual = manuals.find((m) => m.id === id);
    return {
      key: `business:${id}`, label: manual?.title ?? guide[0]?.title ?? id,
      items: [...guide, ...own.filter((i) => i.category === 'agents')], closed: true, itemsFirst: true,
      nodes: chapters.length ? [{ key: `manual:${id}`, label: 'マニュアル', items: chapters, closed: true }] : [],
    };
  });
  return [
    { key: 'start', label: 'はじめに', items: items.filter((i) => i.category === 'start' && !i.business).sort(byOrder) },
    { key: 'business', label: '業務', items: agents.filter((i) => !i.business && !i.group), nodes: [...groups, ...businesses] },
    { key: 'faq', label: 'よくある質問', items: items.filter((i) => i.category === 'faq') },
    updates,
  ].filter((n) => n.items.length > 0 || (n.nodes?.length ?? 0) > 0);
}

/**
 * 木の枝。開け閉めはヘルプセンターが持ち、端末に覚える（第6.10.7節）。
 *
 * @param openKeys 開いている枝の鍵
 */
function TreeBranch({ node, current, onOpen, admin, openKeys, onToggle, depth = 0 }: {
  node: TreeNode; current: string | null; onOpen: (id: string) => void; admin: boolean;
  openKeys: ReadonlySet<string>; onToggle: (key: string) => void; depth?: number;
}) {
  const open = openKeys.has(node.key);
  const branches = (node.nodes ?? []).map((c) => (
    <TreeBranch key={c.key} node={c} current={current} onOpen={onOpen} admin={admin} openKeys={openKeys} onToggle={onToggle} depth={depth + 1} />
  ));
  return (
    <li className={`help-branch depth-${depth}`}>
      <button className="help-branch-head" aria-expanded={open} onClick={() => onToggle(node.key)}>
        <Icon name={open ? 'caret-down' : 'caret-right'} />{node.label}
      </button>
      {open && (
        <ul className="help-leaves">
          {!node.itemsFirst && branches}
          {node.items.map((i) => (
            <li key={i.id}>
              <button className={`help-leaf${i.id === current ? ' current' : ''}`} aria-current={i.id === current ? 'page' : undefined} onClick={() => onOpen(i.id)}>
                {/* 業務の区分と同じ名前の記事は、その業務の使い方の要点 */}
                {i.title === node.label ? '使い方の要点' : admin ? shortTitle(i.title) : i.title}
              </button>
            </li>
          ))}
          {node.itemsFirst && branches}
        </ul>
      )}
    </li>
  );
}

/**
 * ヘルプセンター（仕様書 第6.10.7節）。左に区分の木と検索、右に本文。
 *
 * @param initial 最初に開く記事
 * @param scope 出す所。管理者ページは `admin`（管理者向けの記事だけ）、ワークスペースは管理者向けの記事を出さない
 */
export function HelpCenter({ initial, back, onReplayTour, onArticle, scope = 'workspace' }: {
  initial: string | null;
  /**
   * 開いている記事が変わったとき（一覧へ戻ったときは `null`）。画面の URL を合わせるのに使う（仕様書 第6.1.6節）
   */
  onArticle?: (articleId: string | null) => void;
  /**
   * ヘルプを開く直前にいた画面へ戻す道（仕様書 第6.10.7.2節）。
   * **どこへ戻るのかを名前で書く。** 左のメニューから入ったときは渡さない
   */
  back?: { label: string; go: () => void };
  onReplayTour?: () => void;
  scope?: HelpScope;
}) {
  const [items, setItems] = useState<HelpArticleMeta[]>([]);
  const [manuals, setManuals] = useState<{ id: string; title: string }[]>([]);
  // 開いた枝と開いていた記事を端末に覚え、開き直すと前の状態で開く（第6.10.7節）。記事を指定して開いたときはその記事
  const [stored] = useState(() => loadHelpState(scope));
  const restored = useRef(!initial && !!stored.article);
  const [articleId, setArticleId] = useState<string | null>(initial ?? stored.article);
  const [openKeys, setOpenKeys] = useState<string[] | null>(stored.open);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; title: string; excerpt: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.help.list(scope).then((r) => { setItems(r.items); setManuals(r.manuals ?? []); }).catch((e) => setError(describeError(e))); }, [scope]);
  // 指定（URL の記事）が変わったときだけ従う。開いた直後は、指定が無ければ覚えていた記事を残す
  const lastInitial = useRef(initial);
  useEffect(() => {
    if (lastInitial.current === initial) return;
    lastInitial.current = initial;
    setArticleId(initial);
  }, [initial]);
  useEffect(() => { onArticle?.(articleId); }, [articleId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function search() {
    if (!q.trim()) { setResults(null); return; }
    try { setResults((await api.help.search(q, scope)).items); } catch (e) { setError(describeError(e)); }
  }
  const open = (id: string) => { setResults(null); setArticleId(id); };
  const tree = buildTree(items, manuals, scope);
  const openSet = new Set(openKeys ?? defaultOpenKeys(tree));
  const toggle = (key: string) => setOpenKeys((prev) => {
    const base = prev ?? defaultOpenKeys(tree);
    return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
  });
  // 開いている記事を含む枝を開き足す。覚えていた記事が無くなっていたら目次を開く
  useEffect(() => {
    if (items.length === 0) return;
    if (restored.current) {
      restored.current = false;
      if (articleId && !items.some((i) => i.id === articleId)) { setArticleId(null); return; }
    }
    setOpenKeys((prev) => {
      const base = prev ?? defaultOpenKeys(tree);
      const next = openTo(base, tree, articleId);
      return next === base ? prev : next;
    });
  }, [articleId, items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { saveHelpState(scope, { open: openKeys, article: articleId }); }, [scope, openKeys, articleId]);
  const admin = scope === 'admin';
  const glossary = items.find((i) => i.category === 'glossary');
  const contact = items.find((i) => i.category === 'contact');

  return (
    <>
      <BackLink back={back} />
      <div className="help-center"><div className={`help-layout${articleId || results ? ' reading' : ''}`}>
        <nav className="help-tree" aria-label="ヘルプの目次">
          <h1>{admin ? '管理者のヘルプ' : 'ヘルプ'}</h1>
          <div className="help-search">
            <input value={q} placeholder="探す" aria-label="ヘルプを探す" onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void search(); }} />
          </div>
          {error && <p className="error small">{error}</p>}
          <div className="help-tree-tools">
            <button className="help-small-link" onClick={() => setOpenKeys(allBranches(tree).map((n) => n.key))}>すべて開く</button>
            <button className="help-small-link" onClick={() => setOpenKeys([])}>すべて閉じる</button>
          </div>
          <ul className="help-branches">
            {tree.map((n) => <TreeBranch key={n.key} node={n} current={articleId} onOpen={open} admin={admin} openKeys={openSet} onToggle={toggle} />)}
          </ul>
          {!admin && onReplayTour && <button className="help-small-link" onClick={onReplayTour}>はじめの案内をもう一度見る</button>}
          {(glossary || contact) && (
            <div className="help-footer">
              {glossary && <button className="help-small-link" onClick={() => open(glossary.id)}>{glossary.title}</button>}
              {contact && <button className="help-small-link" onClick={() => open(contact.id)}>問い合わせ</button>}
            </div>
          )}
        </nav>
        <div className="help-body">
          {results ? (
            <div className="card">
              <button className="link-btn help-toc-link" onClick={() => setResults(null)}>‹ 目次</button>
              <h3>「{q}」の検索結果</h3>
              {results.length === 0 && <p>見つかりませんでした</p>}
              {results.map((r) => (
                <button key={r.id} className="help-item" onClick={() => open(r.id)}>
                  <strong>{admin ? shortTitle(r.title) : r.title}</strong><span className="sub">{r.excerpt}</span>
                </button>
              ))}
            </div>
          ) : articleId ? (
            <ArticleView id={articleId} items={items} onOpen={open} onBack={() => setArticleId(null)} />
          ) : (
            <Landing tree={tree} onOpen={open} admin={admin} />
          )}
        </div>
      </div></div>
    </>
  );
}

/** 何も開いていないときの本文の側。最初の区分の記事を並べる（説明の文は常には出さない。原則 u11）。 */
function Landing({ tree, onOpen, admin }: { tree: TreeNode[]; onOpen: (id: string) => void; admin: boolean }) {
  const first = tree[0];
  if (!first) return null;
  return (
    <section className="card help-landing">
      {!admin && <p className="lead">秘書に聞くのが早道です</p>}
      <h3>{first.label}</h3>
      {first.items.map((i) => <button key={i.id} className="help-item" onClick={() => onOpen(i.id)}>{admin ? shortTitle(i.title) : i.title}</button>)}
    </section>
  );
}

function ArticleView({ id, items, onOpen, onBack }: {
  id: string; items: HelpArticleMeta[]; onOpen: (id: string) => void; onBack: () => void;
}) {
  const [article, setArticle] = useState<(HelpArticleMeta & { body: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setArticle(null); setError(null);
    api.help.get(id).then(setArticle).catch((e) => setError(describeError(e, '記事を開けませんでした')));
  }, [id]);
  // マニュアルの章なら、前の章と次の章（仕様書 第6.10.7.3節）
  const chapters = article?.category === 'manual'
    ? items.filter((i) => i.category === 'manual' && i.business === article.business).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];
  const at = chapters.findIndex((c) => c.id === id);
  const prev = at > 0 ? chapters[at - 1] : undefined;
  const next = at >= 0 ? chapters[at + 1] : undefined;
  return (
    <>
      <button className="link-btn help-toc-link" onClick={onBack}>‹ 目次</button>
      {error && <p className="error">{error}</p>}
      {article && (
        <article className="card article">
          <h1>{article.title}</h1>
          <Markdown text={article.body} />
          {(prev || next) && (
            <div className="help-pager">
              {prev ? <button className="btn ghost small" onClick={() => onOpen(prev.id)}>‹ {prev.title}</button> : <span />}
              {next && <button className="btn ghost small" onClick={() => onOpen(next.id)}>{next.title} ›</button>}
            </div>
          )}
          <HelpRating key={article.id} articleId={article.id} source="article" />
          {article.related.length > 0 && (
            <div className="related">
              <h3>関連する記事</h3>
              {article.related.map((r) => {
                const meta = items.find((i) => i.id === r);
                return meta ? <button key={r} className="help-item" onClick={() => onOpen(r)}>{meta.title}</button> : null;
              })}
            </div>
          )}
        </article>
      )}
    </>
  );
}

/**
 * ヘルプの記事の本文を表示する。
 *
 * @remarks
 * 見出し（#・##・###）・段落・箇条書き・番号付きの箇条書き・表・コードの囲み・引用・行の中のコード・リンク・太字を扱う（docs/help/README.md）。
 * 行ごとに読むため、見出しのすぐ次の行に箇条書きが続いても崩れない（`parseMarkdown`）。
 * HTML としては解釈せず、React の要素として組み立てる。記事に書かれたタグは文字のまま出る。
 */
export function Markdown({ text, lineBreaks = false }: {
  text: string;
  /** 段落の中の改行を保つ（業務の答え・成果物・送る本文）。ヘルプの記事は保たない。 */
  lineBreaks?: boolean;
}) {
  return (
    <>
      {parseMarkdown(text, { lineBreaks }).map((b, i) => {
        switch (b.kind) {
          case 'h2': return <h2 key={i}>{inline(b.text)}</h2>;
          case 'h3': return <h3 key={i}>{inline(b.text)}</h3>;
          case 'ul':
          case 'ol': return <MdListView key={i} list={b} lineBreaks={lineBreaks} />;
          case 'table': return (
            <div key={i} className="md-table-wrap">
              <table className="table md-table">
                <thead><tr>{b.header.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
          case 'code': return <pre key={i} className="md-pre"><code>{b.text}</code></pre>;
          case 'image': return <img key={i} className="md-img" src={b.src} alt={b.alt} loading="lazy" />;
          // 引用の中も書式として読み、改行を保つ（送る本文を、読める形で見せる。仕様書 第9.3.3節）
          case 'quote': return (
            <blockquote key={i} className="md-quote"><Markdown text={b.lines.join('\n')} lineBreaks /></blockquote>
          );
          default: return <p key={i} className={lineBreaks ? 'md-br' : undefined}>{inline(b.text)}</p>;
        }
      })}
    </>
  );
}

/** 箇条書き。入れ子（1 段）があれば、その項目の中に出す。 */
function MdListView({ list, lineBreaks }: { list: MdList; lineBreaks: boolean }) {
  const items = list.items.map((t, j) => (
    <li key={j} className={lineBreaks ? 'md-br' : undefined}>
      {inline(t)}
      {list.sub?.[j] && <MdListView list={list.sub[j]!} lineBreaks={lineBreaks} />}
    </li>
  ));
  return list.kind === 'ol' ? <ol>{items}</ol> : <ul>{items}</ul>;
}

/** 行の中の書式（コード・リンク・太字）を React の要素にする。HTML としては解釈しない。 */
function inline(s: string): ReactNode {
  return parseInline(s).map((n, i) => {
    switch (n.kind) {
      case 'strong': return <strong key={i}>{n.text}</strong>;
      case 'code': return <code key={i} className="md-code">{n.text}</code>;
      case 'link': return <a key={i} className="link" href={n.href} target="_blank" rel="noreferrer noopener">{n.text}</a>;
      default: return <Fragment key={i}>{n.text}</Fragment>;
    }
  });
}

/**
 * 業務の説明（仕様書 第6.10.5節・第6.10.5.1節）。
 *
 * @remarks
 * **画面には広げない。業務の題名の右の「？」を押したときだけ出す。**
 * 説明は一度読めば済む。毎回、入力欄の上に置くと、繰り返し使う人にとっては
 * 入力欄を下へ押し下げるだけのものになる。
 *
 * @param onExample 実行例を押したときに、入力欄へ入れる値を受け取る
 * @param extension 拡張機能の業務なら、その名前と提供者。説明の最後に出す（入力の画面には出さない）
 */
export function AgentHelpTip({ agentId, onExample, extension }: {
  agentId: string; onExample: (input: Record<string, unknown>) => void;
  extension?: { name: string; publisher: string } | null;
}) {
  const [help, setHelp] = useState<AgentHelpView | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const box = useDismiss(open, close);
  const btn = useRef<HTMLButtonElement>(null);
  /*
    出す位置は**画面に対して**決める（`position: fixed`）。
    キャンバスは縦に送れる領域であり、その中に置くと縁で切られる（実機で確認）。
  */
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(HELP_POP_WIDTH, window.innerWidth - 32);
    // 画面の外へはみ出さないところまで寄せる
    const left = Math.max(16, Math.min(r.left - 10, window.innerWidth - width - 16));
    setAt({ top: r.bottom + 8, left, width });
  }, []);
  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place]);
  // 業務を変えたら、開いたままにしない
  useEffect(() => { setHelp(null); setOpen(false); api.help.agent(agentId).then(setHelp).catch(() => setHelp(null)); }, [agentId]);
  if (!help) return null;
  return (
    <span className="helptip" ref={box}>
      <button
        ref={btn} className="helptip-btn" aria-label="この業務の説明を見る" aria-expanded={open}
        title="この業務の説明" onClick={() => setOpen(!open)}
      >？</button>
      {open && at && (
    <div className="helptip-pop agent-help" role="note" style={{ top: at.top, left: at.left, width: at.width }}>
      <p className="summary">{help.summary}</p>
      {/* 書き手が書いた説明（スキルの HELP.md。仕様書 第12.12.4節）。あれば本文にする */}
      {help.body && <div className="md agent-help-body"><Markdown text={help.body.replace(/^#\s+.*\n+/, '')} lineBreaks /></div>}
      {help.does.length > 0 && (
        <div>
          <h4>この業務がすること</h4>
          <ul>{help.does.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      )}
      {help.flow.length > 0 && (
        <div className="flow-mini">
          <span className="muted small">進み方</span>
          {help.flow.map((f, i) => (
            <span key={i} className="step-wrap">
              {i > 0 && <span className="arrow">›</span>}
              <span className={`chip ${help.approvals.some((a) => a.step === f) ? 'waiting' : 'done'}`}>{f}</span>
            </span>
          ))}
        </div>
      )}
      {help.approvals.length > 0 && (
        <p className="small">承認: {approvalSummary(help.approvals)}</p>
      )}
      {help.examples.length > 0 && (
        <div className="examples">
          <span className="muted small">実行例</span>
          {help.examples.map((e) => (
            // 入れたらすぐ実行に移れるよう、説明は閉じる（仕様書 第6.10.5.1節）
            <button key={e.title} className="btn ghost small" onClick={() => { onExample(e.input); close(); }}>
              {e.title}
            </button>
          ))}
        </div>
      )}
      {(help.notes.length > 0 || help.faq.length > 0) && (
        <button className="link-btn" onClick={() => setShowMore(!showMore)}>
          {showMore ? '注意点とよくある質問を閉じる' : '注意点とよくある質問を見る'}
        </button>
      )}
      {showMore && (
        <>
          {help.notes.length > 0 && <ul className="notes">{help.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {help.faq.map((f) => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}
          <button className="link-btn" onClick={() => { close(); openHelp(`agent-${help.agentId}`); }}>
            ヘルプセンターで開く
          </button>
        </>
      )}
      {extension && <p className="muted small">拡張機能「{extension.name}」・提供: {extension.publisher}</p>}
    </div>
      )}
    </span>
  );
}

/** 初回の案内の段階（仕様書 第6.10.3節）。 */
const TOUR_STEPS = [
  { title: '左に、使える業務が並んでいます', body: '議事録の作成やメールの整理など、代わりに進めてくれる業務です。押すと、何をしてくれるかと入力の画面が出ます。' },
  { title: '下の秘書に、何でも話しかけられます', body: '「今日の予定は？」「会議の議事録をまとめて」のように話しかけてください。困ったときは「〜はどうやるの？」と聞けば、使い方も答えます。' },
  { title: '社外に出るものだけ、承認トレイに届きます', body: 'メールの送信や社外の人への共有など、社外に出るものとお金の確定だけは、人の承認のあとに行います。それ以外は秘書と業務が進めます。' },
];

/**
 * 初回の案内。3 段階で、1 分以内に終わる。いつでも飛ばせる。
 *
 * @param onDone 見終えた・飛ばしたときに呼ぶ
 */
export function Tour({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const step = TOUR_STEPS[i]!;
  const last = i === TOUR_STEPS.length - 1;
  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-label="はじめの案内">
      <div className="tour">
        <span className="muted small">はじめの案内 {i + 1} / {TOUR_STEPS.length}</span>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        <div className="row">
          <button className="btn ghost" onClick={onDone}>飛ばす</button>
          <span className="spacer" />
          {i > 0 && <button className="btn ghost" onClick={() => setI(i - 1)}>戻る</button>}
          <button className="btn" onClick={() => (last ? onDone() : setI(i + 1))}>{last ? 'はじめる' : '次へ'}</button>
        </div>
        <p className="muted small">この案内は、ヘルプからいつでも見直せます。</p>
      </div>
    </div>
  );
}

/**
 * 承認の段階を、判断する人ごとにまとめた 1 文にする。
 *
 * @remarks 同じ人が判断する段階は「「内容の承認」と「共有の承認」は管理者・承認者が判断します」のように 1 つにまとめ、役割を繰り返さない。
 */
function approvalSummary(approvals: AgentHelpView['approvals']): string {
  const byWho = new Map<string, string[]>();
  for (const a of approvals) byWho.set(a.who, [...(byWho.get(a.who) ?? []), `「${a.step}」`]);
  return [...byWho].map(([who, steps]) => `${steps.join('と')}は${who}が判断します`).join('。');
}

/**
 * 「役に立ちましたか」（第6.10.10節）。押すと件数に入り、お礼に変わる。押し直しは件数を置き換える（1 人 1 つ）。
 * 管理者は件数だけを見る（誰が押したかは見ない）。
 */
export function HelpRating({ articleId, source }: { articleId: string; source: 'article' | 'secretary' }) {
  const [done, setDone] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rate = (helpful: boolean) => api.help.rate(articleId, source, helpful).then(() => { setDone(helpful); setError(null); }).catch((e) => setError(describeError(e, '送れませんでした')));
  return (
    <div className="help-rating small">
      {done === null
        ? <>役に立ちましたか？ <button className="link small" onClick={() => void rate(true)}>はい</button> <button className="link small" onClick={() => void rate(false)}>いいえ</button></>
        : <span className="muted">{done ? 'ありがとうございます。' : 'ありがとうございます。記事を見直す材料にします。'}</span>}
      {error && <span className="error"> {error}</span>}
    </div>
  );
}
