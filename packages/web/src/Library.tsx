/**
 * @file ナレッジの整理の画面（仕様書 第44.3節・第44.4節・第44.7節）。新しい順の一覧と絞り込み・ファイルやフォルダをドラッグして入れる・ドライブで選ぶ・
 * メールの添付の取り込みの入り切り／1 件の題名などを直す・もう一度読む・削除。読み取りの途中はときどき読み直す。
 *
 * 人に整理をさせない（ADR-0028）。読めなかった資料は「読めなかった」と示す。途切れても、同じファイルを入れ直せば続きから入る（同じ中身は入れ直さない）。
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  isRefusedLibraryName, LIBRARY_ENTRY_LABELS, LIBRARY_FORMAT_LABELS, LIBRARY_LIMITS, LIBRARY_SHARE_LABELS, libraryTitleOf,
  type LibraryEntry, type LibraryFacets, type LibraryItemPage, type LibraryItemView, type LibraryGraph, type LibraryMailState, type LibraryProgress, type LibraryShareScope,
} from '@m2office/shared';
import { api, ApiError, describeError } from './api.js';
import { BackButton } from './back-button.js';
import { pickDriveFiles } from './google-picker.js';

/** フォルダを選べるか（スマホのブラウザはフォルダを選べないので、選択肢に出さない）。 */
const canPickFolder = typeof window === 'undefined' || !window.matchMedia?.('(pointer: coarse)').matches;

/** つながりの画面（グラフ）。開いたときだけ読み込む（第44.17.2節）。 */
const LibraryGraphView = lazy(() => import('./LibraryGraph.js'));

/** 入れるファイル 1 つ。 */
interface QueuedFile { file: File; folder: string }

/** 同時に送る数。 */
const PARALLEL = 3;
/** 件数がこれ以下なら、先に中身を確かめず、そのまま送る（サーバーで同じ中身をまとめる）。 */
const CHECK_OVER = 20;
/** 通信や Google の一時的な失敗のやり直しで待つ時間。 */
const RETRY_WAIT_MS = [2000, 6000, 15000];

const dayLabel = (d: string) => d.slice(0, 10).replace(/-/g, '/');
const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ドラッグされたものからファイルを集める。フォルダは中まで読み、元のフォルダの名前を手がかりに残す。 */
async function filesFromDrop(e: DragEvent): Promise<QueuedFile[]> {
  // 非同期の処理に入る前に、入口を取っておく（イベントの後は読めなくなる）
  const entries = Array.from(e.dataTransfer.items).map((i) => i.webkitGetAsEntry?.() ?? null);
  const plain = Array.from(e.dataTransfer.files);
  if (entries.every((x) => !x)) return plain.map((file) => ({ file, folder: '' }));
  const out: QueuedFile[] = [];
  const walk = async (entry: FileSystemEntry, folder: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, folder });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const next = folder ? `${folder}/${entry.name}` : entry.name;
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, next);
    }
  };
  for (const entry of entries) if (entry) await walk(entry, '');
  return out;
}

