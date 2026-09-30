/**
 * @file デバッグモードの印と記録の画面（仕様書 第20.4.1節「デバッグモード」）。どの画面でも上に赤い「Debug mode」を出し、押すと右から記録を開く。
 *
 * サーバーの記録（音声の聞き取りと発話・道具に渡した文と答え・秘書の振り分け・失敗した呼び出し）と、
 * この画面から呼んだ API の直近 100 件を時刻順に並べる。「写す」で文字にして写し、AI への報告に貼れるようにする。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DebugEvent } from './api.js';
import { OPEN_DEBUG_EVENT, clearClientCalls, clientCalls, onClientCalls, type ClientCall } from './debug.js';

/** サーバーの記録を読み直す間隔（ミリ秒）。開いている間だけ読む。 */
const POLL_MS = 2000;

const KIND_LABEL: Record<DebugEvent['kind'], string> = { voice: '音声', secretary: '秘書', error: 'エラー' };

/** 時刻（時:分:秒）。 */
const hms = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { hour12: false });

/** 中身を読みやすい JSON にする。 */
const pretty = (v: unknown) => {
  if (v === undefined) return '';
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
};

/**
 * デバッグモードの印と記録の画面。`/v1/me` の `debug` が真のときだけ置く。
 *
 * @remarks 左のメニューの「デバッグ」からも開く（{@link OPEN_DEBUG_EVENT}）
 */
export function DebugOverlay() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_DEBUG_EVENT, show);
    return () => window.removeEventListener(OPEN_DEBUG_EVENT, show);
  }, []);
  return (
    <>
      <button className="debug-badge" onClick={() => setOpen(!open)} aria-expanded={open} title="デバッグの記録を開く">
        Debug mode
      </button>
      {open && <DebugDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

/** 右から開く記録の一覧。 */
function DebugDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'server' | 'client'>('server');
  const [kind, setKind] = useState<DebugEvent['kind'] | 'all'>('all');
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [calls, setCalls] = useState<ClientCall[]>(clientCalls);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const latest = useRef<string | undefined>(undefined);

  // サーバーの記録は、開いている間だけ読み足す
  const pull = useCallback(async () => {
    try {
      const r = await api.debug.events(latest.current);
      if (r.events.length) {
        latest.current = r.events[0]!.id;
        // 読み出しが重なっても同じ記録を二度並べない（開いた直後に 2 回読むことがある）
        setEvents((cur) => {
          const seen = new Set(cur.map((e) => e.id));
          return [...r.events.filter((e) => !seen.has(e.id)), ...cur].slice(0, 500);
        });
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), POLL_MS);
    return () => clearInterval(t);
  }, [pull]);
  useEffect(() => onClientCalls(() => setCalls(clientCalls())), []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const shown = kind === 'all' ? events : events.filter((e) => e.kind === kind);

  // AI への報告に貼れる文字にする（古い順）
  const asText = () => (tab === 'server'
    ? [...shown].reverse().map((e) => `[${hms(e.at)}] [${KIND_LABEL[e.kind]}] ${e.title}${e.detail !== undefined ? `\n${pretty(e.detail)}` : ''}`)
    : [...calls].reverse().map((c) => `[${hms(c.at)}] ${c.method} ${c.path} → ${c.status}（${c.ms} ms）${c.request ? `\n送った: ${c.request}` : ''}${c.response ? `\n応答: ${c.response}` : ''}`)
  ).join('\n\n');
  const copy = () => {
    void navigator.clipboard?.writeText(asText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const clear = async () => {
    if (tab === 'client') { clearClientCalls(); return; }
    await api.debug.clear().catch(() => undefined);
    latest.current = undefined;
    setEvents([]);
  };

  return (
    <aside className="debug-drawer" role="dialog" aria-label="デバッグの記録">
      <div className="debug-head">
        <strong>デバッグの記録</strong>
        <div className="debug-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'server'} className={tab === 'server' ? 'on' : ''} onClick={() => setTab('server')}>サーバー（{events.length}）</button>
          <button role="tab" aria-selected={tab === 'client'} className={tab === 'client' ? 'on' : ''} onClick={() => setTab('client')}>画面の呼び出し（{calls.length}）</button>
        </div>
        <span className="spacer" />
        <button className="btn ghost small" onClick={copy}>{copied ? '写しました' : '写す'}</button>
        <button className="btn ghost small" onClick={() => void clear()}>削除</button>
        <button className="btn ghost small" onClick={onClose} aria-label="閉じる">×</button>
      </div>
      {tab === 'server' && (
        <div className="debug-filter">
          {(['all', 'voice', 'secretary', 'error'] as const).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'all' ? 'すべて' : KIND_LABEL[k]}</button>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      <ol className="debug-list">
        {tab === 'server' && shown.map((e) => (
          <li key={e.id} className={`debug-row ${e.kind}`}>
            <details>
              <summary><time>{hms(e.at)}</time><span className="debug-kind">{KIND_LABEL[e.kind]}</span>{e.title}</summary>
              {e.detail !== undefined && <pre>{pretty(e.detail)}</pre>}
            </details>
          </li>
        ))}
        {tab === 'client' && calls.map((c) => (
          <li key={c.id} className={`debug-row ${c.status === 0 || c.status >= 400 ? 'error' : ''}`}>
            <details>
              <summary><time>{hms(c.at)}</time><span className="debug-kind">{c.status || '失敗'}</span>{c.method} {c.path}<span className="muted">（{c.ms} ms）</span></summary>
              {c.request && <><p className="debug-label">送った</p><pre>{pretty(c.request)}</pre></>}
              {c.response && <><p className="debug-label">応答</p><pre>{pretty(c.response)}</pre></>}
            </details>
          </li>
        ))}
        {tab === 'server' && shown.length === 0 && <li className="muted small">まだ記録はありません</li>}
        {tab === 'client' && calls.length === 0 && <li className="muted small">まだ記録はありません</li>}
      </ol>
    </aside>
  );
}
