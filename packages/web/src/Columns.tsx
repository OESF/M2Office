/**
 * @file Web のコラムの画面（仕様書 第32.18.1節・第32.18.2節）。一覧・書く・カバー画像・直す・赤入れ・書き直しを頼む・版・承認へ進む・写す。
 *
 * 「コラムを書く」でテーマとリクエスト（記事と画像の希望）を入れると、裏で書き上げる（書いている間は読み直して待つ）。
 * 直して保存するたびに新しい版になり、赤入れをやり直す。承認へ進めたら承認トレイで責任者が承認し、
 * WordPress に下書きとして入る（WordPress につないでいなければ承認済みになり、本文をコピーして使う）。
 * 説明文は常には出さない（原則 u11）。分からなければ秘書に聞けばよい。
 */

import { copyText } from './clipboard.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COLUMN_COVER_KIND_LABELS, COLUMN_THEME_SOURCE_LABELS, WEB_COLUMN_STATUS_LABELS,
  type ColumnPlanSlot, type ColumnReviewItem, type WebColumn, type WebColumnStatus, type WebColumnTheme, type WebColumnVersion,
} from '@m2office/shared';
import { api, describeError, type ColumnDetail } from './api.js';
import { Markdown } from './help.js';

/**
 * 開いた一覧を画面の中まで送る（ref に渡す。開いた所が画面の外で、開いたことに気づかないのを防ぐ）。
 * モジュールの関数にして同じものを渡し続けるため、送るのは開いたときの 1 回だけ。
 */