/** 中身のハッシュ（暗号の口が無い環境では `null`）。 */
async function sha256Of(file: File): Promise<string | null> {
  if (!crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 資料の画面（一覧か 1 件）。 */
export function Library({ itemId, onOpen, changeKey }: {
  itemId: string | null;
  onOpen: (itemId: string | null) => void;
  /** 秘書が資料を操作し終えるたびに変わる値。変わったら読み直す。 */
  changeKey: string;
}) {
  return itemId
    ? <LibraryDetail key={itemId} id={itemId} onBack={() => onOpen(null)} onOpen={(id) => onOpen(id)} />
    : <LibraryList onOpen={onOpen} changeKey={changeKey} />;
}

/** 取り込みの進み具合。 */
interface Upload { total: number; done: number; same: number; failed: { name: string; why: string }[]; skipped: number; running: boolean; checking: boolean }

function LibraryList({ onOpen, changeKey }: { onOpen: (id: string) => void; changeKey: string }) {
  const [items, setItems] = useState<(LibraryItemView & { why: string[] })[] | null>(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<LibraryFacets>({ tags: [], years: [] });
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const [google, setGoogle] = useState(true);
  const [picker, setPicker] = useState(false);
  const [q, setQ] = useState('');
  /** 絞り込むタグ（全部を持つ資料に絞る。第44.17.3節）と、入力の途中の文字。 */
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [year, setYear] = useState('');
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [confirm, setConfirm] = useState<{ queue: QueuedFile[]; jpy: number | null } | null>(null);
  const [view, setView] = useState<'list' | 'graph'>(() => { try { return localStorage.getItem('m2office.libraryView') === 'graph' ? 'graph' : 'list'; } catch { return 'list'; } });
  const [graph, setGraph] = useState<LibraryGraph | null>(null);
  const cancelled = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const addMenu = useRef<HTMLDetailsElement>(null);
  // 「入れる」の選択肢は、外を押すか Esc で閉じる
  useEffect(() => {
    const close = (e: MouseEvent) => { if (addMenu.current?.open && !addMenu.current.contains(e.target as Node)) addMenu.current.removeAttribute('open'); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && addMenu.current?.open) { addMenu.current.removeAttribute('open'); addMenu.current.querySelector('summary')?.focus(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, []);

  const filter = useCallback(() => ({
    ...(q.trim() ? { q: q.trim() } : {}), ...(tags.length ? { tags: tags.join('\n') } : {}), ...(year ? { year } : {}),
    ...(entry ? { entry } : {}),
  }), [q, tags, year, entry]);
  const addTag = (t: string) => { const v = t.trim(); if (v && !tags.includes(v)) setTags([...tags, v]); setTagInput(''); };

  const load = useCallback(() => {
    api.library.list(filter())
      .then((r) => { setItems(r.items); setTotal(r.total); setFacets(r.facets); setProgress(r.progress); setGoogle(r.google); setPicker(r.picker); setError(null); })
      .catch((e) => setError(describeError(e, '読めませんでした')));
  }, [filter]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  // つながりの画面は、絞り込みが変わるたびに読み直す
  useEffect(() => {
    try { localStorage.setItem('m2office.libraryView', view); } catch { /* 覚えられなくても動く */ }
    if (view !== 'graph') return undefined;
    const t = setTimeout(() => {
      api.library.graph(filter() as Record<string, string>).then(setGraph).catch((e) => setError(describeError(e, 'つながりを読めませんでした')));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [view, filter, q, changeKey]);
  useEffect(() => { if (changeKey) load(); }, [changeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 裏で読んでいる間は、ときどき読み直す
  const reading = (progress?.pending ?? 0) > 0 && !progress?.blocked;
  useEffect(() => {
    if (!reading) return undefined;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [reading, load]);
  // 取り込みの途中で閉じようとしたら止める
  const uploading = !!upload?.running;
  useEffect(() => {
    if (!uploading) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  const more = () => {
    api.library.list({ ...filter(), offset: String(items?.length ?? 0) })
      .then((r) => { setItems((cur) => [...(cur ?? []), ...r.items]); setTotal(r.total); })
      .catch((e) => setError(describeError(e, '読めませんでした')));
  };

  /** 入れる前に数える。多いときだけ費用の目安を確かめる（第44.11節）。 */
  const begin = async (raw: QueuedFile[]) => {
    const queue = raw.filter((q) => !isRefusedLibraryName(q.file.name));
    const refused = raw.length - queue.length;
    if (queue.length === 0) {
      setUpload({ total: 0, done: 0, same: 0, failed: [], skipped: refused, running: false, checking: false });
      return;
    }
    if (queue.length > LIBRARY_LIMITS.confirmCount) {
      const est = await api.library.estimate(queue.length).catch(() => ({ jpy: null }));
      setConfirm({ queue, jpy: est.jpy });
      return;
    }
    await run(queue, refused);
  };

  /** 1 つ送る。一時的な失敗は少し待ってやり直す。 */
  const sendOne = async (q: QueuedFile, u: Upload) => {
    for (let attempt = 0; ; attempt++) {
      if (cancelled.current) return;
      try {
        const r = await api.library.upload(q.file, q.folder);
        if (r.duplicate) u.same += 1; else u.done += 1;
        return;
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        const temporary = status === 0 || status === 429 || status >= 500;
        if (temporary && attempt < RETRY_WAIT_MS.length) { await wait(RETRY_WAIT_MS[attempt]!); continue; }
        u.failed.push({ name: q.file.name, why: describeError(e, '入れられませんでした') });
        return;
      }
    }
  };

  /** 取り込みの本体。多いときは先に中身を確かめ、もう入っているものは送らない（途切れても続きから入る）。 */
  const run = async (all: QueuedFile[], refused: number) => {
    cancelled.current = false;
    const u: Upload = { total: all.length, done: 0, same: 0, failed: [], skipped: refused, running: true, checking: all.length > CHECK_OVER };
    const show = () => setUpload({ ...u, failed: [...u.failed] });
    show();
    let queue = all.filter((q) => {
      if (q.file.size <= LIBRARY_LIMITS.placeBytes) return true;
      u.failed.push({ name: q.file.name, why: '100 MB を超えています' });
      return false;
    });
    if (all.length > CHECK_OVER) {
      const rest: QueuedFile[] = [];
      for (let i = 0; i < queue.length && !cancelled.current; i += 100) {
        const part = queue.slice(i, i + 100);
        const hashes = await Promise.all(part.map((q) => sha256Of(q.file).catch(() => null)));
        const known = new Set(await api.library.check(hashes.filter((h): h is string => !!h)).catch(() => [] as string[]));
        part.forEach((q, k) => {
          if (hashes[k] && known.has(hashes[k]!)) u.same += 1;
          else rest.push(q);
        });
        show();
      }
      queue = rest;
    }
    u.checking = false;
    show();
    let at = 0;
    const worker = async () => {
      while (!cancelled.current && at < queue.length) {
        const q = queue[at++]!;
        await sendOne(q, u);
        show();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    u.running = false;
    show();
    load();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (upload?.running || !google) return;
    void filesFromDrop(e).then(begin).catch(() => setError('ファイルを読み取れませんでした'));
  };

  /** ドライブで選ぶ（第44.3節）。ファイルは動かさない。 */
  const fromDrive = async () => {
    setError(null);
    try {
      const p = await api.library.drivePicker();
      if (p.kind === 'mock') {
        const first = p.items[0];
        if (first) await api.library.fromDrive(first.id);
      } else {
        const chosen = await pickDriveFiles(p);
        for (const f of chosen) await api.library.fromDrive(f.id);
      }
      load();
    } catch (e) {
      setError(describeError(e, 'ドライブから選べませんでした'));
    }
  };

  const filtered = !!(q.trim() || tags.length || year || entry);
  const left = upload ? upload.total - upload.done - upload.same - upload.failed.length : 0;
  return (
    <div className={`library${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      {!google && <p className="error">資料のファイルは本人の Google ドライブに置きます。個人設定の「Google 連携」で接続してください。</p>}
      <div className="row wrap library-entry">
        {/* 入れ方は 1 つのボタンにまとめる（ブラウザはファイルとフォルダを同じ選ぶ画面で選べないため、押してから選ぶ）。ドラッグでも入れられる */}
        <details className={`library-add${!google ? ' is-disabled' : ''}`} ref={addMenu}>
          <summary className="btn" aria-disabled={!google} onClick={(e) => { if (!google) e.preventDefault(); }}>入れる</summary>
          <div className="library-add-menu" role="menu" onClick={() => addMenu.current?.removeAttribute('open')}>
            <button role="menuitem" disabled={!!upload?.running} onClick={() => fileInput.current?.click()}>ファイル</button>
            {canPickFolder && <button role="menuitem" disabled={!!upload?.running} onClick={() => folderInput.current?.click()}>フォルダ</button>}
            {picker && <button role="menuitem" onClick={() => void fromDrive()}>ドライブから選ぶ</button>}
          </div>
        </details>
        <input ref={fileInput} type="file" hidden multiple
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) void begin(fs.map((file) => ({ file, folder: '' }))); }} />
        <input ref={folderInput} type="file" hidden multiple {...({ webkitdirectory: '' } as object)}
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (fs.length) void begin(fs.map((file) => ({ file, folder: file.webkitRelativePath.split('/').slice(0, -1).join('/') })));
          }} />
      </div>

      <MailIntake google={google} onImported={load} />

      {confirm && (
        <div className="card library-confirm" role="alertdialog" aria-label="取り込みの確かめ">
          <p>{confirm.queue.length.toLocaleString('ja-JP')} 件を取り込みます。{confirm.jpy !== null ? `AI の費用の目安は約 ${confirm.jpy.toLocaleString('ja-JP')} 円です。` : ''}</p>
          <div className="row">
            <button className="btn" onClick={() => { const c = confirm; setConfirm(null); void run(c.queue, 0); }}>取り込む</button>
            <button className="btn ghost" onClick={() => setConfirm(null)}>キャンセル</button>
          </div>
        </div>
      )}

      {upload && (
        <div className="library-upload" role="status">
          {upload.running && <progress max={upload.total} value={upload.total - left} aria-label="取り込みの進み具合" />}
          <span className="small">
            {upload.running
              ? `${upload.checking ? '確かめています' : '入れています'}（${(upload.total - left).toLocaleString('ja-JP')} / ${upload.total.toLocaleString('ja-JP')} 件）`
              : `${upload.done.toLocaleString('ja-JP')} 件を入れました`}
            {upload.same > 0 && `。同じものが ${upload.same.toLocaleString('ja-JP')} 件ありました`}
            {upload.skipped > 0 && `。資料でない ${upload.skipped.toLocaleString('ja-JP')} 件は入れません`}
            {upload.failed.length > 0 && `。${upload.failed.length.toLocaleString('ja-JP')} 件は入れられませんでした`}
          </span>
          {upload.running
            ? <button className="btn ghost small" onClick={() => { cancelled.current = true; }}>キャンセル</button>
            : <button className="btn ghost small" onClick={() => setUpload(null)}>閉じる</button>}
          {upload.failed.length > 0 && (
            <ul className="small library-failed">
              {upload.failed.slice(0, 20).map((f, i) => <li key={i}>{f.name}（{f.why}）</li>)}
              {upload.failed.length > 20 && <li>ほか {upload.failed.length - 20} 件</li>}
            </ul>
          )}
        </div>
      )}

      {progress?.blocked && <p className="small muted" role="status">{progress.blocked === 'platform'
        ? '中身を読むには会社の Gemini の鍵が要ります（管理者ページの「接続」）。名前と種類では探せます。'
        : '中身を読むには AI の接続が要ります（管理者ページの「接続」）。名前と種類では探せます。'}</p>}
      {(progress?.paused ?? 0) > 0 && <p className="small muted" role="status">会社の AI の利用の上限に達したため、{progress!.paused.toLocaleString('ja-JP')} 件の中身を読むのを止めています。名前と種類では探せます。</p>}
      {reading && <p className="small muted" role="status">中身を読んでいます（残り {progress!.pending.toLocaleString('ja-JP')} 件）</p>}

      <div className="row wrap library-filter">
        <div className="library-view" role="group" aria-label="見せ方">
          <button className={view === 'list' ? 'btn small' : 'btn ghost small'} aria-pressed={view === 'list'} onClick={() => setView('list')}>一覧</button>
          <button className={view === 'graph' ? 'btn small' : 'btn ghost small'} aria-pressed={view === 'graph'} onClick={() => setView('graph')}>つながり</button>
        </div>
        <input className="library-search" type="search" value={q} placeholder="探す（取引先・案件・品名など）" aria-label="探す" maxLength={LIBRARY_LIMITS.queryChars} onChange={(e) => setQ(e.target.value)} />
        <div className="library-tag-filter">
          {tags.map((t) => <button key={t} className="library-tag on" aria-label={`タグ「${t}」を外す`} onClick={() => setTags(tags.filter((x) => x !== t))}>{t} ×</button>)}
          <input list="library-tag-options" value={tagInput} placeholder="タグ" aria-label="タグで絞り込む" maxLength={LIBRARY_LIMITS.tagChars}
            onChange={(e) => { const v = e.target.value; if (facets.tags.includes(v)) addTag(v); else setTagInput(v); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && tagInput.trim()) { e.preventDefault(); addTag(facets.tags.find((t) => t.toLowerCase() === tagInput.trim().toLowerCase()) ?? tagInput); } }} />
          <datalist id="library-tag-options">{facets.tags.filter((t) => !tags.includes(t)).map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        <select value={year} aria-label="年" onChange={(e) => setYear(e.target.value)}>
          <option value="">年: すべて</option>
          {facets.years.map((v) => <option key={v} value={v}>{v} 年</option>)}
        </select>
        <select value={entry} aria-label="入口" onChange={(e) => setEntry(e.target.value)}>
          <option value="">入口: すべて</option>
          {(Object.keys(LIBRARY_ENTRY_LABELS) as LibraryEntry[]).map((k) => <option key={k} value={k}>{LIBRARY_ENTRY_LABELS[k]}</option>)}
        </select>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {/* ドラッグしている間は、一覧の上に小さな帯で示す（落とすのは画面のどこでもよい） */}
      {dragging && <div className="library-drop" aria-hidden="true">ここに入れる</div>}
      {view === 'graph' && graph && (graph.shown === 0
        ? <p className="muted">{filtered ? '当たる資料はありません。' : 'まだ資料がありません。'}</p>
        : <>
          {graph.total > graph.shown && <p className="small muted" role="status">新しい {graph.shown.toLocaleString('ja-JP')} 件を描いています（全 {graph.total.toLocaleString('ja-JP')} 件）。絞り込むと、その範囲を描きます</p>}
          <Suspense fallback={<p className="muted">読み込んでいます…</p>}><LibraryGraphView graph={graph} onOpen={onOpen} onOpenFile={(id) => void api.library.opened(id)} /></Suspense>
        </>)}
      {view === 'list' && items && items.length === 0 && (
        filtered
          ? <p className="muted">当たる資料はありません。</p>
          : !dragging && <div className="library-empty"><p>ここにファイルかフォルダをドラッグしてください</p></div>
      )}
      {view === 'list' && items && items.length > 0 && (
        <ul className="library-list">
          {items.map((i) => (
            <li key={i.id}>
              <button className="library-row" onClick={() => onOpen(i.id)}>
                <span className="library-row-head">
                  <span className="library-title">{libraryTitleOf(i)}</span>
                  <span className="badge">{LIBRARY_FORMAT_LABELS[i.format]}</span>
                  {i.readState === 'unreadable' && <span className="badge warn">読めなかった</span>}
                  {i.readState === 'too_large' && <span className="badge warn">大きいため読まず</span>}
                  {(i.readState === 'pending' || i.readState === 'paused') && <span className="badge">読む前</span>}
                  {!i.mine && <span className="badge">共有: {i.ownerName ?? '同じ会社の人'}</span>}
                  {i.mine && i.shareScope !== 'self' && <span className="badge">{LIBRARY_SHARE_LABELS[i.shareScope]}</span>}
                  {i.mine && i.viewedAt && <span className="badge">確認済み</span>}
                </span>
                <span className="library-meta small muted">
                  {[dayLabel(i.docDate ?? i.receivedAt), LIBRARY_ENTRY_LABELS[i.entry]].filter(Boolean).join(' ・ ')}
                </span>
                {i.summary && <span className="library-summary small">{i.summary}</span>}
                {i.why.length > 0 && <span className="library-why small muted">{i.why.join('・')}</span>}
              </button>
              {i.tags.length > 0 && (
                <div className="library-row-tags">
                  {i.tags.map((t) => <button key={t} className={tags.includes(t) ? 'library-tag on' : 'library-tag'} onClick={() => addTag(t)}>{t}</button>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {view === 'list' && items && items.length < total && <button className="btn ghost small" onClick={more}>続きを見る（残り {(total - items.length).toLocaleString('ja-JP')} 件）</button>}
    </div>
  );
}

/** メールの取り込みの様子（添付とやり取り。画面に出す形）。 */
type MailView = LibraryMailState & { gmail: boolean };

/** 取り込みの途中に様子を読み直す間隔。 */
const MAIL_POLL_MS = 30_000;

/**
 * メールの取り込み（第44.4節・第44.18節）。本人が 1 度入れれば、受け取ったメールの添付と、仕事のやり取りの要約を自動で集める。切ればすぐ止まる。
 * 件数が多いときだけ、入れる前に費用の目安を確かめる（第44.11節。お金に関わるため）。
 */
function MailIntake({ google, onImported }: { google: boolean; onImported: () => void }) {
  const [state, setState] = useState<MailView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ which: 'start' | 'extend'; messages: number; threads: number; jpy: number } | null>(null);
  const imported = useRef<number | null>(null);

  const show = useCallback((s: MailView) => {
    setState(s);
    // 新しく入ったら一覧を読み直す
    const total = s.imported + (s.threads?.kept ?? 0);
    if (imported.current !== null && total > imported.current) onImported();
    imported.current = total;
  }, [onImported]);
  const load = useCallback(() => {
    api.library.mail.get().then(show).catch((e) => setError(describeError(e, 'メールの取り込みの様子を読めませんでした')));
  }, [show]);
  useEffect(load, [load]);
  const working = !!state?.enabled && (!state.backDone || (!!state.threads && !state.threads.backDone && !state.threads.waiting));
  useEffect(() => {
    if (!working) return undefined;
    const t = setInterval(load, MAIL_POLL_MS);
    return () => clearInterval(t);
  }, [working, load]);

  const act = async (fn: () => Promise<MailView>) => {
    setBusy(true);
    setError(null);
    try { show(await fn()); } catch (e) { setError(describeError(e, '変えられませんでした')); } finally { setBusy(false); }
  };
  /** 入れる・広げる前に、件数が多ければ費用の目安を確かめる。 */
  const begin = async (which: 'start' | 'extend') => {
    const est = await api.library.mail.estimate(which).catch(() => null);
    if (est?.confirm && est.costJpy !== null) { setConfirm({ which, messages: est.messages ?? 0, threads: est.threads ?? 0, jpy: est.costJpy }); return; }
    await act(which === 'start' ? () => api.library.mail.set(true) : api.library.mail.extend);
  };

  if (!state) return error ? <p className="error" role="alert">{error}</p> : null;
  const from = state.backFrom ? dayLabel(new Date(state.backFrom).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })) : '';
  const ready = google && state.gmail;
  const t = state.threads;
  const kept = (state.imported + (t?.kept ?? 0)).toLocaleString('ja-JP');
  const done = state.backDone && (!t || t.backDone);
  return (
    <div className="library-mail">
      <label className="switch-label">
        <span>メールを集める</span>
        <button type="button" role="switch" aria-checked={state.enabled} aria-label={state.enabled ? 'メールを集めるのをやめる' : 'メールを集める'}
          className={state.enabled ? 'switch on' : 'switch'} disabled={busy || (!ready && !state.enabled)}
          onClick={() => void (state.enabled ? act(() => api.library.mail.set(false)) : begin('start'))}><span /></button>
      </label>
      {state.enabled && (
        <span className="small muted" role="status">
          {done
            ? `${from} 以降のメールを見終えました。${kept} 件を入れました`
            : `${from} 以降のメールを見ています（${(state.scanned + (t?.scanned ?? 0)).toLocaleString('ja-JP')} 件を見て、${kept} 件を入れました）`}
        </span>
      )}
      {state.enabled && done && <button className="btn ghost small" disabled={busy} onClick={() => void begin('extend')}>さらに 1 年さかのぼる</button>}
      {!ready && <p className="small error library-mail-note">Gmail とドライブを読む許可がありません。個人設定の「Google 連携」で接続し直してください。</p>}
      {state.enabled && state.error && <p className="small error library-mail-note" role="alert">Gmail を読めませんでした（{state.error}）</p>}
      {error && <p className="small error library-mail-note" role="alert">{error}</p>}
      {state.enabled && t?.waiting && (
        <div className="card library-confirm library-mail-note" role="alertdialog" aria-label="過去のやり取りの取り込みの確かめ">
          <p>直近 1 年のやり取りが約 {(t.waiting.threads ?? 0).toLocaleString('ja-JP')} 件あります。AI の費用の目安は約 {(t.waiting.costJpy ?? 0).toLocaleString('ja-JP')} 円です。</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void act(api.library.mail.startThreads)}>入れる</button>
          </div>
        </div>
      )}
      {confirm && (
        <div className="card library-confirm library-mail-note" role="alertdialog" aria-label="メールの取り込みの確かめ">
          <p>{confirm.which === 'start' ? '直近 1 年' : 'さらに 1 年前'}に、添付のあるメールが約 {confirm.messages.toLocaleString('ja-JP')} 通、やり取りが約 {confirm.threads.toLocaleString('ja-JP')} 件あります。AI の費用の目安は約 {confirm.jpy.toLocaleString('ja-JP')} 円です。</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => { const c = confirm; setConfirm(null); void act(c.which === 'start' ? () => api.library.mail.set(true) : api.library.mail.extend); }}>集める</button>
            <button className="btn ghost" onClick={() => setConfirm(null)}>キャンセル</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 1 件。題名などを直す・開く・もう一度読む・削除・共有・会社の知識（持ち主だけ）。共有された資料は見るだけ。 */
function LibraryDetail({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (id: string) => void }) {
  const [item, setItem] = useState<LibraryItemPage | null>(null);
  const [form, setForm] = useState({ title: '', tags: '', docDate: '' });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.library.get(id).then((i) => {
      setItem(i);
      setForm({ title: libraryTitleOf(i), tags: i.tags.join('、'), docDate: i.docDate ?? '' });
      setError(null);
    }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, [id]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      setNote(done);
    } catch (e) {
      setError(describeError(e, 'できませんでした'));
    }
    setBusy(false);
  };

  const save = () => {
    if (!item?.mine) return;
    const patch: Record<string, string | null> = {};
    // タグは「、」で区切って直す（API が整える）
    if (form.tags !== item.tags.join('、')) patch['tags'] = form.tags;
    if (form.title.trim() !== libraryTitleOf(item)) patch['title'] = form.title;
    if (form.docDate !== (item.docDate ?? '')) patch['docDate'] = form.docDate || null;
    if (Object.keys(patch).length === 0) return;
    void act(async () => { await api.library.update(id, patch); load(); }, '直しました');
  };

  if (error && !item) return <div><BackButton label="資料の一覧へ" onClick={onBack} /><p className="error" role="alert">{error}</p></div>;
  if (!item) return <p className="muted">読み込んでいます…</p>;
  const mine = item.mine;
  // メールのやり取りの資料（第44.18節）。本人だけのもので、共有しない。開くのは Gmail
  const thread = item.format === 'mail';
  return (
    <div className="library-detail">
      <BackButton label="資料の一覧へ" onClick={onBack} />
      <div className="row wrap library-actions">
        {/* 本人が実際の資料を開いたら、確かめた記録にする（第44.16.1節） */}
        {item.driveUrl && <a className="btn" href={item.driveUrl} target="_blank" rel="noreferrer" onClick={() => { if (item.mine && !thread) void api.library.opened(item.id).then(load); }}>{thread ? 'メールを開く' : '開く'}</a>}
        {mine && !thread && <button className="btn ghost" disabled={busy} onClick={() => void act(async () => { await api.library.reread(id); load(); }, 'もう一度読みます')}>もう一度読む</button>}
        {mine && (item.knowledgeId
          ? <span className="badge">会社の知識</span>
          : <button className="btn ghost" disabled={busy || (!item.driveFileId && !thread)} onClick={() => void act(async () => { await api.library.knowledge(id); load(); }, '会社の知識にしました。全員の秘書が参照できます')}>会社の知識にする</button>)}
        {mine && <button className="btn ghost danger" disabled={busy} onClick={() => {
          const text = thread
            ? 'このやり取りを目録から削除しますか。メールは Gmail に残り、同じやり取りはもう入れません。'
            : item.placed
              ? 'この資料を削除しますか。ドライブのファイルはごみ箱へ移ります。'
              : 'この資料を目録から削除しますか。ドライブのファイルはそのまま残ります。';
          if (window.confirm(text)) void act(async () => { await api.library.remove(id); onBack(); }, '削除しました');
        }}>削除</button>}
      </div>
      {!mine && <p className="small muted" role="status">{item.ownerName ?? '同じ会社の人'}さんが共有した資料です</p>}
      {note && <p className="small" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {(item.readState === 'unreadable' || item.readState === 'too_large') && <p className="small" role="status"><span className="badge warn">読めなかった</span> {item.readNote}</p>}
      {(item.readState === 'pending' || item.readState === 'paused') && <p className="small muted" role="status">まだ中身を読んでいません。</p>}
      {mine && !thread && <ShareBox item={item} onChanged={load} />}
      <div className="card library-form">
        <label>題名<input value={form.title} readOnly={!mine} maxLength={LIBRARY_LIMITS.titleChars} onChange={(e) => setForm({ ...form, title: e.target.value })} onBlur={save} /></label>
        <label>タグ<input value={form.tags} readOnly={!mine} maxLength={(LIBRARY_LIMITS.tagChars + 1) * LIBRARY_LIMITS.tagCount} onChange={(e) => setForm({ ...form, tags: e.target.value })} onBlur={save} /></label>
        {!thread && <label>書類の日付<input type="date" value={form.docDate} readOnly={!mine} onChange={(e) => setForm({ ...form, docDate: e.target.value })} onBlur={save} /></label>}
      </div>
      {item.summary && <p>{item.summary}</p>}
      {item.keywords.length > 0 && <p className="small muted">{item.keywords.join('・')}</p>}
      {mine && item.related.length > 0 && (
        <div className="library-versions">
          <h3 className="small">関連する資料</h3>
          <ul className="library-mails">
            {item.related.map((r) => <li key={r.id}><button className="link-btn library-version-link" onClick={() => onOpen(r.id)}>{r.title}</button> <span className="small muted">{r.reason}</span></li>)}
          </ul>
          <LocalGraph id={item.id} onOpen={onOpen} />
        </div>
      )}
      <dl className="library-facts small">
        <dt>{thread ? '件名' : '元の名前'}</dt><dd>{item.originalName}</dd>
        {thread && item.thread ? (
          <>
            <dt>相手</dt><dd>{item.thread.people.join('、') || '—'}</dd>
            <dt>期間</dt><dd>{[item.thread.firstAt, item.thread.lastAt].filter((x): x is string => !!x).map((x) => dayLabel(new Date(x).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }))).filter((x, i, a) => a.indexOf(x) === i).join(' 〜 ')}（{item.thread.messages.toLocaleString('ja-JP')} 通）</dd>
          </>
        ) : (
          <>
            <dt>形式</dt><dd>{LIBRARY_FORMAT_LABELS[item.format]}{item.sizeBytes > 0 ? `（${sizeLabel(item.sizeBytes)}）` : ''}</dd>
            <dt>{item.entry === 'mail' ? '受け取った日' : '入れた日'}</dt><dd>{dayLabel(item.receivedAt)}</dd>
          </>
        )}
        {item.readScope && <><dt>読んだ範囲</dt><dd>{item.readScope}</dd></>}
        {mine && item.origins.some((o) => o.folder) && <><dt>元のフォルダ</dt><dd>{[...new Set(item.origins.map((o) => o.folder).filter(Boolean))].join('、')}</dd></>}
        {mine && !thread && item.origins.some((o) => o.entry === 'mail') && <><dt>届いたメール</dt><dd>
          <ul className="library-mails">
            {item.origins.filter((o) => o.entry === 'mail').map((o, i) => <li key={i}>{[o.sender, o.subject].filter(Boolean).join(' ・ ')}</li>)}
          </ul>
        </dd></>}
      </dl>
    </div>
  );
}

/** 1 件の画面の小さなグラフ（ローカルグラフ。その資料のまわり 2 歩先まで。第44.17.2節）。点を押すと、その資料を開く。 */
function LocalGraph({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const [graph, setGraph] = useState<LibraryGraph | null>(null);
  useEffect(() => { api.library.localGraph(id).then(setGraph).catch(() => setGraph(null)); }, [id]);
  if (!graph || graph.shown < 2) return null;
  return <Suspense fallback={null}><LibraryGraphView graph={graph} onOpen={onOpen} compact focusId={id} /></Suspense>;
}

/**
 * 共有の範囲（第44.8節）。選べば、そのまま共有する（確かめのボタンは足さない。ADR-0028）。共有した先の人数と、自分だけに戻す操作を示す。
 * 機微な資料は会社で共有の前に止め、理由を示す。もう一度押したときだけ共有する。
 */
function ShareBox({ item, onChanged }: { item: LibraryItemPage; onChanged: () => void }) {
  const [groups, setGroups] = useState<{ id: string; name: string; members: number }[] | null>(null);
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.library.groups().then(setGroups).catch(() => setGroups([])); }, []);

  const apply = async (scope: LibraryShareScope, groupIds: string[] = [], again = false) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.library.share(item.id, { scope, groupIds, again });
      setHeld(null);
      setResult(scope === 'self' ? '自分だけに戻しました' : `${r.people.toLocaleString('ja-JP')} 人に共有しました`);
      onChanged();
    } catch (e) {
      const why = e instanceof ApiError && typeof e.body['held'] === 'string' ? e.body['held'] : null;
      if (why) setHeld(why);
      else setError(describeError(e, '共有を変えられませんでした'));
    }
    setBusy(false);
  };

  const ready = !!item.driveFileId;
  return (
    <div className="card library-share">
      <span className="small">共有: {LIBRARY_SHARE_LABELS[item.shareScope]}{item.sharedGroups.length > 0 ? `（${item.sharedGroups.join('、')}）` : ''}</span>
      <div className="row wrap">
        <select value={groupId} aria-label="共有するグループ" disabled={busy || !ready} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">グループを選ぶ</option>
          {(groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}（{g.members} 人）</option>)}
        </select>
        <button className="btn ghost small" disabled={busy || !ready || !groupId} onClick={() => void apply('group', [groupId])}>グループに共有</button>
        <button className="btn ghost small" disabled={busy || !ready} onClick={() => void apply('company', [], !!held)}>{held ? 'それでも会社で共有' : '会社で共有'}</button>
        {item.shareScope !== 'self' && <button className="btn ghost small" disabled={busy} onClick={() => void apply('self')}>自分だけに戻す</button>}
      </div>
      {held && <p className="small error" role="alert">{held}</p>}
      {result && <p className="small" role="status">{result}</p>}
      {error && <p className="small error" role="alert">{error}</p>}
    </div>
  );
}
