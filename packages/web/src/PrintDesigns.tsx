/**
 * @file 販促物の作成の画面（仕様書 第41.9節）。一覧（掲示の状態で絞る）・作る（頼みの文と写真）／1 つの物の 3 案から選ぶ・会話で直す・
 * 文面をその場で直す・点検の印・書き出し（PDF・入稿用の PDF・PNG）・掲示の期間と置き場所・外した・作り直す・版を戻す・削除。
 *
 * 字は M2Office が組む。画面は API を経由するだけで、画像も API から読む。説明文は常に出さない（原則 u11）。印刷の発注はしない。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PRINT_CHECK_LABELS, PRINT_KIND_LABELS, PRINT_KIND_SIZES, PRINT_LIMITS, PRINT_SIZES, PRINT_STATE_LABELS,
  type PrintCopy, type PrintDesign, type PrintDesignDetailView, type PrintKind, type PrintSize, type PrintState, type PrintVersion,
} from '@m2office/shared';
import { api, describeError } from './api.js';

type Item = PrintDesign & { state: PrintState };
type Filter = 'all' | PrintState;

const STATE_BADGE: Record<PrintState, string> = { draft: 'badge', upcoming: 'badge', posted: 'badge ok', ended: 'badge warn', removed: 'badge' };
const dayLabel = (d: string | null) => (d ? d.replace(/-/g, '/') : '');
const periodLabel = (d: Pick<PrintDesign, 'postFrom' | 'postTo'>) => (d.postFrom || d.postTo ? `${dayLabel(d.postFrom)}〜${dayLabel(d.postTo)}` : '');
const timeLabel = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

type Note = { kind: 'ok' | 'error'; text: string } | null;
function NoteText({ note }: { note: Note }) {
  return note ? <span className={`prd-note is-${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</span> : null;
}

/** 写真を選んで上げるボタン（上げたファイルの ID を返す）。 */
function PhotoButton({ photo, onPhoto, disabled }: { photo: { id: string; name: string } | null; onPhoto: (p: { id: string; name: string } | null) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      onPhoto(await api.uploadFile(f));
    } catch (e) {
      setError(describeError(e, '写真を上げられませんでした'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      {photo
        ? <span className="prd-photo small">{photo.name} <button className="link small" disabled={disabled} onClick={() => onPhoto(null)}>外す</button></span>
        : <button className="btn ghost small" disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? '上げています…' : '写真を使う'}</button>}
      {error && <span className="error small">{error}</span>}
    </>
  );
}

/** 販促物の作成の画面（一覧か 1 つ）。 */
export function PrintDesigns({ designId, onOpen, changeKey }: {
  designId: string | null;
  onOpen: (designId: string | null) => void;
  /** 秘書が販促物を作る・直すたびに変わる値。変わったら読み直す。 */
  changeKey: string;
}) {
  return designId
    ? <DesignView key={designId} id={designId} onBack={() => onOpen(null)} onOpen={onOpen} changeKey={changeKey} />
    : <DesignList onOpen={(id) => onOpen(id)} changeKey={changeKey} />;
}

/** 一覧と、作る。 */
function DesignList({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.printDesigns.list().then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="error">{error}</p>;
  if (!items) return <p className="muted">読み込み中…</p>;
  const counts = (s: PrintState) => items.filter((d) => d.state === s).length;
  const shown = items.filter((d) => filter === 'all' || d.state === filter);
  return (
    <div className="prd">
      <CreateBox onCreated={onOpen} />
      {items.length > 0 && (
        <div className="seg" role="group" aria-label="表示">
          {([['all', 'すべて'], ['posted', '掲示中'], ['upcoming', 'これから'], ['ended', '期間が終わった'], ['draft', '下書き'], ['removed', '外した']] as const).map(([v, label]) => (
            (v === 'all' || counts(v) > 0) && <button key={v} className={filter === v ? 'on' : ''} aria-pressed={filter === v} onClick={() => setFilter(v)}>{label}{v !== 'all' ? ` ${counts(v)}` : ''}</button>
          ))}
        </div>
      )}
      {items.length === 0 && <p className="muted">まだ作っていません。</p>}
      <ul className="prd-grid">
        {shown.map((d) => (
          <li key={d.id}>
            <button className="prd-tile card" onClick={() => onOpen(d.id)}>
              <img src={api.printDesigns.thumbUrl(d.id, d.updatedAt)} alt="" loading="lazy" />
              <span className="prd-tile-title">{d.title}</span>
              <span className="small muted">{PRINT_KIND_LABELS[d.kind]}・{PRINT_SIZES[d.size].label}</span>
              <span className="row wrap small">
                <span className={STATE_BADGE[d.state]}>{PRINT_STATE_LABELS[d.state]}</span>
                {periodLabel(d) && <span className="muted">{periodLabel(d)}</span>}
                {d.place && <span className="muted">{d.place}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 作る（頼みの文・種類と大きさ（任意）・写真（任意））。 */
function CreateBox({ onCreated }: { onCreated: (id: string) => void }) {
  const [request, setRequest] = useState('');
  const [kind, setKind] = useState<PrintKind | ''>('');
  const [size, setSize] = useState<PrintSize | ''>('');
  const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sizes = kind ? PRINT_KIND_SIZES[kind] : [];
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.printDesigns.create({ request: request.trim(), ...(kind ? { kind } : {}), ...(size ? { size } : {}), ...(photo ? { photoFileId: photo.id } : {}) });
      onCreated(r.design.id);
    } catch (e) {
      setError(describeError(e, '作れませんでした'));
      setBusy(false);
    }
  };
  return (
    <div className="prd-create card">
      <textarea value={request} rows={3} maxLength={PRINT_LIMITS.requestMax} disabled={busy} aria-label="作りたいもの"
        placeholder="例: 春の決算セールのチラシを A4 で。3/1〜15、全品 10% オフ、駐車場あり" onChange={(e) => setRequest(e.target.value)} />
      <div className="row wrap">
        <select value={kind} disabled={busy} aria-label="種類" onChange={(e) => { setKind(e.target.value as PrintKind | ''); setSize(''); }}>
          <option value="">種類はおまかせ</option>
          {(Object.keys(PRINT_KIND_LABELS) as PrintKind[]).map((k) => <option key={k} value={k}>{PRINT_KIND_LABELS[k]}</option>)}
        </select>
        {kind && (
          <select value={size} disabled={busy} aria-label="大きさ" onChange={(e) => setSize(e.target.value as PrintSize | '')}>
            <option value="">大きさはおまかせ</option>
            {sizes.map((s) => <option key={s} value={s}>{PRINT_SIZES[s].label}</option>)}
          </select>
        )}
        <PhotoButton photo={photo} onPhoto={setPhoto} disabled={busy} />
        <button className="btn small" disabled={busy || !request.trim()} onClick={() => void create()}>{busy ? '案を作っています…' : '案を作る'}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** 版の画像（パンフレットは 2 面）。 */
function Pages({ d, v, large = false }: { d: PrintDesign; v: PrintVersion; large?: boolean }) {
  const pages = d.kind === 'brochure' ? [0, 1] : [0];
  return (
    <div className={`prd-pages${large ? ' is-large' : ''}`}>
      {pages.map((p) => <img key={p} src={api.printDesigns.fileUrl(d.id, v.id, 'preview', { page: p })} alt={pages.length > 1 ? (p === 0 ? '外側' : '内側') : ''} />)}
    </div>
  );
}

/** 点検の印（確かめてほしいこと）。 */
function Checks({ v }: { v: PrintVersion }) {
  if (!v.checks.length) return null;
  return (
    <ul className="prd-checks">
      {v.checks.map((c, i) => <li key={i} className="small"><span className="badge warn">{PRINT_CHECK_LABELS[c.kind]}</span> {c.message}</li>)}
    </ul>
  );
}

/** 1 つの物。 */
function DesignView({ id, onBack, onOpen, changeKey }: { id: string; onBack: () => void; onOpen: (id: string) => void; changeKey: string }) {
  const [data, setData] = useState<PrintDesignDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const load = useCallback(() => {
    api.printDesigns.get(id).then((r) => { setData(r); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 操作して読み直す。 */
  const act = async (f: () => Promise<unknown>, failed: string, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await f();
      if (done) setNote({ kind: 'ok', text: done });
      load();
    } catch (e) {
      setNote({ kind: 'error', text: describeError(e, failed) });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="prd"><button className="link" onClick={onBack}>← 一覧へ</button><p className="error">{error}</p></div>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const { design: d, state, versions } = data;
  const current = versions.find((v) => v.id === d.currentVersionId) ?? null;
  const proposals = versions.filter((v) => v.proposal);

  return (
    <div className="prd prd-detail">
      <button className="link" onClick={onBack}>← 一覧へ</button>
      <div className="row wrap prd-head">
        <TitleField d={d} disabled={busy} onSave={(title) => act(() => api.printDesigns.setPost(d.id, { title }), '直せませんでした')} />
        <span className="badge">{PRINT_KIND_LABELS[d.kind]}</span>
        <span className="badge">{PRINT_SIZES[d.size].label}</span>
        <span className={STATE_BADGE[state]}>{PRINT_STATE_LABELS[state]}</span>
        <NoteText note={note} />
      </div>

      {!current ? (
        <>
          <ul className="prd-proposals">
            {proposals.map((v, i) => (
              <li key={v.id} className="card">
                <Pages d={d} v={v} />
                <div className="row wrap">
                  <strong>案 {i + 1}</strong>
                  {v.aiImage && <span className="small muted">画像は生成 AI</span>}
                  <button className="btn small" disabled={busy} onClick={() => void act(() => api.printDesigns.choose(d.id, v.id), '選べませんでした')}>これにする</button>
                </div>
              </li>
            ))}
          </ul>
          {proposals[0] && <Checks v={proposals[0]} />}
        </>
      ) : (
        <div className="prd-main">
          <div className="prd-preview">
            <Pages d={d} v={current} large />
          </div>
          <div className="prd-side">
            <Checks v={current} />
            <ReviseBox busy={busy} onRevise={(instruction, photoFileId) => act(() => api.printDesigns.revise(d.id, instruction, photoFileId), '直せませんでした')} />
            <div className="row wrap prd-downloads">
              <a className="btn small" href={api.printDesigns.fileUrl(d.id, current.id, 'pdf')} download>PDF</a>
              <a className="btn ghost small" href={api.printDesigns.fileUrl(d.id, current.id, 'bleed')} download>入稿用の PDF</a>
              <a className="btn ghost small" href={api.printDesigns.fileUrl(d.id, current.id, 'png', { download: true })} download>画像（PNG）</a>
            </div>
            <CopyEditor key={current.id} copy={current.copy} disabled={busy}
              onSave={(patch) => act(() => api.printDesigns.editCopy(d.id, patch), '直せませんでした', '文面を直しました')} />
            <PostFields key={`${d.postFrom}-${d.postTo}-${d.place}`} d={d} state={state} disabled={busy}
              onSave={(input) => act(() => api.printDesigns.setPost(d.id, input), '保存できませんでした', '保存しました')}
              onRemoved={() => act(() => api.printDesigns.markRemoved(d.id), '変えられませんでした')} />
            <RemakeBox disabled={busy} onRemake={async (instruction) => {
              setBusy(true);
              setNote(null);
              try {
                const r = await api.printDesigns.remake(d.id, instruction);
                onOpen(r.design.id);
              } catch (e) {
                setNote({ kind: 'error', text: describeError(e, '作り直せませんでした') });
                setBusy(false);
              }
            }} />
          </div>
        </div>
      )}

      <Versions d={d} versions={versions} currentId={d.currentVersionId} disabled={busy}
        onChoose={(v) => act(() => api.printDesigns.choose(d.id, v.id), '戻せませんでした')} />
      <div className="row wrap prd-foot">
        <span className="small muted">{d.createdByName ? `${d.createdByName}・` : ''}{timeLabel(d.createdAt)}</span>
        <button className="link danger small" disabled={busy} onClick={() => {
          if (confirm(`「${d.title}」を削除しますか？`)) void api.printDesigns.remove(d.id).then(onBack).catch((e) => setNote({ kind: 'error', text: describeError(e, '削除できませんでした') }));
        }}>削除</button>
      </div>
    </div>
  );
}

/** 題名（押して直す）。 */
function TitleField({ d, disabled, onSave }: { d: PrintDesign; disabled: boolean; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(d.title);
  if (!editing) return <h2 className="prd-title"><button className="link" disabled={disabled} onClick={() => { setV(d.title); setEditing(true); }}>{d.title}</button></h2>;
  return (
    <span className="row">
      <input value={v} maxLength={60} aria-label="題名" autoFocus onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { onSave(v.trim()); setEditing(false); } if (e.key === 'Escape') setEditing(false); }} />
      <button className="btn small" disabled={!v.trim()} onClick={() => { onSave(v.trim()); setEditing(false); }}>保存</button>
      <button className="btn ghost small" onClick={() => setEditing(false)}>キャンセル</button>
    </span>
  );
}

/** 会話で直す（「見出しをもっと大きく」「落ち着いた色に」「この写真に」）。 */
function ReviseBox({ busy, onRevise }: { busy: boolean; onRevise: (instruction: string, photoFileId?: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
  const submit = async () => {
    await onRevise(text.trim(), photo?.id);
    setText('');
    setPhoto(null);
  };
  return (
    <div className="prd-revise">
      <textarea value={text} rows={2} maxLength={500} disabled={busy} aria-label="直したいこと" placeholder="例: 見出しをもっと大きく"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (text.trim() || photo)) void submit(); }} />
      <div className="row wrap">
        <PhotoButton photo={photo} onPhoto={setPhoto} disabled={busy} />
        <button className="btn small" disabled={busy || (!text.trim() && !photo)} onClick={() => void submit()}>{busy ? '直しています…' : '直す'}</button>
      </div>
    </div>
  );
}

const COPY_FIELDS: { key: keyof PrintCopy; label: string; max: number; rows?: number }[] = [
  { key: 'headline', label: '見出し', max: PRINT_LIMITS.headlineMax },
  { key: 'sub', label: '小見出し', max: PRINT_LIMITS.subMax },
  { key: 'body', label: '本文', max: PRINT_LIMITS.bodyMax, rows: 4 },
  { key: 'period', label: '期間・日時', max: PRINT_LIMITS.periodMax },
  { key: 'price', label: '値段', max: PRINT_LIMITS.priceMax },
  { key: 'note', label: '補足', max: PRINT_LIMITS.noteMax },
  { key: 'qrUrl', label: 'QR の URL', max: 300 },
];

/** 文面をその場で直す。 */
function CopyEditor({ copy, disabled, onSave }: { copy: PrintCopy; disabled: boolean; onSave: (patch: Record<string, string>) => void }) {
  const [v, setV] = useState<PrintCopy>(copy);
  const changed = COPY_FIELDS.filter((f) => v[f.key] !== copy[f.key]);
  return (
    <details className="prd-copy">
      <summary>文面</summary>
      {COPY_FIELDS.map((f) => (
        <label key={f.key}>
          <span className="small muted">{f.label}</span>
          {f.rows
            ? <textarea value={v[f.key]} rows={f.rows} maxLength={f.max} disabled={disabled} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            : <input value={v[f.key]} maxLength={f.max} disabled={disabled} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}
        </label>
      ))}
      <div className="row">
        <button className="btn small" disabled={disabled || !changed.length} onClick={() => onSave(Object.fromEntries(changed.map((f) => [f.key, v[f.key]])))}>保存</button>
        {changed.length > 0 && <button className="btn ghost small" disabled={disabled} onClick={() => setV(copy)}>キャンセル</button>}
      </div>
    </details>
  );
}

/** 掲示の期間と置き場所・外した。 */
function PostFields({ d, state, disabled, onSave, onRemoved }: {
  d: PrintDesign; state: PrintState; disabled: boolean;
  onSave: (input: { postFrom: string | null; postTo: string | null; place: string }) => void; onRemoved: () => void;
}) {
  const [v, setV] = useState({ postFrom: d.postFrom ?? '', postTo: d.postTo ?? '', place: d.place });
  const changed = v.postFrom !== (d.postFrom ?? '') || v.postTo !== (d.postTo ?? '') || v.place !== d.place;
  return (
    <div className="prd-post">
      <div className="row wrap">
        <label><span className="small muted">掲示</span>
          <span className="row">
            <input type="date" value={v.postFrom} disabled={disabled} aria-label="掲示の始まり" onChange={(e) => setV({ ...v, postFrom: e.target.value })} />
            〜
            <input type="date" value={v.postTo} disabled={disabled} aria-label="掲示の終わり" onChange={(e) => setV({ ...v, postTo: e.target.value })} />
          </span>
        </label>
        <label><span className="small muted">置き場所</span>
          <input value={v.place} maxLength={PRINT_LIMITS.placeMax} disabled={disabled} placeholder="入口・レジ横など" onChange={(e) => setV({ ...v, place: e.target.value })} />
        </label>
      </div>
      <div className="row wrap">
        {changed && <button className="btn small" disabled={disabled} onClick={() => onSave({ postFrom: v.postFrom || null, postTo: v.postTo || null, place: v.place })}>保存</button>}
        {(state === 'posted' || state === 'ended') && <button className="btn ghost small" disabled={disabled} onClick={onRemoved}>外した</button>}
      </div>
    </div>
  );
}

/** 作り直す（「今年の日付で」）。新しい物を作って開く。 */
function RemakeBox({ disabled, onRemake }: { disabled: boolean; onRemake: (instruction: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return (
    <details className="prd-remake">
      <summary>これを元に作り直す</summary>
      <div className="row wrap">
        <input value={text} maxLength={500} disabled={disabled} placeholder="例: 今年の日付で" aria-label="作り直すときに変えること" onChange={(e) => setText(e.target.value)} />
        <button className="btn ghost small" disabled={disabled} onClick={() => void onRemake(text.trim())}>作り直す</button>
      </div>
    </details>
  );
}

/** 版（3 案も版）。押すとその版に戻す。 */
function Versions({ d, versions, currentId, disabled, onChoose }: {
  d: PrintDesign; versions: PrintVersion[]; currentId: string | null; disabled: boolean; onChoose: (v: PrintVersion) => void;
}) {
  if (!currentId || versions.length < 2) return null;
  return (
    <details className="prd-versions">
      <summary>版 {versions.length}</summary>
      <ul>
        {[...versions].reverse().map((v) => (
          <li key={v.id} className={v.id === currentId ? 'is-current' : ''}>
            <img src={api.printDesigns.fileUrl(d.id, v.id, 'preview')} alt="" loading="lazy" />
            <span className="small">
              {v.proposal ? `案（${v.no}）` : `${v.no}`}{v.instruction ? `　${v.instruction}` : ''}
              <span className="muted">　{timeLabel(v.createdAt)}</span>
            </span>
            {v.id === currentId ? <span className="badge ok">いまの版</span>
              : <button className="btn ghost small" disabled={disabled} onClick={() => onChoose(v)}>この版に戻す</button>}
          </li>
        ))}
      </ul>
    </details>
  );
}
