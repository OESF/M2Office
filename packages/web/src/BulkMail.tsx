/**
 * @file 名刺の相手へのまとめてのメールの画面（仕様書 第27.9.1節、ADR-0058）。
 *
 * 宛先を探して（名刺の一覧で選んだ人・交換した日・検索の言葉）一覧で確かめ、予定していない人を 1 人ずつ外す。
 * 件名と本文を書き（`{会社名}`・`{氏名}` に宛名を差し込む）、1 人目に差し込んだ見本と除いた人の理由を見てから、承認へ進める。
 * 送るのは、承認トレイで本人が承認した後だけ。下書きは打ち終わりを待って保存し、そのたびに見本を読み直す。
 */

import { useEffect, useRef, useState } from 'react';
import { api, describeError, type BulkMailPreview, type CardSummary } from './api.js';

/** 宛先の候補（探して加えた名刺）。 */
interface Candidate {
  id: string;
  name: string;
  company: string;
  email: string;
  receivedOn: string | null;
  personal: boolean;
}

const toCandidate = (c: CardSummary): Candidate => ({
  id: c.id, name: c.name, company: c.company, email: c.emails[0] ?? '', receivedOn: c.lastReceivedOn, personal: c.scope === 'personal',
});

/**
 * まとめてのメールの画面。
 *
 * @param initial 名刺の一覧で選んだ名刺（はじめの宛先）
 * @param onClose 名刺の一覧に戻る
 * @param onSubmitted 承認へ進めた後（承認トレイへ移る）
 */
