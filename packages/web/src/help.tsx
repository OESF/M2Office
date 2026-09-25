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
import { api, describeError, type AgentHelpView, type HelpArticleMeta } from './api.js';
import { Icon } from './nav.js';

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

const CATEGORY_LABELS: Record<string, string> = {
  start: 'はじめに', agents: '業務', faq: 'よくある質問', admin: '管理者向け',
  glossary: '用語', updates: '更新情報', contact: '問い合わせ',
};
const CATEGORY_ORDER = ['start', 'agents', 'faq', 'admin', 'glossary', 'updates', 'contact'];

/**
 * ヘルプセンター（仕様書 第6.10.7節）。記事の一覧・検索・本文。
 *
 * @param initial 最初に開く記事
 */
export function HelpCenter({ initial, back, onReplayTour }: {
  initial: string | null;
  /**
   * ヘルプを開く直前にいた画面へ戻す道（仕様書 第6.10.7.2節）。
   * **どこへ戻るのかを名前で書く。** 左のメニューから入ったときは渡さない
   */
  back?: { label: string; go: () => void };
  onReplayTour?: () => void;
}) {
  const [items, setItems] = useState<HelpArticleMeta[]>([]);
  const [articleId, setArticleId] = useState<string | null>(initial);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; title: string; excerpt: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.help.list().then((r) => setItems(r.items)).catch((e) => setError(describeError(e))); }, []);
  useEffect(() => { setArticleId(initial); }, [initial]);

  async function search() {
    if (!q.trim()) { setResults(null); return; }
    try { setResults((await api.help.search(q)).items); } catch (e) { setError(describeError(e)); }
  }

  // 記事を見ているときは、まず記事の一覧へ戻す（二段階。第6.10.7.2節）
  if (articleId) {
    return (
      <>
        <BackLink back={back} />
        <ArticleView id={articleId} items={items} onOpen={setArticleId} onBack={() => setArticleId(null)} />
      </>
    );
  }
  return (
    <>
      <BackLink back={back} />
      <h1>ヘルプ</h1>
      <p className="lead">分からないことは、下の秘書に「〜はどうやるの？」と聞くのがいちばん早い方法です。</p>
      {error && <p className="error">{error}</p>}
      <div className="help-search">
        <input value={q} placeholder="例: 承認のしかた、定時実行" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void search(); }} />
        <button className="btn" onClick={() => void search()}>探す</button>
      </div>
      {results && (
        <div className="card">
          <h3>「{q}」の検索結果</h3>
          {results.length === 0 && <p>見つかりませんでした。言い方を変えるか、秘書に聞いてみてください。</p>}
          {results.map((r) => (
            <button key={r.id} className="help-item" onClick={() => setArticleId(r.id)}>
              <strong>{r.title}</strong><span className="sub">{r.excerpt}</span>
            </button>
          ))}
        </div>
      )}
      <div className="help-grid">
        {CATEGORY_ORDER.filter((c) => items.some((i) => i.category === c)).map((c) => (
          <section className="card" key={c}>
            <h3>{CATEGORY_LABELS[c] ?? c}</h3>
            {items.filter((i) => i.category === c).map((i) => (
              <button key={i.id} className="help-item" onClick={() => setArticleId(i.id)}>{i.title}</button>
            ))}
            {c === 'start' && onReplayTour && (
              <button className="help-item" onClick={onReplayTour}>はじめの案内をもう一度見る</button>
            )}
          </section>
        ))}
      </div>
    </>
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
  return (
    <>
      <button className="link-btn" onClick={onBack}>‹ ヘルプの一覧へ</button>
      {error && <p className="error">{error}</p>}
      {article && (
        <article className="card article">
          <h1>{article.title}</h1>
          {article.source === 'agent' && <p className="muted small">この説明は、業務の設定から自動で作っています。</p>}
          <Markdown text={article.body} />
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
 */
export function AgentHelpTip({ agentId, onExample }: {
  agentId: string; onExample: (input: Record<string, unknown>) => void;
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
      <div className="agent-help-cols">
        <div>
          <h4>この業務がすること</h4>
          <ul>{help.does.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
        <div>
          <h4>安心して使えるように</h4>
          <ul>{help.safeguards.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      </div>
      <div className="flow-mini">
        <span className="muted small">進み方</span>
        {help.flow.map((f, i) => (
          <span key={i} className="step-wrap">
            {i > 0 && <span className="arrow">›</span>}
            <span className={`chip ${help.approvals.some((a) => a.step === f) ? 'waiting' : 'done'}`}>{f}</span>
          </span>
        ))}
      </div>
      {help.approvals.length > 0 && (
        <p className="small">承認: {approvalSummary(help.approvals)}</p>
      )}
      {help.examples.length > 0 && (
        <div className="examples">
          <span className="muted small">実行例（押すと入力欄に入ります）</span>
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
    </div>
      )}
    </span>
  );
}

/** 初回の案内の段階（仕様書 第6.10.3節）。 */
const TOUR_STEPS = [
  { title: '左に、使える業務が並んでいます', body: '議事録作成や受信箱整理など、代わりに進めてくれる業務です。押すと、何をしてくれるかと入力の画面が出ます。' },
  { title: '下の秘書に、何でも話しかけられます', body: '「今日の予定は？」「会議の議事録をまとめて」のように話しかけてください。困ったときは「〜はどうやるの？」と聞けば、使い方も答えます。' },
  { title: '確認が必要なものは、承認トレイに届きます', body: 'メールの送信や投稿など、社外や他の人に届く操作は、必ず人の承認のあとに行います。勝手に送られることはありません。' },
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
