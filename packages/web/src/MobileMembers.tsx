/**
 * @file 店員の会員のページ（スマホ。仕様書 第40.9節）。会員証の QR を読む（会員番号でも探せる）→ 呼び名とポイント →
 * 「来店」「購入（金額）」「特典を使う」、さっきの記録の取り消し。会員を作る（会員証の QR を画面に出して、お客様に読んでもらう）。
 *
 * ワークスペースの枠（左のメニュー・秘書の欄）を出さない。購入の金額はポイントにしたら残さない。
 */

import { useState } from 'react';
import { MEMBER_RANK_LABELS, type Member, type MemberReward } from '@m2office/shared';
import { api, describeError, type Me } from './api.js';
import { Scanner } from './Scanner.js';

type Card = { member: Member; rewards: (MemberReward & { enough: boolean })[] };

/** 店員の会員のページ。 */
export function MobileMembers({ me }: { me: Me }) {
  const [mode, setMode] = useState<'home' | 'scan' | 'create'>('home');
  const [card, setCard] = useState<Card | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Member[]>([]);
  const [amount, setAmount] = useState('');
  const [created, setCreated] = useState<{ member: Member } | null>(null);

  if (!me.members) return <div className="m-inv"><p className="muted">会員とポイントは使えません（会社で切っているか、利用範囲の外です）。</p></div>;

  const open = async (code: string) => {
    setBusy(true);
    try {
      setCard(await api.members.byCard(code));
      setMessage(null);
      setMode('home');
    } catch (e) {
      setMessage(describeError(e, '会員証を読めませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const openMember = async (m: Member) => {
    // 会員番号で探したときは、その会員の会員証から引き直す（使える特典を出すため）
    const d = await api.members.get(m.id).catch(() => null);
    if (d?.cardUrl) await open(d.cardUrl);
  };
  const search = async (v: string) => {
    setQ(v);
    if (!v.trim()) { setHits([]); return; }
    setHits((await api.members.list(v.trim()).catch(() => ({ items: [] as Member[] }))).items.slice(0, 8));
  };
  const act = async (f: () => Promise<{ member: Member; points: number }>, label: string) => {
    if (!card) return;
    setBusy(true);
    try {
      const r = await f();
      setCard({ ...card, member: r.member, rewards: card.rewards.map((x) => ({ ...x, enough: r.member.balance >= x.points })) });
      setMessage(`${label}: ${r.points > 0 ? '+' : ''}${r.points} ポイント（いま ${r.member.balance} ポイント）`);
      setAmount('');
    } catch (e) {
      setMessage(describeError(e, 'できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-inv m-mbr">
      <header className="m-head">
        {mode !== 'home' || card
          ? <button className="m-back" onClick={() => { setMode('home'); setCard(null); setCreated(null); setMessage(null); }} aria-label="戻る">←</button>
          : <span className="m-title">会員</span>}
        <span className="m-tenant">{me.tenant.name}</span>
      </header>
      {message && <p className="m-note" role="status">{message}</p>}

      {mode === 'scan' && <Scanner onCode={(c) => void open(c)} onClose={() => setMode('home')} busy={busy} />}

      {mode === 'home' && !card && (
        <>
          <button className="m-big wide" onClick={() => { setMessage(null); setMode('scan'); }}>会員証を読む</button>
          <input className="m-search" placeholder="会員番号・呼び名で探す" value={q} onChange={(e) => void search(e.target.value)} aria-label="会員を探す" />
          {hits.length > 0 && (
            <div className="m-hits">
              {hits.map((m) => <button key={m.id} className="m-hit" onClick={() => { setQ(''); setHits([]); void openMember(m); }}>No. {m.number} {m.nickname}（{m.balance}）</button>)}
            </div>
          )}
          <button className="m-big wide" onClick={() => { setMessage(null); setMode('create'); }}>会員を作る</button>
        </>
      )}

      {mode === 'home' && card && (
        <div className="m-mbr-card">
          <p className="m-mbr-name">No. {card.member.number} {card.member.nickname}{card.member.rank !== 'regular' && <> <span className="badge mbr-rank">{MEMBER_RANK_LABELS[card.member.rank]}</span></>}</p>
          <p className="m-mbr-points">{card.member.balance} <small>ポイント</small></p>
          <button className="m-big wide" disabled={busy} onClick={() => void act(() => api.members.visit(card.member.id), '来店')}>来店</button>
          <div className="m-mbr-buy">
            <input type="number" inputMode="numeric" min={1} value={amount} placeholder="お買い上げの金額（円）" aria-label="金額" onChange={(e) => setAmount(e.target.value)} />
            <button className="btn" disabled={busy || !amount} onClick={() => void act(() => api.members.purchase(card.member.id, Number(amount)), '購入')}>購入</button>
          </div>
          {card.rewards.length > 0 && (
            <div className="m-mbr-rewards">
              {card.rewards.map((r) => (
                <button key={r.id} className="m-hit" disabled={busy || !r.enough} onClick={() => void act(() => api.members.useReward(card.member.id, r.id), r.name)}>
                  {r.name}（{r.points} ポイント）{r.enough ? '' : ' ・足りません'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === 'create' && <CreateMember created={created} onCreated={setCreated} />}
    </div>
  );
}

/** 会員を作り、会員証の QR を画面に出す（お客様が自分のスマホで読む）。 */
function CreateMember({ created, onCreated }: { created: { member: Member } | null; onCreated: (c: { member: Member }) => void }) {
  const [v, setV] = useState({ nickname: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  if (created) {
    return (
      <div className="m-mbr-card">
        <p className="m-mbr-name">No. {created.member.number} {created.member.nickname}</p>
        <img className="m-mbr-qr" src={api.members.qrUrl(created.member.id)} alt="会員証の QR" />
        <p className="small muted">お客様のスマホのカメラでこの QR を読んでもらうと、会員証が開きます。</p>
      </div>
    );
  }
  return (
    <div className="m-mbr-card">
      <input className="m-search" value={v.nickname} maxLength={30} placeholder="呼び名（ニックネームでよい）" aria-label="呼び名" onChange={(e) => setV({ ...v, nickname: e.target.value })} />
      <input className="m-search" value={v.phone} maxLength={20} inputMode="tel" placeholder="電話（任意）" aria-label="電話" onChange={(e) => setV({ ...v, phone: e.target.value })} />
      <button className="m-big wide" disabled={!v.nickname.trim()} onClick={() => void api.members.create(v).then(onCreated).catch((e) => setError(describeError(e, '作れませんでした')))}>作る</button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