export function BulkMailView({ initial, onClose, onSubmitted }: {
  initial: CardSummary[];
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>(() => initial.map(toCandidate));
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initial.map((c) => c.id)));
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('{会社名}\n{氏名} 様\n\n');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkMailPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // 保存の順番が入れ替わらないよう、1 つずつ保存する
  const saving = useRef<Promise<void>>(Promise.resolve());

  // 打ち終わりを待って下書きを保存し、見本を読み直す
  useEffect(() => {
    const ids = candidates.filter((c) => chosen.has(c.id)).map((c) => c.id);
    if (!draftId && ids.length === 0) return;
    const t = setTimeout(() => {
      saving.current = saving.current.then(async () => {
        try {
          let id = draftId;
          if (!id) {
            id = (await api.cards.bulk.create({ contactIds: ids, subject, body })).id;
            setDraftId(id);
          } else {
            await api.cards.bulk.update(id, { contactIds: ids, subject, body });
          }
          setPreview(await api.cards.bulk.get(id));
          setMessage(null);
        } catch (e) {
          setMessage(describeError(e, '保存できませんでした'));
        }
      });
    }, 600);
    return () => clearTimeout(t);
  }, [candidates, chosen, subject, body, draftId]);

  /** 交換した日・検索の言葉で名刺を探し、見つかった人を宛先に加える。 */
  const search = async () => {
    if (!from && !to && !q.trim()) { setMessage('交換した日か、探す言葉を入れてください'); return; }
    setBusy(true);
    try {
      const r = await api.cards.list({ q: q.trim(), from: from || undefined, to: to || undefined });
      const found = r.items.map(toCandidate);
      setCandidates((cur) => [...cur, ...found.filter((f) => !cur.some((c) => c.id === f.id))]);
      setChosen((cur) => new Set([...cur, ...found.map((f) => f.id)]));
      setMessage(found.length === 0 ? '見つかりませんでした' : null);
    } catch (e) {
      setMessage(describeError(e, '探せませんでした'));
    } finally {
      setBusy(false);
    }
  };

  /** 本文のカーソルの位置に宛名を差し込む。 */
  const insert = (token: string) => {
    const el = bodyRef.current;
    if (!el) { setBody((b) => b + token); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  };

  const submit = async () => {
    if (!draftId) return;
    setBusy(true);
    try {
      await saving.current;
      await api.cards.bulk.update(draftId, { contactIds: candidates.filter((c) => chosen.has(c.id)).map((c) => c.id), subject, body });
      await api.cards.bulk.submit(draftId);
      onSubmitted();
    } catch (e) {
      setMessage(describeError(e, '承認へ進められませんでした'));
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (draftId && preview?.status === 'draft') await api.cards.bulk.remove(draftId).catch(() => undefined);
    onClose();
  };

  const excludedReason = (id: string) => preview?.excluded.find((x) => x.contactId === id)?.reason ?? null;
  const willSend = (id: string) => !!preview?.recipients.some((x) => x.contactId === id);
  const all = candidates.length > 0 && candidates.every((c) => chosen.has(c.id));
  const sendCount = preview?.recipients.length ?? 0;

  return (
    <div className="bulk-mail">
      <div className="cards-toolbar">
        <button className="btn ghost small" onClick={() => void cancel()}>名刺の一覧に戻る</button>
        <strong>まとめてメール</strong>
      </div>

      <h3>宛先</h3>
      <div className="cards-toolbar bulk-search">
        <label className="small">交換した日 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <span className="small">〜</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="交換した日の終わり" />
        <input type="search" className="cards-search" placeholder="会社名・氏名などで探す" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
        <button className="btn small" disabled={busy} onClick={() => void search()}>探して加える</button>
      </div>
      {candidates.length > 0 && (
        <>
          <div className="cards-toolbar">
            <label className="small check">
              <input type="checkbox" checked={all} onChange={() => setChosen(all ? new Set() : new Set(candidates.map((c) => c.id)))} /> すべて選ぶ
            </label>
            <span className="small">送る {sendCount} 人{preview && preview.excluded.length > 0 ? `／除く ${preview.excluded.length} 人` : ''}</span>
          </div>
          <table className="table bulk-recipients">
            <thead><tr><th aria-label="送る" /><th>氏名</th><th>会社名</th><th>メールアドレス</th><th>交換した日</th><th /></tr></thead>
            <tbody>
              {candidates.map((c) => {
                const on = chosen.has(c.id);
                const reason = on ? excludedReason(c.id) : null;
                return (
                  <tr key={c.id} className={!on || reason ? 'muted' : ''}>
                    <td>
                      <input type="checkbox" checked={on} aria-label={`${c.name || 'この人'}に送る`}
                        onChange={(e) => { const add = e.target.checked; setChosen((cur) => { const n = new Set(cur); if (add) n.add(c.id); else n.delete(c.id); return n; }); }} />
                    </td>
                    <td>{c.name || '（氏名なし）'}{c.personal && <span className="badge">自分だけ</span>}</td>
                    <td>{c.company}</td>
                    <td>{c.email || '—'}</td>
                    <td>{c.receivedOn ?? ''}</td>
                    <td className="small">{reason ? <span className="error-inline">{reason}</span> : on && willSend(c.id) ? '送る' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <h3>文面</h3>
      <div className="field"><label>件名</label><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></div>
      <div className="field">
        <label>本文</label>
        <div className="row small">
          <button className="btn ghost small" onClick={() => insert('{会社名}')}>会社名を差し込む</button>
          <button className="btn ghost small" onClick={() => insert('{氏名}')}>氏名を差し込む</button>
        </div>
        <textarea ref={bodyRef} rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      {preview?.sample && (
        <>
          <h3>見本 <span className="badge">{preview.advertising === false ? '宣伝を含まない' : '宣伝を含む'}</span></h3>
          <div className="bulk-sample">
            <div className="small muted">宛先: {preview.sample.to}</div>
            <div><strong>{preview.sample.subject}</strong></div>
            <pre>{preview.sample.body}</pre>
          </div>
        </>
      )}

      {message && <p className="error">{message}</p>}
      {preview && preview.problems.length > 0 && (
        <ul className="error bulk-problems">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      <div className="row">
        <button className="btn" disabled={busy || !preview || preview.problems.length > 0 || preview.status !== 'draft'} onClick={() => void submit()}>
          {sendCount > 0 ? `${sendCount} 人への送信を承認へ進める` : '承認へ進める'}
        </button>
      </div>
    </div>
  );
}
