/**
 * @file 意思決定支援の画面（仕様書 第43.11節）。相談の一覧と新しい相談、相談の画面（判断の問い・材料・討論の推移・報告・割り込み・止める・続ける・
 * 掘り下げる・共有・削除）。
 *
 * - 討論の推移は 3 つの見せ方で切り替える（第43.11.1節）: 論点の流れ（主張のつながりを線でたどる。崩された主張は線で消し、答えの無い主張は目立たせる）・
 *   発言の順（全文）・優勢の推移（論点ごとの優勢の移り変わりの表）。突き合わせを使った相談は、討論 1・討論 2・突き合わせを切り替える。
 * - 討論は書かれるそばから流して見せる（第43.11.2節）。差分を SSE で受け取り、切れたら最後に受け取った番号からつなぎ直す。
 * - AI の発言はすべて全文で見られる。説明文は常に出さない（原則 u11）。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DECISION_CLAIM_KIND_LABELS, DECISION_CLAIM_STATE_LABELS, DECISION_END_LABELS, DECISION_LEAN_LABELS, DECISION_LIMITS, DECISION_MATERIAL_KIND_LABELS,
  DECISION_ROLE_LABELS, DECISION_STATUS_LABELS,
  type DecisionClaim, type DecisionDetail, type DecisionIssueState, type DecisionLean, type DecisionStreamEvent, type DecisionSummary, type DecisionTurn,
} from '@m2office/shared';
import { api, describeError } from './api.js';
import { BackButton } from './back-button.js';
import { Busy } from './components.js';
import { Markdown } from './help.js';

const RUNNING = new Set(['queued', 'gathering', 'debating', 'summarizing']);
const timeLabel = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
/** 話し手の色の名前（慎重・推進・判定・人）。 */
const SIDE: Record<string, string> = { con: 'con', pro: 'pro', judge: 'judge', human: 'human' };
const LEAN_CLASS: Record<DecisionLean, string> = { con: 'con', pro: 'pro', even: 'even', open: 'open' };

/** 意思決定支援の画面。`id` があれば相談の画面、無ければ一覧。 */
export function Decisions({ id, onOpen, changeKey }: {
  id: string | null;
  onOpen: (id: string | null) => void;
  /** 秘書が相談を始めた・終えたたびに変わる値。変わったら一覧を読み直す。 */
  changeKey: string;
}) {
  return id ? <DecisionView id={id} onBack={() => onOpen(null)} /> : <DecisionList onOpen={onOpen} changeKey={changeKey} />;
}

