/**
 * @file Web のコラムの画面（仕様書 第32.18.1節・第32.18.2節）。一覧・書く・カバー画像・直す・赤入れ・書き直しを頼む・版・承認へ進む・写す。
 *
 * 「コラムを書く」でテーマと取材メモを入れると、裏で書き上げる（書いている間は読み直して待つ）。
 * 直して保存するたびに新しい版になり、赤入れをやり直す。承認へ進めたら承認トレイで責任者が承認し、
 * WordPress に下書きとして入る（WordPress につないでいなければ承認済みになり、本文を写して使う）。
 * 説明文は常には出さない（原則 u11）。分からなければ秘書に聞けばよい。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { COLUMN_COVER_KIND_LABELS, WEB_COLUMN_STATUS_LABELS, type ColumnReviewItem, type WebColumn, type WebColumnStatus, type WebColumnVersion } from '@m2office/shared';
import { api, describeError, type ColumnDetail } from './api.js';
import { Markdown } from './help.js';

/** 書いている間に読み直す間隔（ミリ秒）。 */
const POLL_MS = 4000;

/** 版の出どころの呼び方。 */
const ORIGIN_LABELS: Record<WebColumnVersion['origin'], string> = {
  writer: 'AI が書いた', rewrite: 'AI が書き直した', edit: '直した', suggestion: '直し案に置き換えた', restore: '前の版に戻した', cover: 'カバーを作り直した',
};

/** 指摘の種類の呼び方。 */
const KIND_LABELS: Record<ColumnReviewItem['kind'], string> = {
  expression: '表現', source: '出典', privacy: '個人の情報', readability: '読みやすさ',
};

