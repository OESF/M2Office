/**
 * @file 作ったスライドと文書の部品（仕様書 第9.4.2節「作ったスライドの扱い」、第9.5.5.2節「文書の作成の扱い」、Q-264・Q-266）。
 *
 * 実行の結果の画面には、URL を並べずに「Google スライドで開く」「PowerPoint でダウンロード」（文書は「Google ドキュメントで開く」
 * 「Word でダウンロード」「PDF でダウンロード」）のボタンと、共有の範囲と、「直してほしいこと」を書いて作り直す欄を出す（`SlideDeckActions`）。
 * 業務の画面の頼む欄の下には、作ったものの一覧を出す（`SlideDeckList`）。
 * 作り直しは、その業務の実行（`deckId` と直す頼み）で行う。説明文は置かない（原則 u11）。
 */

import { useEffect, useState } from 'react';
import { SLIDE_DECK_FORMAT_LABEL, SLIDE_DECK_SHARING_LABEL, type SlideDeckFormat, type SlideDeckKind, type SlideDeckSharing, type SlideDeckSummary } from '@m2office/shared';
import { api, describeError } from './api.js';

/** 業務「スライドの作成」の ID。 */
export const SLIDES_AGENT_ID = 'slides';
/** 業務「文書の作成」の ID。 */
export const DOCUMENT_AGENT_ID = 'document-draft';
/** 業務「表の作成」の ID。 */
export const SHEET_AGENT_ID = 'sheet-builder';

/** 種類ごとの、作り直す業務・開くボタン・一覧の見出し。 */
const KIND: Record<SlideDeckKind, { agent: string; open: string; list: string }> = {
  slides: { agent: SLIDES_AGENT_ID, open: 'Google スライドで開く', list: '作ったスライド' },
  doc: { agent: DOCUMENT_AGENT_ID, open: 'Google ドキュメントで開く', list: '作った文書' },
  sheet: { agent: SHEET_AGENT_ID, open: 'Google スプレッドシートで開く', list: '作った表' },
};

const SHARINGS: SlideDeckSharing[] = ['private', 'company'];

/** 日付（年月日）。 */
const day = (iso: string) => new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });

/**
 * PowerPoint・Word・PDF でダウンロード。新しいタブを開かず、M2Office が Google から受け取って保存する。作っている間は回る印と経過の秒を出す
 * （第9.4.2節「PowerPoint の取り出し」・第9.5.5.2節）。M2Office が受け取れないもの（ほかの人のもの・大きすぎるもの）は Google の書き出しを開く。
 */
function DownloadButton({ deck, format, small }: { deck: SlideDeckSummary; format: SlideDeckFormat; small?: boolean }) {
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (since === null) return undefined;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  async function download() {
    setSince(Date.now());
    setNote(null);
    try {
      const r = await api.downloadSlideDeck(deck.id, format);
      if (r) {
        setNote(r.reason);
        window.open(r.fallback, '_blank', 'noopener');
      }
    } catch (err) {
      setNote(describeError(err, '取り出せませんでした'));
    } finally {
      setSince(null);
    }
  }
  const name = SLIDE_DECK_FORMAT_LABEL[format];
  const label = small ? name : `${name} でダウンロード`;
  return (
    <>
      <button type="button" className={`btn ghost${small ? ' small' : ''}`} disabled={since !== null} onClick={() => void download()}>
        {since !== null
          ? <span className="busy-label"><span className="spin" aria-hidden="true" />{name} を作っています…{Math.floor((Date.now() - since) / 1000)} 秒</span>
          : label}
      </button>
      {note && <span className="muted small">{note}</span>}
    </>
  );
}

/** 開く・取り出しのボタン。見本の接続口で作ったもの（道が無い）は出さない。 */
function OpenButtons({ deck, small }: { deck: SlideDeckSummary; small?: boolean }) {
  if (!deck.url) return null;
  return (
    <>
      <a className={`btn${small ? ' small' : ''}`} href={deck.url} target="_blank" rel="noreferrer">{small ? '開く' : KIND[deck.kind].open}</a>
      {deck.downloads.map((f) => <DownloadButton key={f} deck={deck} format={f} {...(small ? { small } : {})} />)}
    </>
  );
}