/** 一覧と新しい相談。 */
function DecisionList({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [items, setItems] = useState<DecisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.decisions.list().then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 動いている相談があるあいだは読み直す
  useEffect(() => {
    if (!items?.some((x) => RUNNING.has(x.status))) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [items, load]);
  return (
    <div className="dcs">
      <NewDecision onStarted={onOpen} />
      {error && <p className="error">{error}</p>}
      {!items ? <p className="muted">読み込み中…</p> : items.length === 0 ? null : (
        <ul className="dcs-list">
          {items.map((x) => (
            <li key={x.id}>
              <button className="dcs-item" onClick={() => onOpen(x.id)}>
                <span className="dcs-item-title">{x.title}</span>
                <span className="row wrap dcs-item-meta">
                  <StatusBadge status={x.status} />
                  {x.verdict && <span className="small">{x.verdict}</span>}
                  {!x.mine && <span className="badge">共有</span>}
                  <span className="small muted">{timeLabel(x.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 状態の印。 */
function StatusBadge({ status }: { status: DecisionSummary['status'] }) {
  const cls = status === 'done' ? 'badge ok' : status === 'failed' ? 'badge danger' : RUNNING.has(status) ? 'badge warn' : 'badge';
  return <span className={cls}>{DECISION_STATUS_LABELS[status]}</span>;
}

/** 新しい相談（お題・添付・ターン数・突き合わせ）。 */
function NewDecision({ onStarted }: { onStarted: (id: string) => void }) {
  const [topic, setTopic] = useState('');
  const [turns, setTurns] = useState<number>(DECISION_LIMITS.turnsDefault);
  const [crossCheck, setCrossCheck] = useState(false);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = async (list: FileList | null) => {
    if (!list) return;
    setError(null);
    for (const f of Array.from(list).slice(0, DECISION_LIMITS.attachmentsMax - files.length)) {
      if (f.size > DECISION_LIMITS.attachmentBytesMax) { setError(`${f.name} は 20 MB を超えています`); continue; }
      setBusy(`${f.name} を上げています`);
      try {
        const r = await api.uploadFile(f);
        setFiles((x) => [...x, { id: r.id, name: r.name }]);
      } catch (e) { setError(describeError(e, '上げられませんでした')); }
    }
    setBusy(null);
  };
  const start = () => {
    setError(null);
    setBusy('始めています');
    api.decisions.start({ topic, turns, crossCheck, fileIds: files.map((f) => f.id) })
      .then((r) => onStarted(r.id))
      .catch((e) => { setError(describeError(e, '始められませんでした')); setBusy(null); });
  };
  return (
    <div className="card dcs-new">
      <textarea value={topic} maxLength={DECISION_LIMITS.topicMax} rows={3} aria-label="お題"
        placeholder="主力商品の値上げを 10% 考えているが、いかがでしょうか？" onChange={(e) => setTopic(e.target.value)} />
      {files.length > 0 && (
        <div className="row wrap dcs-files">
          {files.map((f) => (
            <span key={f.id} className="badge">{f.name} <button className="link small" aria-label={`${f.name} を外す`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>×</button></span>
          ))}
        </div>
      )}
      <div className="row wrap dcs-new-bar">
        <label className="btn ghost small">
          添付
          <input type="file" multiple hidden accept=".pdf,.xlsx,.csv,.docx,.txt,.png,.jpg,.jpeg" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="small row">
          ターン数
          <input type="number" className="dcs-turns" min={DECISION_LIMITS.turnsMin} max={DECISION_LIMITS.turnsMax} value={turns}
            onChange={(e) => setTurns(Math.min(DECISION_LIMITS.turnsMax, Math.max(DECISION_LIMITS.turnsMin, Math.round(Number(e.target.value) || DECISION_LIMITS.turnsDefault))))} />
        </label>
        <label className="small row"><input type="checkbox" checked={crossCheck} onChange={(e) => setCrossCheck(e.target.checked)} />突き合わせ</label>
        <button className="btn" disabled={!topic.trim() || !!busy} onClick={start}>{busy ? <Busy>{busy}</Busy> : '始める'}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** 差分を、手元の中身に重ねる。 */
function merge(d: DecisionDetail, ev: DecisionStreamEvent): DecisionDetail {
  const upsert = <T,>(rows: T[], add: T[] | undefined, key: (x: T) => string) => {
    if (!add?.length) return rows;
    const map = new Map(rows.map((x) => [key(x), x]));
    for (const x of add) map.set(key(x), x);
    return [...map.values()];
  };
  return {
    ...d,
    rev: Math.max(d.rev, ev.rev),
    session: ev.session ? { ...d.session, ...ev.session } : d.session,
    materials: upsert(d.materials, ev.materials, (m) => String(m.no)).sort((a, b) => a.no - b.no),
    turns: upsert(d.turns, ev.turns, (t) => t.id).sort((a, b) => a.seq - b.seq),
    claims: upsert(d.claims, ev.claims, (c) => c.code),
    issueStates: upsert(d.issueStates, ev.issueStates, (x) => `${x.debate}|${x.issue}|${x.at}`),
  };
}

type Mode = 'flow' | 'order' | 'lean';

/** 相談の画面。 */
function DecisionView({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<DecisionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('flow');
  const [debate, setDebate] = useState<number | 'compare'>(1);
  const [focus, setFocus] = useState<string | null>(null);
  const revRef = useRef(0);

  const load = useCallback(() => {
    api.decisions.get(id).then((d) => { revRef.current = d.rev; setData(d); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load]);

  const running = !!data && RUNNING.has(data.session.status);
  // 動いているあいだは差分を受け取り続ける。切れたら、最後に受け取った番号からつなぎ直す
  useEffect(() => {
    if (!running) return;
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const open = () => {
      stop = api.decisions.stream(id, revRef.current, (ev) => {
        revRef.current = Math.max(revRef.current, ev.rev);
        setData((d) => (d ? merge(d, ev) : d));
      }, () => { if (!closed) timer = setTimeout(open, 2000); });
    };
    open();
    return () => { closed = true; stop?.(); if (timer) clearTimeout(timer); };
  }, [id, running]);

  const act = (p: Promise<unknown>, fail: string) => {
    setNote(null);
    p.then(load).catch((e) => setNote(describeError(e, fail)));
  };

  if (error) return <div className="dcs"><BackButton label="相談の一覧" onClick={onBack} /><p className="error">{error}</p></div>;
  if (!data) return <div className="dcs"><BackButton label="相談の一覧" onClick={onBack} /><p className="muted">読み込み中…</p></div>;
  const s = data.session;
  const debates = s.crossCheck ? [1, 2] : [1];
  const current = debate === 'compare' ? 1 : debate;
  return (
    <div className="dcs">
      <BackButton label="相談の一覧" onClick={onBack} />
      <div className="dcs-head">
        <h2>{s.question || s.topic}</h2>
        <div className="row wrap">
          <StatusBadge status={s.status} />
          {running && s.progress && <span className="small"><Busy>{s.progress}</Busy></span>}
          {s.endReason && !running && <span className="small muted">{DECISION_END_LABELS[s.endReason]}</span>}
          {s.costJpy !== null && <span className="small muted">AI の費用 約 {Math.round(s.costJpy).toLocaleString('ja-JP')} 円{s.ai === 'local' ? '（社内の AI）' : ''}</span>}
        </div>
        {s.question && s.question !== s.topic && <p className="small muted">お題: {s.topic}</p>}
        {s.endNote && <p className="small muted">{s.endNote}</p>}
        {s.viewpoints.length > 0 && <div className="row wrap">{s.viewpoints.map((v) => <span key={v} className="badge">{v}</span>)}</div>}
      </div>
      <Materials data={data} />
      {s.report && <Report data={data} onFocus={(code) => { setFocus(code); setMode('flow'); setDebate(code.startsWith('2:') ? 2 : 1); }} />}
      {data.mine && <Controls data={data} running={running} act={act} />}
      {note && <p className="error">{note}</p>}
      <div className="row wrap dcs-modes">
        {debates.length > 1 && (
          <div className="seg" role="group" aria-label="討論">
            {[...debates.map((d) => [d, `討論 ${d}`] as const), ['compare', '突き合わせ'] as const].map(([v, label]) => (
              <button key={String(v)} className={debate === v ? 'on' : ''} aria-pressed={debate === v} onClick={() => setDebate(v)}>{label}</button>
            ))}
          </div>
        )}
        {debate !== 'compare' && (
          <div className="seg" role="group" aria-label="見せ方">
            {([['flow', '論点の流れ'], ['order', '発言の順'], ['lean', '優勢の推移']] as const).map(([v, label]) => (
              <button key={v} className={mode === v ? 'on' : ''} aria-pressed={mode === v} onClick={() => setMode(v)}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {debate === 'compare'
        ? <Comparison data={data} />
        : mode === 'flow' ? <IssueFlow data={data} debate={current} focus={focus} canDig={data.mine && !running} act={act} onOrder={(code) => { setFocus(code); setMode('order'); }} />
          : mode === 'order' ? <SpeechOrder data={data} debate={current} focus={focus} onFocus={(code) => { setFocus(code); setMode('flow'); }} />
            : <LeanTable data={data} debate={current} />}
      <BackButton label="相談の一覧" onClick={onBack} place="bottom" />
    </div>
  );
}

/** 材料の一覧（畳める）。 */
function Materials({ data }: { data: DecisionDetail }) {
  if (data.materials.length === 0 && data.session.missing.length === 0) return null;
  return (
    <details className="dcs-materials">
      <summary>材料 {data.materials.length} 件{data.session.missing.length ? `・材料に無いもの ${data.session.missing.length} 件` : ''}</summary>
      <ol>
        {data.materials.map((m) => (
          <li key={m.no} id={`dcs-m-${m.no}`}>
            <span className="badge">材料 {m.no}</span> <span className="small muted">{DECISION_MATERIAL_KIND_LABELS[m.kind]}</span> {m.title}
            {!m.ok && <span className="badge warn">読めなかった</span>}
            <p className="small dcs-pre">{m.summary}</p>
          </li>
        ))}
      </ol>
      {data.session.missing.length > 0 && <p className="small">材料に無いもの: {data.session.missing.join('、')}</p>}
    </details>
  );
}

/** 報告（第43.7節の欄の順）。論点の表は討論の記録から作る。 */
function Report({ data, onFocus }: { data: DecisionDetail; onFocus: (code: string) => void }) {
  const r = data.session.report!;
  const pivots = data.claims.filter((c) => c.pivot);
  return (
    <section className="card dcs-report">
      <p className="dcs-verdict">{r.verdict}</p>
      {r.sections.map((sec) => (
        <div key={sec.heading} className="dcs-report-sec">
          <h3>{sec.heading}</h3>
          <Markdown text={sec.body} lineBreaks />
          {sec.heading === '分かれ目' && pivots.length > 0 && (
            <div className="row wrap">{pivots.map((c) => <button key={c.code} className="link small" onClick={() => onFocus(c.code)}>{c.code} へ</button>)}</div>
          )}
        </div>
      ))}
      <IssueTable data={data} />
    </section>
  );
}

/** 論点の表（論点ごとに、慎重と推進の主な主張・裏づけ・どちらが強いか・決め手）。 */
function IssueTable({ data }: { data: DecisionDetail }) {
  const rows = useMemo(() => {
    const last = new Map<string, DecisionIssueState>();
    for (const x of data.issueStates.filter((y) => y.debate === 1)) last.set(x.issue, x);
    return [...last.values()].map((x) => {
      const on = data.claims.filter((c) => c.debate === 1 && c.issue === x.issue && c.state !== 'refuted');
      return { ...x, con: on.filter((c) => c.role === 'con').slice(-2), pro: on.filter((c) => c.role === 'pro').slice(-2) };
    });
  }, [data]);
  if (rows.length === 0) return null;
  return (
    <div className="dcs-table-wrap">
      <h3>論点の表</h3>
      <table className="dcs-table">
        <thead><tr><th>論点</th><th>慎重の役</th><th>推進の役</th><th>どちらが強いか</th></tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.issue}>
              <td>{x.issue}</td>
              <td className="small">{x.con.map((c) => <div key={c.code}>{c.code} {c.gist} <Grounds grounds={c.grounds} /></div>)}</td>
              <td className="small">{x.pro.map((c) => <div key={c.code}>{c.code} {c.gist} <Grounds grounds={c.grounds} /></div>)}</td>
              <td><span className={`dcs-lean ${LEAN_CLASS[x.lean]}`}>{DECISION_LEAN_LABELS[x.lean]}</span>{x.changedBy && <span className="small muted"> 決め手 {x.changedBy}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 根拠の印（材料の番号・推測）。 */
function Grounds({ grounds }: { grounds: string[] }) {
  return <>{grounds.map((g) => <span key={g} className={g === '推測' ? 'dcs-ground guess' : 'dcs-ground'}>{g}</span>)}</>;
}

/** 止める・続ける・一言・共有・削除。 */
function Controls({ data, running, act }: { data: DecisionDetail; running: boolean; act: (p: Promise<unknown>, fail: string) => void }) {
  const s = data.session;
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<number>(DECISION_LIMITS.turnsDefault);
  const [sharing, setSharing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const finished = s.status === 'done' || s.status === 'stopped';
  return (
    <div className="dcs-controls">
      <div className="row wrap">
        <input className="dcs-interject" value={text} maxLength={DECISION_LIMITS.interjectMax} aria-label="経営者の一言"
          placeholder="原価はここ 1 年上がっていない" onChange={(e) => setText(e.target.value)} />
        <button className="btn small" disabled={!text.trim()} onClick={() => { act(api.decisions.interject(s.id, text), '足せませんでした'); setText(''); }}>足す</button>
        {running && <button className="btn ghost small" onClick={() => act(api.decisions.stop(s.id), '止められませんでした')}>止める</button>}
        {finished && s.question && (
          <>
            <input type="number" className="dcs-turns" min={DECISION_LIMITS.turnsMin} max={DECISION_LIMITS.turnsMax} value={turns} aria-label="続けるターン数"
              onChange={(e) => setTurns(Math.min(DECISION_LIMITS.turnsMax, Math.max(DECISION_LIMITS.turnsMin, Math.round(Number(e.target.value) || DECISION_LIMITS.turnsDefault))))} />
            <button className="btn ghost small" onClick={() => act(api.decisions.continue(s.id, turns), '続けられませんでした')}>続ける</button>
          </>
        )}
        <button className="btn ghost small" onClick={() => setSharing((v) => !v)}>共有{s.sharedWith.length ? `（${s.sharedWith.length}）` : ''}</button>
        {confirmDelete
          ? <><button className="btn danger small" onClick={() => act(api.decisions.trash(s.id).then(() => history.back()), '削除できませんでした')}>削除する</button><button className="btn ghost small" onClick={() => setConfirmDelete(false)}>キャンセル</button></>
          : <button className="btn ghost small" onClick={() => setConfirmDelete(true)}>削除</button>}
      </div>
      {sharing && <SharePicker id={s.id} current={s.sharedWith} onDone={() => setSharing(false)} act={act} />}
    </div>
  );
}

/** 共有する人を選ぶ（見るだけ）。 */
function SharePicker({ id, current, onDone, act }: { id: string; current: string[]; onDone: () => void; act: (p: Promise<unknown>, fail: string) => void }) {
  const [people, setPeople] = useState<{ id: string; name: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(current));
  useEffect(() => { api.decisions.people().then((r) => setPeople(r.items)).catch(() => setPeople([])); }, []);
  if (!people) return <p className="muted small">読み込み中…</p>;
  return (
    <div className="dcs-share">
      <div className="row wrap">
        {people.map((p) => (
          <label key={p.id} className="small row">
            <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((x) => { const n = new Set(x); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
            {p.name}
          </label>
        ))}
      </div>
      <div className="row">
        <button className="btn small" onClick={() => { act(api.decisions.share(id, [...picked]), '共有を変えられませんでした'); onDone(); }}>保存</button>
        <button className="btn ghost small" onClick={onDone}>キャンセル</button>
      </div>
    </div>
  );
}

/** 主張の並びの順（発言の順・発言の中の順）。 */
function claimOrder(data: DecisionDetail): Map<string, number> {
  const seq = new Map(data.turns.map((t) => [t.id, t.seq]));
  const order = new Map<string, number>();
  data.claims.forEach((c) => order.set(c.code, (seq.get(c.turnId) ?? 0) * 10 + Number(/-(\d+)$/.exec(c.code)?.[1] ?? 0)));
  return order;
}

/** 論点の流れの 1 行（主張と字下げの段）。 */
interface FlowRow { c: DecisionClaim; depth: number; chained: boolean }

/** 字下げの段の上限（深い応酬でも列の幅が狭くならないように）。 */
const FLOW_DEPTH_MAX = 2;

/**
 * 論点の主張を、論点の流れで並べる順と段にする。
 * 返しが 1 つだけ続くあいだは段を変えずに縦に続け（`chained`）、返しが分かれたときだけ 1 段下げる（上限は {@link FLOW_DEPTH_MAX}）。
 * 応酬が長く続くほど右へ寄って読みにくくなるのを避けるため。どの主張への返しかは、各主張の「↩ 番号」で示す。
 */
function flowRows(mine: DecisionClaim[], codes: Set<string>): FlowRow[] {
  const children = new Map<string, DecisionClaim[]>();
  const roots: DecisionClaim[] = [];
  for (const c of mine) {
    if (c.target && codes.has(c.target)) children.set(c.target, [...(children.get(c.target) ?? []), c]);
    else roots.push(c);
  }
  const rows: FlowRow[] = [];
  const seen = new Set<string>();
  const walk = (c: DecisionClaim, depth: number, chained: boolean) => {
    if (seen.has(c.code)) return;
    seen.add(c.code);
    rows.push({ c, depth, chained });
    const replies = children.get(c.code) ?? [];
    if (replies.length === 1) walk(replies[0]!, depth, true);
    else for (const r of replies) walk(r, Math.min(depth + 1, FLOW_DEPTH_MAX), false);
  };
  for (const c of roots) walk(c, 0, false);
  return rows;
}

/** 論点の流れ（論点ごとに 1 列。主張のつながりを線でたどる。第43.11.1節）。 */
function IssueFlow({ data, debate, focus, canDig, act, onOrder }: {
  data: DecisionDetail; debate: number; focus: string | null; canDig: boolean;
  act: (p: Promise<unknown>, fail: string) => void; onOrder: (code: string) => void;
}) {
  const order = useMemo(() => claimOrder(data), [data]);
  const turnStage = useMemo(() => new Map(data.turns.map((t) => [t.id, t])), [data.turns]);
  const claims = data.claims.filter((c) => c.debate === debate).sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0));
  const issues = [...new Set(claims.map((c) => c.issue))];
  const lastLean = new Map<string, DecisionIssueState>();
  for (const x of data.issueStates.filter((y) => y.debate === debate)) lastLean.set(x.issue, x);
  const digs = data.session.digs.filter((d) => d.debate === debate);
  if (claims.length === 0) return <p className="muted">{RUNNING.has(data.session.status) ? 'まだ主張はありません。' : '主張はありません。'}</p>;
  return (
    <div className="dcs-flow">
      {issues.map((issue) => {
        const mine = claims.filter((c) => c.issue === issue);
        const codes = new Set(mine.map((c) => c.code));
        const rows = flowRows(mine, codes);
        const lean = lastLean.get(issue);
        const dig = digs.find((d) => d.issue === issue);
        const unanswered = mine.filter((c) => c.state === 'unanswered').length;
        return (
          <section key={issue} className="dcs-issue">
            <header className="row wrap">
              <h3>{issue}</h3>
              {lean && <span className={`dcs-lean ${LEAN_CLASS[lean.lean]}`}>{DECISION_LEAN_LABELS[lean.lean]}</span>}
              {unanswered > 0 && <span className="badge warn">答えが無い {unanswered}</span>}
              {canDig && <DigButton id={data.session.id} issue={issue} act={act} />}
            </header>
            {dig && <p className="small dcs-dig">深掘り: {dig.question}</p>}
            <ul className="dcs-thread">
              {rows.map((r) => <ClaimNode key={r.c.code} c={r.c} depth={r.depth} chained={r.chained} focus={focus} digTurn={(x) => turnStage.get(x.turnId)?.stage === 'dig'} onOrder={onOrder} />)}
            </ul>
            {lean && (lean.changedBy || lean.reason) && <p className="small muted">{lean.label}: {lean.changedBy ? `${lean.changedBy} で変化。` : ''}{lean.reason}</p>}
          </section>
        );
      })}
    </div>
  );
}

/** この論点を掘り下げる（ターン数を選ぶ）。 */
function DigButton({ id, issue, act }: { id: string; issue: string; act: (p: Promise<unknown>, fail: string) => void }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState(3);
  if (!open) return <button className="link small" onClick={() => setOpen(true)}>掘り下げる</button>;
  return (
    <span className="row">
      <input type="number" className="dcs-turns" min={1} max={DECISION_LIMITS.turnsMax} value={turns} aria-label="掘り下げるターン数"
        onChange={(e) => setTurns(Math.min(DECISION_LIMITS.turnsMax, Math.max(1, Math.round(Number(e.target.value) || 3))))} />
      <button className="btn small" onClick={() => { act(api.decisions.dig(id, issue, turns), '掘り下げられませんでした'); setOpen(false); }}>掘り下げる</button>
      <button className="btn ghost small" onClick={() => setOpen(false)}>キャンセル</button>
    </span>
  );
}

/** 論点の流れの主張の 1 つ。押すと本文の全文を開く。 */
function ClaimNode({ c, depth, chained, focus, digTurn, onOrder }: {
  c: DecisionClaim; depth: number; chained: boolean; focus: string | null; digTurn: (c: DecisionClaim) => boolean; onOrder: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus === c.code) { setOpen(true); ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }, [focus, c.code]);
  const cls = ['dcs-claim', SIDE[c.role], c.state, c.pivot ? 'pivot' : '', focus === c.code ? 'focus' : ''].filter(Boolean).join(' ');
  return (
    <li ref={ref} id={`dcs-c-${c.code}`} className={`dcs-depth-${depth}${chained ? ' chained' : ''}`}>
      <div className={cls}>
        <button className="dcs-claim-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className={`dcs-code ${SIDE[c.role]}`}>{c.code}</span>
          <span className="small muted">{DECISION_CLAIM_KIND_LABELS[c.kind]}{c.target ? ` ↩ ${c.target}` : ''}{digTurn(c) ? '・深掘り' : ''}</span>
          {c.pivot && <span className="badge warn">分かれ目</span>}
          <span className="dcs-gist">{c.gist}</span>
          <Grounds grounds={c.grounds} />
        </button>
        {c.state !== 'standing' && (
          <p className="small dcs-state">{DECISION_CLAIM_STATE_LABELS[c.state]}{c.refutedBy ? `（${c.refutedBy} で）` : ''}{c.stateReason ? ` — ${c.stateReason}` : ''}</p>
        )}
        {open && (
          <div className="dcs-body">
            <p className="dcs-pre">{c.body}</p>
            <button className="link small" onClick={() => onOrder(c.code)}>発言の全文へ</button>
          </div>
        )}
      </div>
    </li>
  );
}

/** 発言の順（全文。慎重と推進を左右に、人と判定の役を間に。第43.11.1節）。 */
function SpeechOrder({ data, debate, focus, onFocus }: { data: DecisionDetail; debate: number; focus: string | null; onFocus: (code: string) => void }) {
  const turns = data.turns.filter((t) => t.debate === debate || t.debate === 0);
  const claimsByTurn = useMemo(() => {
    const m = new Map<string, DecisionClaim[]>();
    for (const c of data.claims) m.set(c.turnId, [...(m.get(c.turnId) ?? []), c]);
    return m;
  }, [data.claims]);
  const replied = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data.claims) if (c.target) m.set(c.target, (m.get(c.target) ?? 0) + 1);
    return m;
  }, [data.claims]);
  const focusTurn = focus ? data.claims.find((c) => c.code === focus)?.turnId : null;
  let lastIssue: string | null = null;
  return (
    <ol className="dcs-order">
      {turns.map((t) => {
        const header = t.stage === 'dig' && t.issue !== lastIssue ? t.issue : null;
        if (t.stage === 'dig') lastIssue = t.issue; else if (t.stage === 'main') lastIssue = null;
        return (
          <Fragment key={t.id}>
            {header && <li className="dcs-divider small">深掘り: {header}</li>}
            <Speech t={t} claims={claimsByTurn.get(t.id) ?? []} replied={replied} focused={focusTurn === t.id} onFocus={onFocus} />
          </Fragment>
        );
      })}
    </ol>
  );
}

/** 発言の 1 つ（全文）。見出しの行は主張の印にして出す。 */
function Speech({ t, claims, replied, focused, onFocus }: { t: DecisionTurn; claims: DecisionClaim[]; replied: Map<string, number>; focused: boolean; onFocus: (code: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [focused]);
  const who = t.role === 'judge' ? (t.stage === 'report' ? '判定の役の報告' : t.stage === 'compare' ? '判定の役（突き合わせ）' : '判定の役') : DECISION_ROLE_LABELS[t.role];
  const lines = t.text.split('\n');
  let claimIndex = 0;
  return (
    <li ref={ref} className={`dcs-speech ${SIDE[t.role]}${focused ? ' focus' : ''}`}>
      <div className="row wrap small dcs-speech-meta">
        <strong>{who}</strong>
        {t.turn > 0 && t.role !== 'judge' && <span className="muted">{t.turn} ターン目</span>}
        {!t.done && !t.stopped && <Busy>書いています</Busy>}
        {t.stopped && <span className="badge">途中で止めた</span>}
        {t.rewritten && <span className="badge">書き直し</span>}
      </div>
      {t.role === 'judge' && t.stage === 'report'
        ? <Markdown text={t.text} lineBreaks />
        : (
          <div className="dcs-pre">
            {lines.map((line, i) => {
              if (/^\s*【.+】\s*$/.test(line)) {
                const c = claims[claimIndex++];
                return c
                  ? (
                    <div key={i} className="row wrap dcs-claim-line">
                      <button className={`dcs-code ${SIDE[c.role]}`} onClick={() => onFocus(c.code)}>{c.code}</button>
                      <span className="small muted">{DECISION_CLAIM_KIND_LABELS[c.kind]}{c.target ? ` ↩ ${c.target} への${DECISION_CLAIM_KIND_LABELS[c.kind]}` : ''}・{c.issue}</span>
                      <Grounds grounds={c.grounds} />
                      {(replied.get(c.code) ?? 0) > 0 && <span className="small muted">返し {replied.get(c.code)} 件</span>}
                    </div>
                  )
                  : <div key={i} className="small muted">{line}</div>;
              }
              return <div key={i}>{line || ' '}</div>;
            })}
          </div>
        )}
    </li>
  );
}

/** 優勢の推移（行が論点、列が区切り。第43.11.1節）。 */
function LeanTable({ data, debate }: { data: DecisionDetail; debate: number }) {
  const states = data.issueStates.filter((x) => x.debate === debate);
  const cols: { at: string; label: string }[] = [];
  for (const x of states) if (!cols.some((c) => c.at === x.at)) cols.push({ at: x.at, label: x.label });
  const issues = [...new Set(states.map((x) => x.issue))];
  if (cols.length === 0) return <p className="muted">まだ途中のまとめはありません。</p>;
  return (
    <div className="dcs-table-wrap">
      <table className="dcs-table dcs-lean-table">
        <thead><tr><th>論点</th>{cols.map((c) => <th key={c.at}>{c.label}</th>)}</tr></thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue}>
              <td>{issue}</td>
              {cols.map((c) => {
                const x = states.find((y) => y.issue === issue && y.at === c.at);
                return (
                  <td key={c.at} title={x?.reason ?? ''}>
                    {x ? <><span className={`dcs-lean ${LEAN_CLASS[x.lean]}`}>{DECISION_LEAN_LABELS[x.lean]}</span>{x.changedBy && <span className="small"> ← {x.changedBy}</span>}</> : <span className="muted">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 突き合わせ（行が論点、列が討論 1 と討論 2 の終わりの優勢。割れた論点を目立たせる。第43.6.4節）。 */
function Comparison({ data }: { data: DecisionDetail }) {
  const c = data.session.comparison;
  const endOf = (d: number) => {
    const m = new Map<string, DecisionLean>();
    for (const x of data.issueStates.filter((y) => y.debate === d)) m.set(x.issue, x.lean);
    return m;
  };
  const one = endOf(1);
  const two = endOf(2);
  const issues = [...new Set([...one.keys(), ...two.keys()])];
  const split = new Set(c?.splits.map((x) => x.issue) ?? []);
  return (
    <div className="dcs-compare">
      {c ? <p className={c.agreement === 'agree' ? 'dcs-verdict' : 'dcs-verdict warn'}>2 つの討論の見立ては{c.agreement === 'agree' ? 'そろいました' : '割れました'}</p> : <p className="muted">まだ突き合わせていません。</p>}
      {c && c.splits.length > 0 && (
        <ul>{c.splits.map((x) => <li key={x.issue}><strong>{x.issue}</strong>: {x.reason}</li>)}</ul>
      )}
      <div className="dcs-table-wrap">
        <table className="dcs-table">
          <thead><tr><th>論点</th><th>討論 1</th><th>討論 2</th></tr></thead>
          <tbody>
            {issues.map((issue) => (
              <tr key={issue} className={split.has(issue) ? 'split' : ''}>
                <td>{issue}</td>
                {[one, two].map((m, i) => {
                  const lean = m.get(issue);
                  return <td key={i}>{lean ? <span className={`dcs-lean ${LEAN_CLASS[lean]}`}>{DECISION_LEAN_LABELS[lean]}</span> : <span className="muted">出なかった</span>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
