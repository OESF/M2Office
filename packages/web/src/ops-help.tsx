/**
 * @file 運営者のヘルプ（仕様書 第23.8.16節、Q-282）。マスター管理画面の左のメニューの「ヘルプ」と、各画面の題名の横の「？」。
 *
 * 中身は運営者マニュアル（`docs/ops-manual/`）をそのまま使い、運営の API（`/v1/ops/help`）から読む。
 * 左に章の一覧と絞り込み、右に本文。本文の中の章へのリンク（`NN-名前.md`）は、その章を開く。
 * 「？」は会社の画面と同じ部品（`HelpTip`）で、押すと短い説明を出し、「詳しく見る」でその画面の章を開く（第6.10.4.4節）。
 * 説明を画面に常に出すことはしない（原則 u11）。マスター管理画面には秘書が無いので、AI に尋ねる口は置かない。
 */

import { useEffect, useState } from 'react';
import { opsApi } from './ops-api.js';
import { HelpTip, Markdown, MdRefContext } from './help.js';

/** 画面の題名に添える説明。`chapter` は運営者マニュアルの章の ID（`03-tenants`）。`npm test` が実在を確かめる。 */
export interface OpsPageHelp {
  chapter: string;
  text: string;
}

/** 運営の画面の題名と、その横の「？」（1 画面に 1 つ）。 */
export function OpsTitle({ title, help }: { title: string; help: OpsPageHelp }) {
  return (
    <h2>
      {title}
      {' '}<HelpTip article={help.chapter}>{help.text}</HelpTip>
    </h2>
  );
}

/** 画面の中の欄の見出しと、その横の「？」（「稼働状況」の「社外の控え」のように、別の章を指す欄に使う）。 */
export function OpsSubTitle({ title, help }: { title: string; help: OpsPageHelp }) {
  return (
    <h3>
      {title}
      {' '}<HelpTip article={help.chapter}>{help.text}</HelpTip>
    </h3>
  );
}

/**
 * 運営者のヘルプ。
 *
 * @param chapter 開く章（「？」から来たとき）。無ければはじめに
 * @param onChapter 開いている章が変わったとき（「？」から別の章を開き直せるように、親が覚える）
 */
export function OpsHelp({ chapter, onChapter }: { chapter: string | null; onChapter: (id: string) => void }) {
  const [list, setList] = useState<{ id: string; title: string }[] | null>(null);
  const [all, setAll] = useState<{ id: string; title: string }[]>([]);
  const [q, setQ] = useState('');
  const [doc, setDoc] = useState<{ id: string; title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(!!chapter);

  useEffect(() => { opsApi.help().then((r) => { setAll(r.chapters); setList(r.chapters); }).catch(() => setError('ヘルプを読み込めませんでした')); }, []);
  const current = chapter ?? all[0]?.id ?? null;
  useEffect(() => {
    if (!current) return;
    setDoc(null);
    opsApi.helpChapter(current).then((r) => { setDoc(r.chapter); setError(null); }).catch(() => setError('章を開けませんでした'));
  }, [current]);

  const search = () => {
    if (!q.trim()) { setList(all); return; }
    opsApi.help(q).then((r) => setList(r.chapters)).catch(() => setError('探せませんでした'));
  };
  const open = (id: string) => { onChapter(id); setReading(true); window.scrollTo?.(0, 0); };
  // 本文の中の章へのリンク（`NN-名前.md`）は、その章を開く
  const follow = (href: string) => open(href.replace(/\.md$/, ''));
  const at = all.findIndex((c) => c.id === current);
  const prev = at > 0 ? all[at - 1] : undefined;
  const next = at >= 0 ? all[at + 1] : undefined;

  return (
    <div className="help-center"><div className={`help-layout${reading ? ' reading' : ''}`}>
      <nav className="help-tree" aria-label="ヘルプの目次">
        <h1>ヘルプ</h1>
        <div className="help-search">
          <input value={q} placeholder="探す" aria-label="ヘルプを探す" onChange={(e) => { setQ(e.target.value); if (!e.target.value.trim()) setList(all); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) search(); }} />
        </div>
        {list && list.length === 0 && <p className="muted small">見つかりませんでした</p>}
        <ul className="help-leaves ops-help-list">
          {(list ?? []).map((c) => (
            <li key={c.id}><button className={`help-leaf${c.id === current ? ' current' : ''}`} onClick={() => open(c.id)}>{c.title}</button></li>
          ))}
        </ul>
      </nav>
      <div className="help-body">
        <button className="link-btn help-toc-link" onClick={() => setReading(false)}>‹ 目次</button>
        {error && <p className="error">{error}</p>}
        {doc && (
          <article className="card article">
            <h1>{doc.title}</h1>
            <MdRefContext.Provider value={follow}><Markdown text={doc.body} /></MdRefContext.Provider>
            {(prev || next) && (
              <div className="help-pager">
                {prev ? <button className="btn ghost small" onClick={() => open(prev.id)}>‹ {prev.title}</button> : <span />}
                {next && <button className="btn ghost small" onClick={() => open(next.id)}>{next.title} ›</button>}
              </div>
            )}
          </article>
        )}
      </div>
    </div></div>
  );
}