/** 共有の範囲の切り替え（作った人だけ）。 */
function SharingSelect({ deck, onChanged }: { deck: SlideDeckSummary; onChanged: (d: SlideDeckSummary) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function change(sharing: SlideDeckSharing) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.shareSlideDeck(deck.id, sharing));
    } catch (err) {
      setError(describeError(err, '共有を切り替えられませんでした'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="slide-deck-sharing">
      <select aria-label="共有" value={deck.sharing} disabled={busy} onChange={(e) => void change(e.target.value as SlideDeckSharing)}>
        {SHARINGS.map((s) => <option key={s} value={s}>{SLIDE_DECK_SHARING_LABEL[s]}</option>)}
      </select>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

/** 「直してほしいこと」と「作り直す」。業務「スライドの作成」を、前のスライドと直す頼みで始める。 */
function ReviseBox({ deck, onOpenRun }: { deck: SlideDeckSummary; onOpenRun: (runId: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function revise() {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.createJob(KIND[deck.kind].agent, { request: text.trim(), deckId: deck.id });
      onOpenRun(runId);
    } catch (err) {
      setError(describeError(err, '作り直しを始められませんでした'));
      setBusy(false);
    }
  }
  return (
    <div className="slide-deck-revise">
      <textarea
        aria-label="直してほしいこと" rows={2} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="直してほしいこと（例: 全体を 5 ページに、3 枚目の数字を最新に）"
      />
      <button className="btn" onClick={() => void revise()} disabled={busy || !text.trim()}>{busy ? '始めています…' : '作り直す'}</button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/**
 * 実行の結果に出す、作ったスライドの操作（開く・PowerPoint・共有・作り直す）。
 *
 * @param onOpenRun 作り直しの実行を開く。無ければ作り直しの欄を出さない（管理者の画面など）
 */
export function SlideDeckActions({ deckId, onOpenRun }: { deckId: string; onOpenRun?: (runId: string) => void }) {
  const [deck, setDeck] = useState<SlideDeckSummary | null>(null);
  useEffect(() => {
    let alive = true;
    // 削除したもの・見られないものは何も出さない
    api.slideDeck(deckId).then((d) => { if (alive) setDeck(d); }).catch(() => undefined);
    return () => { alive = false; };
  }, [deckId]);
  if (!deck) return null;
  return (
    <div className="slide-deck-actions">
      <div className="row-actions">
        <OpenButtons deck={deck} />
        {deck.mine && <SharingSelect deck={deck} onChanged={setDeck} />}
      </div>
      {deck.mine && onOpenRun && <ReviseBox deck={deck} onOpenRun={onOpenRun} />}
    </div>
  );
}

/** 一覧の 1 行。 */
function DeckRow({ deck, onOpenRun, onChanged, onRemoved }: {
  deck: SlideDeckSummary;
  onOpenRun: (runId: string) => void;
  onChanged: (d: SlideDeckSummary) => void;
  onRemoved: (id: string) => void;
}) {
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (!window.confirm(`「${deck.title}」を削除します。ファイルはドライブのごみ箱に移ります（30 日は戻せます）。`)) return;
    try {
      await api.deleteSlideDeck(deck.id);
      onRemoved(deck.id);
    } catch (err) {
      setError(describeError(err, '削除できませんでした'));
    }
  }
  return (
    <li className="slide-deck-row">
      <div className="slide-deck-head">
        <span className="slide-deck-title">{deck.title}</span>
        <span className="muted small">
          {[day(deck.updatedAt), deck.design, deck.mine ? null : deck.ownerName].filter(Boolean).join('・')}
        </span>
      </div>
      <div className="row-actions">
        <OpenButtons deck={deck} small />
        {deck.mine && (
          <>
            <button className="btn ghost small" onClick={() => setRevising(!revising)}>{revising ? '閉じる' : '作り直す'}</button>
            <SharingSelect deck={deck} onChanged={onChanged} />
            <button className="btn small danger" onClick={() => void remove()}>削除</button>
          </>
        )}
      </div>
      {revising && <ReviseBox deck={deck} onOpenRun={onOpenRun} />}
      {error && <p className="error small">{error}</p>}
    </li>
  );
}

/**
 * 作ったスライド・文書の一覧（本人のものと、会社で共有されたもの）。業務の画面の頼む欄の下に置く。
 */
export function SlideDeckList({ kind = 'slides', onOpenRun }: { kind?: SlideDeckKind; onOpenRun: (runId: string) => void }) {
  const [mine, setMine] = useState<SlideDeckSummary[] | null>(null);
  const [shared, setShared] = useState<SlideDeckSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.slideDecks(kind).then((r) => {
      if (!alive) return;
      setMine(r.mine);
      setShared(r.shared);
    }).catch((err) => { if (alive) setError(describeError(err, '一覧を読めませんでした')); });
    return () => { alive = false; };
  }, [kind]);
  if (error) return <p className="error">{error}</p>;
  if (!mine || (mine.length === 0 && shared.length === 0)) return null;
  const replace = (d: SlideDeckSummary) => setMine((list) => (list ?? []).map((x) => (x.id === d.id ? d : x)));
  const removed = (id: string) => setMine((list) => (list ?? []).filter((x) => x.id !== id));
  return (
    <section className="slide-decks">
      {mine.length > 0 && (
        <>
          <h2>{KIND[kind].list}</h2>
          <ul className="slide-deck-list card">
            {mine.map((d) => <DeckRow key={d.id} deck={d} onOpenRun={onOpenRun} onChanged={replace} onRemoved={removed} />)}
          </ul>
        </>
      )}
      {shared.length > 0 && (
        <>
          <h2>会社で共有</h2>
          <ul className="slide-deck-list card">
            {shared.map((d) => <DeckRow key={d.id} deck={d} onOpenRun={onOpenRun} onChanged={() => undefined} onRemoved={() => undefined} />)}
          </ul>
        </>
      )}
    </section>
  );
}
