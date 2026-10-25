/**
 * @file 社内ナレッジ Q&A の画面（仕様書 第9.5.4節「これまでの質問と答え」、Q-270）。
 *
 * 聞くとほかの画面へ移らず、質問の欄の下に答えを出す。その下に本人のこれまでの質問を新しい順に並べ、押すとその場で答えを開く。
 * ほかの画面へ行って戻っても一覧は残る（実行の記録を読むので、別に写しを持たない）。見えるのは本人の質問だけ。
 */

import { useCallback, useEffect, useState } from 'react';
import { api, describeError, type RunDetail } from './api.js';
import { AskBox, RunView } from './components.js';

/** 一覧の 1 件。 */
interface Asked {
  runId: string;
  question: string;
  at: string;
}

/** 一度に読む件数。 */
const PAGE = 20;
/** 動いている間に読み直す間隔。 */
const POLL_MS = 1500;
const DONE = ['completed', 'failed', 'cancelled'];

/** 日時（月日と時刻）。 */
const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 1 件の答え（終わるまで読み直す）。 */
function Answer({ runId, viewerId }: { runId: string; viewerId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.run(runId).then(setDetail).catch((e) => setError(describeError(e, '答えを読めませんでした'))), [runId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!detail || DONE.includes(detail.run.status)) return undefined;
    const t = window.setTimeout(() => void load(), POLL_MS);
    return () => window.clearTimeout(t);
  }, [detail, load]);
  if (error) return <p className="error small">{error}</p>;
  if (!detail) return <p className="muted small">読み込み中…</p>;
  return <RunView detail={detail} viewerId={viewerId} onCancelled={() => void load()} />;
}

/**
 * 社内ナレッジ Q&A の画面（質問の欄・いま聞いた答え・これまでの質問と答え）。
 */
export function KnowledgeQa({ agentId, viewerId, fill, placeholder }: {
  agentId: string; viewerId: string; fill?: Record<string, string> | null; placeholder?: string | undefined;
}) {
  const [items, setItems] = useState<Asked[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async (before?: string) => {
    try {
      const r = await api.jobsOf(agentId, { limit: PAGE, ...(before ? { before } : {}) });
      const got = r.items.map((x) => ({
        runId: x.run.id, question: typeof x.job?.input?.['question'] === 'string' ? x.job.input['question'] : '（質問の文がありません）', at: x.run.startedAt,
      }));
      setItems((cur) => (before ? [...(cur ?? []), ...got] : got));
      setMore(got.length === PAGE);
    } catch (e) {
      setError(describeError(e, 'これまでの質問を読めませんでした'));
    }
  }, [agentId]);
  useEffect(() => { void read(); }, [read]);
  const toggle = (id: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  /** 聞いた（いま聞いたものは一覧の先頭に足し、開いておく）。 */
  const asked = (runId: string, question: string) => {
    setItems((cur) => [{ runId, question, at: new Date().toISOString() }, ...(cur ?? []).filter((x) => x.runId !== runId)]);
    setOpen((cur) => new Set([runId, ...cur]));
  };
  const again = async (question: string) => {
    try {
      const { runId } = await api.createJob(agentId, { question });
      asked(runId, question);
    } catch (e) {
      setError(describeError(e, '聞き直せませんでした'));
    }
  };

  return (
    <>
      <AskBox agentId={agentId} fill={fill ?? null} {...(placeholder ? { placeholder } : {})}
        onSubmitted={(runId, question) => asked(runId, question ?? '')} />
      {error && <p className="error">{error}</p>}
      {items && items.length > 0 && (
        <ul className="qa-list">
          {items.map((x) => (
            <li key={x.runId} className={`qa-item${open.has(x.runId) ? ' is-open' : ''}`}>
              <div className="qa-head">
                <button type="button" className="qa-question" aria-expanded={open.has(x.runId)} onClick={() => toggle(x.runId)}>
                  <span>{x.question}</span>
                  <span className="muted small">{when(x.at)}</span>
                </button>
                <button type="button" className="btn ghost small" onClick={() => void again(x.question)}>もう一度聞く</button>
              </div>
              {open.has(x.runId) && <div className="qa-answer"><Answer runId={x.runId} viewerId={viewerId} /></div>}
            </li>
          ))}
        </ul>
      )}
      {more && <button type="button" className="btn ghost" onClick={() => void read(items?.at(-1)?.at)}>もっと見る</button>}
    </>
  );
}
