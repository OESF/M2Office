/**
 * @file サイトの更新の画面（仕様書 第45.3節・第45.8節・第45.15節）。つないでいるサイト（名前・URL・利用者・直せるか）、
 * 直した記録（いつ・どのページを・どう直したか・結果）と、元に戻す。
 *
 * 直し案は秘書に頼んで作る。画面にページの一覧と編集の欄は作らない（WordPress の管理画面をまねない。原則 u11、ADR-0028）。
 * 元に戻すのもサイトに出すことなので、押すと承認へ進む。説明文は常に出さない。
 */

import { useCallback, useEffect, useState } from 'react';
import { SITE_EDIT_PAGE_RESULT_LABELS, SITE_EDIT_STATUS_LABELS, type SiteEditView } from '@m2office/shared';
import { Busy } from './components.js';
import { api, describeError } from './api.js';

const timeLabel = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

type Site = Awaited<ReturnType<typeof api.siteUpdates.site>>;

/** つないでいるサイト。開いたときに WordPress に問い合わせた結果を出す。 */
function SiteCard({ site }: { site: Site | null }) {
  if (!site) return <div className="card site-card"><Busy>サイトを確かめています…</Busy></div>;
  if (!site.connected) {
    return (
      <div className="card site-card">
        <p className="error small">WordPress がつながっていません。管理者ページの「接続 › WordPress」でつなぎます</p>
      </div>
    );
  }
  const ok = site.missing !== null && site.missing.length === 0;
  return (
    <div className="card site-card">
      <div className="row wrap">
        <strong>{site.name ?? '（サイトの名前を読めませんでした）'}</strong>
        <span className={ok ? 'badge' : 'badge warn'}>{ok ? '直せます' : site.missing ? '権限が足りません' : '確かめられません'}</span>
      </div>
      {site.description && <p className="small muted">{site.description}</p>}
      {site.siteUrl && <p className="small"><a href={site.siteUrl} target="_blank" rel="noreferrer">{site.siteUrl}</a></p>}
      {site.account && (
        <p className="small muted">
          {site.account.kind === 'user' ? 'あなたの WordPress の利用者' : '会社の WordPress の利用者'}: {site.account.displayName ?? site.account.username}
          {site.account.displayName && site.account.displayName !== site.account.username ? `（${site.account.username}）` : ''}
          {site.account.roles.length > 0 ? `・${site.account.roles.join('・')}` : ''}
        </p>
      )}
      {site.types.length > 0 && <p className="small muted">記事の種類: {site.types.map((t) => (t.restBase === 'posts' || t.restBase === 'pages' ? t.name : `${t.name}（${t.restBase}）`)).join('・')}</p>}
      {site.missing && site.missing.length > 0 && (
        <p className="small error">固定ページと記事を直す権限がありません（{site.missing.join('・')}）。WordPress で、この利用者を「編集者」にしてください</p>
      )}
      {site.problem && <p className="small error">{site.problem}</p>}
    </div>
  );
}

