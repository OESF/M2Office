/**
 * @file ヘルプの画面部品。ヘルプセンター、記事の表示、画面の「？」、初回の案内、業務の説明。
 *
 * 画面のどこからでも記事を開けるよう、`openHelp()` でヘルプセンターへ移る合図を出す。
 * 合図はワークスペースと管理者ページがそれぞれ受け取る。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api, describeError, type AgentHelpView, type HelpArticleMeta } from './api.js';

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
 * 画面の「？」。押すと短い説明を出し、「詳しく」で記事を開く（仕様書 第6.10.4節）。
 *
 * @param article 記事の ID。`npm test` が実在を確かめる
 */
export function HelpTip({ article, children }: { article: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="helptip">
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
export function HelpCenter({ initial, onReplayTour }: { initial: string | null; onReplayTour?: () => void }) {
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

  if (articleId) {
    return <ArticleView id={articleId} items={items} onOpen={setArticleId} onBack={() => setArticleId(null)} />;
  }
  return (
    <>
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
 * 見出し（##）・段落・箇条書き・番号付きの箇条書き・太字だけを扱う（docs/help/README.md）。
 * HTML としては解釈せず、React の要素として組み立てる。記事に書かれたタグは文字のまま出る。
 */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.length === 0) return null;
        const h = /^(#{2,3})\s+(.*)$/.exec(lines[0]!);
        if (h && lines.length === 1) return h[1] === '##' ? <h2 key={i}>{inline(h[2]!)}</h2> : <h3 key={i}>{inline(h[2]!)}</h3>;
        if (lines.every((l) => /^- /.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>;
        }
        if (lines.every((l) => /^\d+\. /.test(l))) {
          return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\d+\. /, ''))}</li>)}</ol>;
        }
        return <p key={i}>{inline(lines.join(''))}</p>;
      })}
    </>
  );
}

/** 太字（**…**）だけを解釈する。 */
function inline(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{p}</Fragment>);
}

/**
 * 業務の説明（仕様書 第6.10.5節）。業務の入力画面の上に出す。
 *
 * @param onExample 実行例を押したときに、入力欄へ入れる値を受け取る
 */
export function AgentHelpPanel({ agentId, onExample }: {
  agentId: string; onExample: (input: Record<string, unknown>) => void;
}) {
  const [help, setHelp] = useState<AgentHelpView | null>(null);
  const [showMore, setShowMore] = useState(false);
  useEffect(() => { setHelp(null); api.help.agent(agentId).then(setHelp).catch(() => setHelp(null)); }, [agentId]);
  if (!help) return null;
  return (
    <div className="card agent-help">
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
        <p className="small">承認: {help.approvals.map((a) => `「${a.step}」は${a.who}が判断します`).join('。')}</p>
      )}
      {help.examples.length > 0 && (
        <div className="examples">
          <span className="muted small">実行例（押すと入力欄に入ります）</span>
          {help.examples.map((e) => (
            <button key={e.title} className="btn ghost small" onClick={() => onExample(e.input)}>{e.title}</button>
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
          <button className="link-btn" onClick={() => openHelp(`agent-${help.agentId}`)}>ヘルプセンターで開く</button>
        </>
      )}
    </div>
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