function reveal(el: HTMLElement | null): void {
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 結果の知らせを出す所（押したボタンの近く）。 */
type Spot = 'top' | 'cover' | 'edit' | 'review' | 'rewrite' | 'submit' | 'versions';

/** 書いている間に読み直す間隔（ミリ秒）。 */
const POLL_MS = 4000;

/** 版の出どころの呼び方。 */
const ORIGIN_LABELS: Record<WebColumnVersion['origin'], string> = {
  writer: 'AI が書いた', rewrite: 'AI が書き直した', edit: '直した', suggestion: '直し案に置き換えた', restore: '前の版に戻した', cover: '画像を変えた',
};

/** 指摘の種類の呼び方。 */
const KIND_LABELS: Record<ColumnReviewItem['kind'], string> = {
  expression: '表現', source: '出典', privacy: '個人の情報', readability: '読みやすさ',
};

const STATUS_BADGE: Record<WebColumnStatus, string> = {
  writing: 'badge', draft: 'badge', awaiting: 'badge warn', approved: 'badge ok', scheduled: 'badge ok', placed: 'badge ok', withdrawn: 'badge', failed: 'badge danger',
};

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** datetime-local の欄の値（端末の時刻）。 */
const toLocalInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

/**
 * Web のコラムの画面。
 *
 * @param columnId 開いているコラム（無ければ一覧）
 * @param onOpen コラムを開く・一覧に戻る（`null`）
 * @param onApprovals 承認へ進めた後（承認トレイへ移る）
 */
export function Columns({ columnId, onOpen, onApprovals }: {
  columnId: string | null;
  onOpen: (columnId: string | null) => void;
  onApprovals: () => void;
}) {
  return columnId
    ? <ColumnEditor key={columnId} id={columnId} onBack={() => onOpen(null)} onApprovals={onApprovals} />
    : <ColumnList onOpen={(id) => onOpen(id)} />;
}

/** コラムの一覧と「コラムを書く」。 */
function ColumnList({ onOpen }: { onOpen: (id: string) => void }) {
  const [columns, setColumns] = useState<WebColumn[] | null>(null);
  // テーマ案と予定表（段 2。第32.18.4節）
  const [themes, setThemes] = useState<WebColumnTheme[]>([]);
  const [plan, setPlan] = useState<ColumnPlanSlot[]>([]);
  const [themeNote, setThemeNote] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [theme, setTheme] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.columns.list().then((r) => { setColumns(r.columns); setThemes(r.themes ?? []); setPlan(r.plan ?? []); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
  }, []);
  useEffect(load, [load]);
  // 書いているコラムがあれば、書き上がるまで読み直す
  useEffect(() => {
    if (!columns?.some((c) => c.status === 'writing')) return;
    const t = setTimeout(load, POLL_MS);
    return () => clearTimeout(t);
  }, [columns, load]);

  const create = async () => {
    setBusy(true);
    try {
      const { id } = await api.columns.create(theme.trim(), memo.trim());
      setTheme(''); setMemo(''); setWriting(false);
      onOpen(id);
    } catch (e) {
      setError(describeError(e, '書き始められませんでした'));
    } finally {
      setBusy(false);
    }
  };

  const makeThemes = async () => {
    setBusy(true);
    try {
      const r = await api.columns.makeThemes();
      setThemeNote(r.added.length ? null : '新しいテーマ案はありませんでした');
      load();
    } catch (e) {
      setError(describeError(e, 'テーマ案を作れませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const writeTheme = async (t: WebColumnTheme) => {
    setBusy(true);
    try {
      const { columnId } = await api.columns.writeTheme(t.id);
      onOpen(columnId);
    } catch (e) {
      setError(describeError(e, '書き始められませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = (t: WebColumnTheme) => {
    api.columns.dismissTheme(t.id).then(load).catch((e) => setError(describeError(e, '見送りにできませんでした')));
  };
  const slotDay = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日（${'日月火水木金土'[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;

  return (
    <div className="columns">
      <div className="cards-toolbar">
        <button className={writing ? 'btn' : 'btn ghost'} onClick={() => setWriting(!writing)}>コラムを書く</button>
        <button className="btn ghost" disabled={busy} onClick={() => void makeThemes()}>テーマ案を出す</button>
        {themeNote && <span className="muted small">{themeNote}</span>}
      </div>
      {!writing && themes.length > 0 && (
        <div className="card columns-themes">
          <h3>テーマ案</h3>
          <ul>
            {themes.map((t) => (
              <li key={t.id}>
                <span className="badge">{COLUMN_THEME_SOURCE_LABELS[t.source]}</span> <strong>{t.theme}</strong>
                {t.why && <span className="muted small">　{t.why}</span>}
                <span className="row">
                  <button className="btn small" disabled={busy} onClick={() => void writeTheme(t)}>{t.columnId ? '書き直しを頼む' : '書く'}</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => dismiss(t)}>見送り</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!writing && plan.length > 0 && (
        <div className="card columns-plan">
          <h3>予定表</h3>
          <table className="table">
            <tbody>
              {plan.map((s) => (
                <tr key={s.date}>
                  <td className="small">{slotDay(s.date)}</td>
                  <td>{s.columnId ? <button className="link" onClick={() => onOpen(s.columnId!)}>{s.title || '（書いています）'}</button> : <span className="muted">空き</span>}</td>
                  <td>{s.status && <span className={STATUS_BADGE[s.status]}>{WEB_COLUMN_STATUS_LABELS[s.status]}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {writing && (
        <div className="columns-new">
          <div className="field"><label>テーマ</label>
            <input value={theme} maxLength={200} placeholder="子どもの歯みがきのコツ" autoFocus onChange={(e) => setTheme(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && theme.trim() && !e.nativeEvent.isComposing) void create(); }} />
          </div>
          <div className="field"><label>リクエスト</label>
            <textarea rows={4} value={memo} maxLength={4000} placeholder="お客様によく聞かれること、うちで工夫していること、画像は明るいパステル画のように など" onChange={(e) => setMemo(e.target.value)} />
          </div>
          <div className="row">
            <button className="btn" disabled={busy || !theme.trim()} onClick={() => void create()}>書く</button>
            <button className="btn ghost" onClick={() => setWriting(false)}>キャンセル</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {columns && columns.length === 0 && !writing && <p className="muted">まだコラムがありません。</p>}
      {columns && columns.length > 0 && !writing && (
        <table className="table columns-list">
          <thead><tr><th>題名</th><th>状態</th><th>指摘</th><th>書いた人</th><th>更新</th></tr></thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => onOpen(c.id)}>
                <td><button className="link" onClick={(e) => { e.stopPropagation(); onOpen(c.id); }}>{c.title || c.theme}</button></td>
                <td><span className={STATUS_BADGE[c.status]}>{WEB_COLUMN_STATUS_LABELS[c.status]}</span></td>
                <td>{c.status === 'writing' || c.status === 'failed' ? '' : c.reviewCount}</td>
                <td>{c.createdByName}</td>
                <td className="small">{when(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 1 つのコラム。直す・赤入れ・書き直しを頼む・版・承認へ進む・コピー。結果の知らせは押したボタンの横に出す。 */
function ColumnEditor({ id, onBack, onApprovals }: { id: string; onBack: () => void; onApprovals: () => void }) {
  const [detail, setDetail] = useState<ColumnDetail | null>(null);
  const [draft, setDraft] = useState<{ title: string; body: string; description: string; short: string; long: string } | null>(null);
  const [tab, setTab] = useState<'edit' | 'view'>('edit');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  // 結果の知らせは、押したボタンの近くに出す（画面の下に出すと気付きにくい）。うまくいった知らせは少しで消す
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; at: Spot } | null>(null);
  useEffect(() => {
    if (message?.kind !== 'ok') return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);
  const note = (at: Spot) => (message?.at === at
    ? <span className={`columns-note is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</span> : null);
  const [showVersions, setShowVersions] = useState(false);
  const [covering, setCovering] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.columns.get(id);
      setDetail(d);
      const v = d.versions[0];
      setDraft(v ? { title: v.title, body: v.body, description: v.description, short: v.sns.short, long: v.sns.long } : null);
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e, '読めませんでした'), at: 'top' });
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // 書いている間は、書き上がるまで読み直す
  useEffect(() => {
    if (detail?.column.status !== 'writing') return;
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [detail, load]);

  if (!detail) return <div className="columns">{note('top')}</div>;
  const { column, versions } = detail;
  const current = versions[0] ?? null;
  const dirty = !!current && !!draft && (draft.title !== current.title || draft.body !== current.body || draft.description !== current.description
    || draft.short !== current.sns.short || draft.long !== current.sns.long);
  const locked = column.status === 'awaiting' || column.status === 'writing';
  // 前に作った画像（新しい順。いまの画像と同じものは除き、同じ画像は 1 つにする）
  const past = (() => {
    const seen = new Set<string>(current?.cover ? [current.cover.fileId] : []);
    return versions.flatMap((v) => {
      if (!v.cover || seen.has(v.cover.fileId)) return [];
      seen.add(v.cover.fileId);
      return [{ version: v.version, cover: v.cover }];
    });
  })();

  /** 操作して読み直す。失敗したら理由を出す。 */
  const act = async (fn: () => Promise<unknown>, ok: string | null, fail: string, at: Spot) => {
    setBusy(true);
    try {
      await fn();
      setMessage(ok ? { kind: 'ok', text: ok, at } : null);
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e, fail), at });
    } finally {
      setBusy(false);
    }
  };
  const save = () => draft && act(() => api.columns.save(id, {
    title: draft.title, body: draft.body, description: draft.description, sns: { short: draft.short, long: draft.long },
  }), '保存しました', '保存できませんでした', 'edit');
  const submit = async () => {
    setBusy(true);
    try {
      await api.columns.submit(id);
      onApprovals();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e, '承認へ進められませんでした'), at: 'submit' });
      setBusy(false);
    }
  };
  const copy = async (kind: 'html' | 'markdown') => {
    try {
      const e = await api.columns.exported(id);
      const ok = await copyText(kind === 'html' ? e.html : e.markdown);
      setMessage(ok ? { kind: 'ok', text: kind === 'html' ? 'HTML をコピーしました' : 'Markdown をコピーしました', at: 'top' }
        : { kind: 'error', text: 'コピーできませんでした。ブラウザーがクリップボードへの書き込みを許していません', at: 'top' });
    } catch (err) {
      setMessage({ kind: 'error', text: describeError(err, 'コピーできませんでした'), at: 'top' });
    }
  };
  /** 画像を再作成・ファイルから選択。AI 作成の画像は時間がかかるため、作っている間は知らせる。 */
  const cover = async (fn: () => Promise<unknown>, ok = '画像を再作成しました') => {
    setCovering(true);
    await act(fn, ok, '画像を作れませんでした', 'cover');
    setCovering(false);
  };
  const remove = () => {
    if (!confirm(`「${column.title || column.theme}」を削除しますか？`)) return;
    void act(() => api.columns.remove(id), null, '削除できませんでした', 'top').then(onBack);
  };

  return (
    <div className="columns">
      <div className="cards-toolbar">
        <button className="btn ghost small" onClick={onBack}>一覧に戻る</button>
        <span className={STATUS_BADGE[column.status]}>{WEB_COLUMN_STATUS_LABELS[column.status]}</span>
        {column.wpEditUrl && <a className="btn ghost small" href={column.wpEditUrl} target="_blank" rel="noreferrer">WordPress で開く</a>}
        {current && <button className="btn ghost small" onClick={() => void copy('html')}>HTML をコピー</button>}
        {current && <button className="btn ghost small" onClick={() => void copy('markdown')}>Markdown をコピー</button>}
        {(column.status === 'draft' || column.status === 'failed') && <button className="btn ghost small danger" disabled={busy} onClick={remove}>削除</button>}
        {(column.status === 'approved' || column.status === 'scheduled' || column.status === 'placed') && (
          <button className="btn ghost small" disabled={busy}
            onClick={() => { if (confirm(`「${column.title || column.theme}」を取り下げますか？`)) void act(() => api.columns.withdraw(id), '取り下げました', '取り下げられませんでした', 'top'); }}>取り下げ</button>
        )}
        {note('top')}
      </div>
      {/* 公開の日時（予約。第32.18.4節）。下書きのときだけ直せる */}
      {(column.status === 'draft' || column.status === 'scheduled' || column.publishAt) && (
        <div className="row small columns-publish">
          <span>公開の日時</span>
          {column.status === 'draft'
            ? (
              <>
                <input type="datetime-local" value={column.publishAt ? toLocalInput(column.publishAt) : ''} disabled={busy}
                  onChange={(e) => { if (e.target.value) void act(() => api.columns.setPublishAt(id, new Date(e.target.value).toISOString()), null, '公開の日時を入れられませんでした', 'top'); }} />
                {column.publishAt && <button className="btn ghost small" disabled={busy} onClick={() => void act(() => api.columns.setPublishAt(id, null), null, '外せませんでした', 'top')}>外す</button>}
              </>
            )
            : <strong>{column.publishAt ? when(column.publishAt) : '—'}</strong>}
          {column.plannedFor && <span className="muted">予定表の回</span>}
        </div>
      )}

      {/* 公開されたコラムの数字（この 28 日。Webの分析を使っているとき。第34.19節） */}
      {detail?.webMetrics && (
        <p className="small columns-metrics">
          {Number(detail.webMetrics.start.slice(5, 7))} 月 {Number(detail.webMetrics.start.slice(8))} 日〜{Number(detail.webMetrics.end.slice(5, 7))} 月 {Number(detail.webMetrics.end.slice(8))} 日:
          {' '}見られた回数 {detail.webMetrics.views ?? '—'} 回
          {detail.webMetrics.readSeconds !== null && <>・読まれた時間の平均 {detail.webMetrics.readSeconds} 秒</>}
          {detail.webMetrics.searchClicks !== null && <>・検索で押された回数 {detail.webMetrics.searchClicks} 回（表示 {detail.webMetrics.searchImpressions ?? 0} 回）</>}
          {detail.webMetrics.queries.length > 0 && <>・主な検索の言葉: {detail.webMetrics.queries.join('、')}</>}
        </p>
      )}
      {column.status === 'writing' && <p className="muted">「{column.theme}」を書いています…</p>}
      {column.status === 'failed' && (
        <div className="row">
          <p className="error">{column.failure ?? '書けませんでした'}</p>
          <button className="btn small" disabled={busy} onClick={() => void act(() => api.columns.retry(id), null, '書き直せませんでした', 'top')}>もう一度書く</button>
        </div>
      )}

      {current && draft && (
        <>
          <div className="columns-cover">
            {current.cover
              ? <img src={api.columns.coverUrl(id, current.cover.fileId)} alt={current.cover.alt} />
              : <div className="columns-cover-empty muted">{covering ? 'カバーを作っています…' : 'カバーがありません'}</div>}
            <div className="columns-cover-side">
              {current.cover && <span className="badge">{COLUMN_COVER_KIND_LABELS[current.cover.kind]}</span>}
              {current.cover?.note && <span className="small muted">{current.cover.note}</span>}
              <button className="btn ghost small" disabled={busy || locked || dirty} onClick={() => void cover(() => api.columns.recover(id))}>
                {covering ? '作っています…' : current.cover ? '画像を再作成' : '画像を作成'}
              </button>
              <button className="btn ghost small" disabled={busy || locked || dirty} onClick={() => photoInput.current?.click()}>ファイルから選択</button>
              <input ref={photoInput} type="file" accept="image/jpeg,image/png" hidden
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void cover(() => api.columns.addPhoto(id, f), '画像を変えました'); }} />
              {current.cover && (
                <button className="btn ghost small" onClick={() => void api.columns.downloadCover(id, current.title)
                  .catch((err) => setMessage({ kind: 'error', text: describeError(err, '書き出せませんでした'), at: 'cover' }))}>画像を書き出す</button>
              )}
              {past.length > 0 && (
                <button className="link small" onClick={() => setShowPast(!showPast)}>{showPast ? '以前の画像を閉じる' : `以前の画像（${past.length}）`}</button>
              )}
              {note('cover')}
            </div>
          </div>
          {/* 前に作った画像（第32.18.2節）。選ぶとその画像に戻る（本文はいまのまま、新しい版になる） */}
          {showPast && past.length > 0 && (
            <div className="columns-past" ref={reveal}>
              {past.map((p) => (
                <figure key={p.cover.fileId}>
                  <img src={api.columns.coverUrlOf(id, p.version)} alt={p.cover.alt} loading="lazy" />
                  <figcaption className="small">
                    <span className="muted">第 {p.version} 版・{COLUMN_COVER_KIND_LABELS[p.cover.kind]}</span>
                    <button className="btn ghost small" disabled={busy || locked || dirty}
                      onClick={() => void cover(() => api.columns.useCover(id, p.cover.fileId), '前の画像に戻しました').then(() => setShowPast(false))}>この画像に戻す</button>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          <div className="row columns-tabs">
            <button className={tab === 'edit' ? 'btn small' : 'btn ghost small'} onClick={() => setTab('edit')}>編集</button>
            <button className={tab === 'view' ? 'btn small' : 'btn ghost small'} onClick={() => setTab('view')}>プレビュー</button>
          </div>
          {tab === 'edit' ? (
            <div className="columns-edit">
              <div className="field"><label>題名</label>
                <input value={draft.title} maxLength={200} disabled={locked} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                {current.titles.length > 1 && (
                  <div className="row wrap small">
                    {current.titles.filter((t) => t !== draft.title).map((t) => (
                      <button key={t} className="link" disabled={locked} onClick={() => setDraft({ ...draft, title: t })}>{t}</button>
                    ))}
                  </div>
                )}
              </div>
              <div className="field"><label>本文</label>
                <textarea rows={18} value={draft.body} disabled={locked} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                <span className="small muted">{draft.body.replace(/\s/g, '').length.toLocaleString('ja-JP')} 字</span>
              </div>
              <div className="field"><label>説明文</label>
                <textarea rows={2} value={draft.description} maxLength={300} disabled={locked} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </div>
              {/* SNS の告知文をコピー（公開の URL が分かれば末尾に足す。第32.18.4節） */}
              <div className="row small">
                <button className="btn ghost small" disabled={!draft.short} onClick={() => void copyText(detail?.publicUrl ? `${draft.short} ${detail.publicUrl}` : draft.short)}>短い文をコピー</button>
                <button className="btn ghost small" disabled={!draft.long} onClick={() => void copyText(detail?.publicUrl ? `${draft.long}\n${detail.publicUrl}` : draft.long)}>長い文をコピー</button>
              </div>
              <div className="field"><label>SNS の告知（短い）</label>
                <input value={draft.short} maxLength={200} disabled={locked} onChange={(e) => setDraft({ ...draft, short: e.target.value })} />
              </div>
              <div className="field"><label>SNS の告知（長い）</label>
                <textarea rows={3} value={draft.long} maxLength={600} disabled={locked} onChange={(e) => setDraft({ ...draft, long: e.target.value })} />
              </div>
              <div className="row">
                <button className="btn" disabled={busy || locked || !dirty} onClick={() => void save()}>保存</button>
                {dirty && <button className="btn ghost" disabled={busy} onClick={() => setDraft({ title: current.title, body: current.body, description: current.description, short: current.sns.short, long: current.sns.long })}>キャンセル</button>}
                {note('edit')}
              </div>
            </div>
          ) : (
            <article className="columns-view">
              <h2>{draft.title}</h2>
              <Markdown text={draft.body} />
              {current.sources.length > 0 && (
                <>
                  <h3>出典</h3>
                  <ol className="small">{current.sources.map((x) => <li key={x.url}><a href={x.url} target="_blank" rel="noreferrer">{x.title || x.url}</a></li>)}</ol>
                </>
              )}
            </article>
          )}

          <h3>赤入れ {current.review.length > 0 && <span className="badge warn">{current.review.length}</span>} {note('review')}</h3>
          {current.review.length === 0 ? <p className="small muted">指摘はありません。</p> : (
            <ul className="columns-review">
              {current.review.map((r, i) => (
                <li key={`${i}-${r.quote}`}>
                  <div className="small"><span className="badge">{KIND_LABELS[r.kind]}</span>{r.by === 'ai' && <span className="badge">AI</span>}</div>
                  {r.quote && <blockquote>{r.quote}</blockquote>}
                  <div>{r.reason}</div>
                  {r.quote && r.suggestion && (
                    <div className="row small">
                      <span>直し案: {r.suggestion}</span>
                      <button className="btn ghost small" disabled={busy || locked || dirty} onClick={() => void act(() => api.columns.applySuggestion(id, i), '直し案に置き換えました', '置き換えられませんでした', 'review')}>直し案に置き換える</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="row columns-rewrite">
            <input value={instruction} maxLength={1000} placeholder="もっと短く／高齢の方にも分かるように" disabled={locked} aria-label="書き直しの指示"
              onChange={(e) => setInstruction(e.target.value)} />
            <button className="btn ghost" disabled={busy || locked || dirty || !instruction.trim()}
              onClick={() => void act(() => api.columns.rewrite(id, instruction.trim()), '書き直しました', '書き直せませんでした', 'rewrite').then(() => setInstruction(''))}>書き直しを頼む</button>
            {note('rewrite')}
          </div>

          <div className="row">
            {column.status === 'awaiting'
              ? <button className="btn ghost" onClick={onApprovals}>承認トレイを開く</button>
              : <button className="btn" disabled={busy || dirty || (column.status === 'placed' && column.submittedVersion === column.currentVersion) || column.status === 'approved' && column.submittedVersion === column.currentVersion}
                onClick={() => void submit()}>{detail.wordpress ? '承認へ進む（WordPress の下書きに入れる）' : '承認へ進む'}</button>}
            {note('submit')}
          </div>

          <div className="row">
            <button className="link small" onClick={() => setShowVersions(!showVersions)}>{showVersions ? '版を閉じる' : `版（${versions.length}）`}</button>
            {note('versions')}
          </div>
          {showVersions && (
            <table className="table small columns-versions" ref={reveal}>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version}>
                    <td>第 {v.version} 版</td>
                    <td>{ORIGIN_LABELS[v.origin]}</td>
                    <td>{v.createdByName}</td>
                    <td>{when(v.createdAt)}</td>
                    <td>{v.version !== column.currentVersion && (
                      <button className="link" disabled={busy || locked || dirty} onClick={() => void act(() => api.columns.restore(id, v.version), `第 ${v.version} 版に戻しました`, '戻せませんでした', 'versions')}>この版に戻す</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

    </div>
  );
}