/** 直し 1 件。 */
function EditRow({ edit, busy, onRevert }: { edit: SiteEditView; busy: boolean; onRevert: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="site-edit">
      <div className="row">
        <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {edit.revertOf ? '元に戻す: ' : ''}{edit.pages.map((p) => p.title || p.link).slice(0, 3).join('・') || (edit.actions.length ? '記事と固定ページ' : '') || (edit.terms.length ? 'サイトのカテゴリーとタグ' : '') || edit.request}
        </button>
        <span className={edit.status === 'failed' || edit.status === 'partial' ? 'badge warn' : 'badge'}>{SITE_EDIT_STATUS_LABELS[edit.status]}</span>
        <span className="small muted">{timeLabel(edit.appliedAt ?? edit.createdAt)}</span>
        {edit.revertible && <button type="button" className="btn ghost small" disabled={busy} onClick={() => onRevert(edit.id)}>元に戻す</button>}
      </div>
      {open && (
        <div className="site-edit-detail">
          <p className="small">{edit.request}</p>
          <p className="small muted">{edit.account.kind === 'user' ? 'あなたの' : '会社の'} WordPress の利用者（{edit.account.username}）で直しました</p>
          {edit.purged && <p className="small muted">直す前と後の文は消しました</p>}
          {edit.actions.length > 0 && (
            <ul className="site-edit-terms small">
              {edit.actions.map((a, i) => (
                <li key={i}>
                  {a.link && a.result === 'applied' ? <a href={a.link} target="_blank" rel="noreferrer">{a.text || '（内容は消しました）'}</a> : (a.text || '（内容は消しました）')}
                  <span className="muted">・{SITE_EDIT_PAGE_RESULT_LABELS[a.result]}</span>
                  {a.reason && <span className="error">（{a.reason}）</span>}
                </li>
              ))}
            </ul>
          )}
          {edit.terms.length > 0 && (
            <ul className="site-edit-terms small">
              {edit.terms.map((c, i) => (
                <li key={i}>
                  {c.text || '（内容は消しました）'}<span className="muted">・{SITE_EDIT_PAGE_RESULT_LABELS[c.result]}</span>
                  {c.reason && <span className="error">（{c.reason}）</span>}
                </li>
              ))}
            </ul>
          )}
          {edit.pages.map((p) => (
            <div key={`${p.kind}:${p.wpId}`} className="site-edit-page">
              <div className="row">
                {p.link ? <a href={p.link} target="_blank" rel="noreferrer">{p.title || p.link}</a> : <span>{p.title}</span>}
                <span className="small muted">{SITE_EDIT_PAGE_RESULT_LABELS[p.result]}</span>
              </div>
              {p.reason && <p className="small error">{p.reason}</p>}
              {p.changes.length > 0 && (
                <table className="table site-edit-changes">
                  <thead><tr><th>直す前</th><th>直した後</th></tr></thead>
                  <tbody>
                    {p.changes.map((c, i) => (
                      <tr key={i}><td>{c.before || '（足した）'}</td><td>{c.after || '（消した）'}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** サイトの更新の画面。 */
export function SiteUpdates({ changeKey }: {
  /** 秘書が直し案を作った・入れたたびに変わる値。変わったら読み直す。 */
  changeKey: string;
}) {
  const [items, setItems] = useState<SiteEditView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [site, setSite] = useState<Site | null>(null);

  // つないでいるサイトは、開いたときに 1 度だけ確かめる（WordPress に問い合わせるため）
  useEffect(() => {
    api.siteUpdates.site().then(setSite).catch((e) => {
      setSite({ connected: true, siteUrl: null, account: null, name: null, description: null, missing: null, types: [], problem: describeError(e, 'つないでいるサイトを確かめられませんでした') });
    });
  }, []);

  const load = useCallback(() => {
    api.siteUpdates.list().then((r) => setItems(r.items)).catch((e) => setError(describeError(e, 'サイトの直しの記録を読めませんでした')));
  }, []);
  useEffect(() => { load(); }, [load, changeKey]);

  const revert = async (id: string) => {
    setBusy(true); setError(null); setNote(null);
    try {
      await api.siteUpdates.revert(id);
      setNote('元に戻す案を作り、承認へ進めました。承認すると直す前の文に戻ります');
      load();
    } catch (e) {
      setError(describeError(e, '元に戻せませんでした'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SiteCard site={site} />
      <div className="card">
        {!items && !error && <Busy>読み込んでいます…</Busy>}
        {note && <p className="ok-msg small">{note}</p>}
        {error && <p className="error small">{error}</p>}
        {items && items.length === 0 && <p className="muted">まだ直したページはありません</p>}
        {items && items.length > 0 && <ul className="site-edits">{items.map((e) => <EditRow key={e.id} edit={e} busy={busy} onRevert={(id) => void revert(id)} />)}</ul>}
      </div>
    </>
  );
}