const STATUS_BADGE: Record<WebColumnStatus, string> = {
  writing: 'badge', draft: 'badge', awaiting: 'badge warn', approved: 'badge ok', placed: 'badge ok', failed: 'badge danger',
};

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

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
  const [writing, setWriting] = useState(false);
  const [theme, setTheme] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.columns.list().then((r) => { setColumns(r.columns); setError(null); }).catch((e) => setError(describeError(e, '読めませんでした')));
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

  return (
    <div className="columns">
      <div className="cards-toolbar">
        <button className={writing ? 'btn' : 'btn ghost'} onClick={() => setWriting(!writing)}>コラムを書く</button>
      </div>
      {writing && (
        <div className="columns-new">
          <div className="field"><label>テーマ</label>
            <input value={theme} maxLength={200} placeholder="子どもの歯みがきのコツ" autoFocus onChange={(e) => setTheme(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && theme.trim() && !e.nativeEvent.isComposing) void create(); }} />
          </div>
          <div className="field"><label>取材メモ</label>
            <textarea rows={4} value={memo} maxLength={4000} placeholder="お客様によく聞かれること、うちで工夫していること など" onChange={(e) => setMemo(e.target.value)} />
          </div>
          <div className="row">
            <button className="btn" disabled={busy || !theme.trim()} onClick={() => void create()}>書く</button>
            <button className="btn ghost" onClick={() => setWriting(false)}>やめる</button>
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

/** 1 つのコラム。直す・赤入れ・書き直しを頼む・版・承認へ進む・写す。 */
function ColumnEditor({ id, onBack, onApprovals }: { id: string; onBack: () => void; onApprovals: () => void }) {
  const [detail, setDetail] = useState<ColumnDetail | null>(null);
  const [draft, setDraft] = useState<{ title: string; body: string; description: string; short: string; long: string } | null>(null);
  const [tab, setTab] = useState<'edit' | 'view'>('edit');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [covering, setCovering] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.columns.get(id);
      setDetail(d);
      const v = d.versions[0];
      setDraft(v ? { title: v.title, body: v.body, description: v.description, short: v.sns.short, long: v.sns.long } : null);
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e, '読めませんでした') });
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // 書いている間は、書き上がるまで読み直す
  useEffect(() => {
    if (detail?.column.status !== 'writing') return;
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [detail, load]);

  if (!detail) return <div className="columns">{message && <p className="error">{message.text}</p>}</div>;
  const { column, versions } = detail;
  const current = versions[0] ?? null;
  const dirty = !!current && !!draft && (draft.title !== current.title || draft.body !== current.body || draft.description !== current.description
    || draft.short !== current.sns.short || draft.long !== current.sns.long);
  const locked = column.status === 'awaiting' || column.status === 'writing';

  /** 操作して読み直す。失敗したら理由を出す。 */
  const act = async (fn: () => Promise<unknown>, ok: string | null, fail: string) => {
    setBusy(true);
    try {
      await fn();
      setMessage(ok ? { kind: 'ok', text: ok } : null);
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e, fail) });
    } finally {
      setBusy(false);
    }
  };
  const save = () => draft && act(() => api.columns.save(id, {
    title: draft.title, body: draft.body, description: draft.description, sns: { short: draft.short, long: draft.long },
  }), '保存しました', '保存できませんでした');
  const submit = async () => {
    setBusy(true);
    try {
      await api.columns.submit(id);
      onApprovals();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e, '承認へ進められませんでした') });
      setBusy(false);
    }
  };
  const copy = async (kind: 'html' | 'markdown') => {
    try {
      const e = await api.columns.exported(id);
      await navigator.clipboard.writeText(kind === 'html' ? e.html : e.markdown);
      setMessage({ kind: 'ok', text: kind === 'html' ? 'HTML を写しました' : 'Markdown を写しました' });
    } catch (err) {
      setMessage({ kind: 'error', text: describeError(err, '写せませんでした') });
    }
  };
  /** カバーを作り直す・写真を入れる。AI の挿絵は時間がかかるため、作っている間は知らせる。 */
  const cover = async (fn: () => Promise<unknown>) => {
    setCovering(true);
    await act(fn, null, 'カバーを作れませんでした');
    setCovering(false);
  };
  const remove = () => {
    if (!confirm(`「${column.title || column.theme}」を削除しますか？`)) return;
    void act(() => api.columns.remove(id), null, '削除できませんでした').then(onBack);
  };

  return (
    <div className="columns">
      <div className="cards-toolbar">
        <button className="btn ghost small" onClick={onBack}>一覧に戻る</button>
        <span className={STATUS_BADGE[column.status]}>{WEB_COLUMN_STATUS_LABELS[column.status]}</span>
        {column.wpEditUrl && <a className="btn ghost small" href={column.wpEditUrl} target="_blank" rel="noreferrer">WordPress で開く</a>}
        {current && <button className="btn ghost small" onClick={() => void copy('html')}>HTML を写す</button>}
        {current && <button className="btn ghost small" onClick={() => void copy('markdown')}>Markdown を写す</button>}
        {(column.status === 'draft' || column.status === 'failed') && <button className="btn ghost small danger" disabled={busy} onClick={remove}>削除</button>}
      </div>

      {column.status === 'writing' && <p className="muted">「{column.theme}」を書いています…</p>}
      {column.status === 'failed' && (
        <div className="row">
          <p className="error">{column.failure ?? '書けませんでした'}</p>
          <button className="btn small" disabled={busy} onClick={() => void act(() => api.columns.retry(id), null, '書き直せませんでした')}>もう一度書く</button>
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
                {covering ? '作っています…' : current.cover ? 'カバーを作り直す' : 'カバーを作る'}
              </button>
              <button className="btn ghost small" disabled={busy || locked || dirty} onClick={() => photoInput.current?.click()}>写真を入れる</button>
              <input ref={photoInput} type="file" accept="image/jpeg,image/png" hidden
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void cover(() => api.columns.addPhoto(id, f)); }} />
              {current.cover && (
                <button className="btn ghost small" onClick={() => void api.columns.downloadCover(id, current.title)
                  .catch((err) => setMessage({ kind: 'error', text: describeError(err, '書き出せませんでした') }))}>画像を書き出す</button>
              )}
            </div>
          </div>
          <div className="row columns-tabs">
            <button className={tab === 'edit' ? 'btn small' : 'btn ghost small'} onClick={() => setTab('edit')}>直す</button>
            <button className={tab === 'view' ? 'btn small' : 'btn ghost small'} onClick={() => setTab('view')}>見え方</button>
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
              <div className="field"><label>SNS の告知（短い）</label>
                <input value={draft.short} maxLength={200} disabled={locked} onChange={(e) => setDraft({ ...draft, short: e.target.value })} />
              </div>
              <div className="field"><label>SNS の告知（長い）</label>
                <textarea rows={3} value={draft.long} maxLength={600} disabled={locked} onChange={(e) => setDraft({ ...draft, long: e.target.value })} />
              </div>
              <div className="row">
                <button className="btn" disabled={busy || locked || !dirty} onClick={() => void save()}>保存</button>
                {dirty && <button className="btn ghost" disabled={busy} onClick={() => setDraft({ title: current.title, body: current.body, description: current.description, short: current.sns.short, long: current.sns.long })}>直したのをやめる</button>}
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

          <h3>赤入れ {current.review.length > 0 && <span className="badge warn">{current.review.length}</span>}</h3>
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
                      <button className="btn ghost small" disabled={busy || locked || dirty} onClick={() => void act(() => api.columns.applySuggestion(id, i), null, '置き換えられませんでした')}>直し案に置き換える</button>
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
              onClick={() => void act(() => api.columns.rewrite(id, instruction.trim()), '書き直しました', '書き直せませんでした').then(() => setInstruction(''))}>書き直しを頼む</button>
          </div>

          {message && <p className={message.kind === 'ok' ? 'ok-msg' : 'error'}>{message.text}</p>}
          <div className="row">
            {column.status === 'awaiting'
              ? <button className="btn ghost" onClick={onApprovals}>承認トレイを開く</button>
              : <button className="btn" disabled={busy || dirty || (column.status === 'placed' && column.submittedVersion === column.currentVersion) || column.status === 'approved' && column.submittedVersion === column.currentVersion}
                onClick={() => void submit()}>{detail.wordpress ? '承認へ進む（WordPress の下書きに入れる）' : '承認へ進む'}</button>}
          </div>

          <button className="link small" onClick={() => setShowVersions(!showVersions)}>{showVersions ? '版を閉じる' : `版（${versions.length}）`}</button>
          {showVersions && (
            <table className="table small columns-versions">
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version}>
                    <td>第 {v.version} 版</td>
                    <td>{ORIGIN_LABELS[v.origin]}</td>
                    <td>{v.createdByName}</td>
                    <td>{when(v.createdAt)}</td>
                    <td>{v.version !== column.currentVersion && (
                      <button className="link" disabled={busy || locked || dirty} onClick={() => void act(() => api.columns.restore(id, v.version), `第 ${v.version} 版に戻しました`, '戻せませんでした')}>この版に戻す</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {!current && message && <p className={message.kind === 'ok' ? 'ok-msg' : 'error'}>{message.text}</p>}
    </div>
  );
}
