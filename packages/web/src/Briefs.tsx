/**
 * @file 朝のブリーフ・週次ブリーフの画面（仕様書 第9.5.5.1.2節、Q-246）。本人の直近のブリーフを出し、過去のブリーフを一覧から開ける。
 *
 * メニューから開くと、いちばん新しいブリーフの本文を出す。まとめている最中なら、終わったら入れ替える。
 * 「今すぐ受け取る」は題名の横に小さく置き、押してもこの画面のままでまとめはじめる。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Brief } from '@m2office/shared';
import { api, describeError, type AgentSummary } from './api.js';
import { Busy, ConnectPrompt } from './components.js';
import { Markdown } from './help.js';

/** まとめている間、終わったかを見に行く間隔。 */
const POLL_MS = 4000;

const jst = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...o }).format(new Date(iso));

/** 日本時間のその週の月曜日。 */
function mondayOf(iso: string): Date {
  const d = new Date(new Date(iso).getTime() + 9 * 3_600_000);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back) - 9 * 3_600_000);
}

/**
 * 一覧に出す呼び方。朝は「10月19日（月）」、週は「10月19日の週」。
 *
 * @param weekly 週次ブリーフか（業務の ID で決める）
 */
export function briefLabel(iso: string, weekly: boolean): string {
  if (weekly) return `${jst(mondayOf(iso).toISOString(), { month: 'long', day: 'numeric' })}の週`;
  return `${jst(iso, { month: 'long', day: 'numeric' })}（${jst(iso, { weekday: 'short' })}）`;
}

/**
 * ブリーフの画面。
 *
 * @param agent 朝のブリーフか週次ブリーフの業務（定義の `category` が `briefing`）
 * @param initialRunId はじめに出すブリーフ（通知から開いたとき）。無ければいちばん新しいもの
 * @param title 題名の中身（業務の名前と「？」）。横に「今すぐ受け取る」を並べる
 */
export function BriefScreen({ agent, initialRunId, title }: { agent: AgentSummary; initialRunId?: string; title: ReactNode }) {
  const weekly = agent.id === 'weekly-brief';
  const [items, setItems] = useState<Brief[] | null>(null);
  const [more, setMore] = useState(false);
  const [running, setRunning] = useState<{ runId: string; startedAt: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(initialRunId ?? null);
  const [bodies, setBodies] = useState<Map<string, Brief>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const wasRunning = useRef(false);

  /** 一覧を先頭から読み直す。まとめ終わったところなら、新しいブリーフを選ぶ。 */
  const load = useCallback(async () => {
    try {
      const r = await api.briefs.list(agent.id);
      setItems(r.items);
      setMore(r.more);
      setRunning(r.running);
      if (wasRunning.current && !r.running) setSelected(r.items[0]?.runId ?? null);
      else setSelected((cur) => cur ?? r.items[0]?.runId ?? null);
      wasRunning.current = !!r.running;
    } catch (e) {
      setError(describeError(e, '読み込めませんでした'));
    }
  }, [agent.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (initialRunId) setSelected(initialRunId); }, [initialRunId]);

  // まとめている間は、終わったかを見に行き、経過した時間を数える
  useEffect(() => {
    if (!running) return undefined;
    const poll = setInterval(() => { void load(); }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [running, load]);

  // 選んだブリーフの本文を読む（読んだものは覚えておく）
  useEffect(() => {
    if (!selected || bodies.has(selected)) return;
    api.briefs.get(selected)
      .then((r) => setBodies((m) => new Map(m).set(selected, r.brief)))
      .catch((e) => setError(describeError(e, 'ブリーフを読み込めませんでした')));
  }, [selected, bodies]);

  const receive = async () => {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.createJob(agent.id, {});
      setRunning({ runId, startedAt: new Date().toISOString() });
      wasRunning.current = true;
      setNow(Date.now());
    } catch (e) {
      setError(describeError(e, 'まとめはじめられませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const loadMore = async () => {
    const last = items?.[items.length - 1];
    if (!last) return;
    try {
      const r = await api.briefs.list(agent.id, last.createdAt);
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setMore(r.more);
    } catch (e) {
      setError(describeError(e, '読み込めませんでした'));
    }
  };
  const remove = async (runId: string) => {
    setError(null);
    try {
      await api.briefs.remove(runId);
      const rest = (items ?? []).filter((b) => b.runId !== runId);
      setItems(rest);
      setSelected(rest[0]?.runId ?? null);
    } catch (e) {
      setError(describeError(e, '削除できませんでした'));
    }
  };

  const missing = agent.needsConnection ?? [];
  const shown = selected ? bodies.get(selected) : undefined;
  const minutes = running ? Math.max(0, Math.floor((now - Date.parse(running.startedAt)) / 60_000)) : 0;

  return (
    <>
      <div className="briefs-head">
        <h1>{title}</h1>
        <button className="btn ghost small" onClick={() => void receive()} disabled={busy || !!running || missing.length > 0}>今すぐ受け取る</button>
      </div>
      {missing.map((m) => <ConnectPrompt key={m.id} id={m.id} name={m.name} />)}
      {error && <p className="error">{error}</p>}
      {running && <p className="briefs-running"><Busy>まとめています{minutes > 0 ? `（${minutes} 分）` : ''}</Busy></p>}
      {items && items.length === 0 && !running && <p className="muted">まだブリーフはありません</p>}
      {items && items.length > 0 && (
        <div className="briefs-wrap"><div className="briefs">
          <article className="card briefs-body">
            {shown ? (
              <>
                <div className="briefs-meta">
                  <strong>{briefLabel(shown.createdAt, weekly)}</strong>
                  <span className="muted small">{jst(shown.createdAt, { hour: '2-digit', minute: '2-digit' })}</span>
                  <button className="btn ghost small danger" onClick={() => void remove(shown.runId)}>削除</button>
                </div>
                <div className="md"><Markdown text={shown.body ?? ''} lineBreaks /></div>
              </>
            ) : <p className="muted">読み込み中…</p>}
          </article>
          <nav className="briefs-list" aria-label="過去のブリーフ">
            <ul>
              {items.map((b) => (
                <li key={b.runId}>
                  <button className={`briefs-item${b.runId === selected ? ' on' : ''}`} aria-current={b.runId === selected} onClick={() => setSelected(b.runId)}>
                    {briefLabel(b.createdAt, weekly)}
                  </button>
                </li>
              ))}
            </ul>
            {more && <button className="link small" onClick={() => void loadMore()}>もっと見る</button>}
          </nav>
        </div></div>
      )}
    </>
  );
}
