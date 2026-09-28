/**
 * @file 名刺の画面。撮る・ファイルを選ぶ・探す・一覧・詳細（その場の修正・電話・地図・メール・vCard・範囲・分ける・消す）・ごみ箱。
 *
 * 読み取りは後ろで進む。撮る人を待たせず、進み具合（何枚中何枚）を上に出す。
 * 説明文を常に出さない（原則 u11）。分からなければ秘書に聞けばよい。
 *
 * @see 仕様書 第27.8節 画面
 * @see 仕様書 第27.4節 取り込み
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CardFields, ContactPhone, ContactScope, PhoneKind } from '@m2office/shared';
import { api, describeError, type CardDetail, type CardList, type CardMeetings, type CardSummary } from './api.js';

/** ファイルを選ぶときに受け付ける形式（第27.4節）。 */
const ACCEPT = 'image/png,image/jpeg,image/heic,image/heif,image/webp,application/pdf,.heic,.heif,.webp,.pdf';

const PHONE_LABELS: Record<PhoneKind, string> = { main: '代表', direct: '直通', mobile: '携帯', fax: 'FAX' };

/**
 * 名刺の画面。
 *
 * @param contactId 開いている詳細。一覧なら `null`
 * @param onOpen 詳細を開く・一覧に戻る（URL を合わせる）
 * @param onAsk 秘書に頼む（メールの下書きなど）。答えは秘書のキャンバスに出る
 */
export function Cards({ contactId, onOpen, onAsk }: {
  contactId: string | null;
  onOpen: (contactId: string | null) => void;
  onAsk: (message: string) => void;
}) {
  if (contactId) return <CardDetailView id={contactId} onBack={() => onOpen(null)} onOpen={onOpen} onAsk={onAsk} />;
  return <CardListView onOpen={onOpen} />;
}

/** 一覧・撮る・ファイルを選ぶ・探す。 */
function CardListView({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<CardList | null>(null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | ContactScope>('all');
  const [trash, setTrash] = useState(false);
  const [personal, setPersonal] = useState<boolean | null>(null);
  const [withBack, setWithBack] = useState(false);
  const [front, setFront] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.cards.list({ q, scope, trash }).then((r) => {
      setList(r);
      // 選ばなければ会社の既定の範囲（第27.7節）。毎回選ばせない
      setPersonal((p) => (p === null ? r.defaultScope === 'personal' : p));
    }).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, [q, scope, trash]);
  // 探す言葉は打ち終わりを待って読み直す
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  // 読み取りの間は、進み具合を読み直す（画面を閉じても読み取りは止まらない）
  const reading = !!list && (list.progress !== null || list.unresolved.some((u) => u.status !== 'failed'));
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [reading, load]);

  /** 渡して、読み取りの待ちに入れる。 */
  const send = async (files: File[], backOf?: (number | null)[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.cards.upload(files, { scope: personal ? 'personal' : 'company', ...(backOf ? { backOf } : {}) });
      if (r.rejected.length > 0) setMessage(r.rejected.map((x) => (x.name ? `${x.name}: ${x.reason}` : x.reason)).join(' / '));
      load();
    } catch (e) {
      setMessage(describeError(e, '渡せませんでした'));
    } finally {
      setBusy(false);
    }
  };

  /** 撮った 1 枚。「裏も撮る」なら、表を持っておいて次の 1 枚を裏にする。 */
  const shot = (f: File | undefined) => {
    if (!f) return;
    if (withBack && !front) { setFront(f); return; }
    if (front) {
      const pair = [front, f];
      setFront(null);
      void send(pair, [null, 0]);
      return;
    }
    void send([f]);
  };

  return (
    <div className="cards">
      <div className="cards-toolbar">
        <button className="btn" disabled={busy} onClick={() => camera.current?.click()}>
          {front ? '裏を撮る' : '撮る'}
        </button>
        {front && <button className="btn ghost small" onClick={() => { const f = front; setFront(null); void send([f]); }}>裏は無し</button>}
        <button className="btn ghost" disabled={busy || !!front} onClick={() => picker.current?.click()}>ファイルを選ぶ</button>
        <label className="small check"><input type="checkbox" checked={withBack} disabled={!!front} onChange={(e) => setWithBack(e.target.checked)} /> 裏も撮る</label>
        <label className="small check"><input type="checkbox" checked={!!personal} onChange={(e) => setPersonal(e.target.checked)} /> 自分だけ</label>
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden
          onChange={(e) => { shot(e.target.files?.[0]); e.target.value = ''; }} />
        <input ref={picker} type="file" accept={ACCEPT} multiple hidden
          onChange={(e) => { void send(Array.from(e.target.files ?? []).slice(0, 50)); e.target.value = ''; }} />
      </div>
      <div className="cards-toolbar">
        <input type="search" className="cards-search" placeholder="氏名・会社名・電話番号で探す" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="segmented small">
          {(['all', 'company', 'personal'] as const).map((s) => (
            <button key={s} className={scope === s && !trash ? 'on' : ''} onClick={() => { setScope(s); setTrash(false); }}>
              {s === 'all' ? 'すべて' : s === 'company' ? '会社で共有' : '自分だけ'}
            </button>
          ))}
          <button className={trash ? 'on' : ''} onClick={() => setTrash(!trash)}>ごみ箱</button>
        </div>
      </div>
      {message && <p className="error">{message}</p>}
      {list?.progress && (
        <div className="card-progress" role="status">
          <span>読み取っています {list.progress.finished} / {list.progress.total}</span>
          <progress max={list.progress.total} value={list.progress.finished} />
        </div>
      )}
      {!trash && list?.unresolved.map((u) => (
        <div key={u.id} className={`card-row unresolved${u.status === 'failed' ? ' failed' : ''}`}>
          <CardThumb cardId={u.id} rotation={0} kind={null} />
          <div className="card-row-main">
            <strong>{u.status === 'failed' ? '読み取れませんでした' : '読み取っています'}</strong>
            {u.failureReason && <span className="small muted">{u.failureReason}</span>}
          </div>
          {u.status === 'failed' && (
            <button className="btn ghost small" onClick={() => void api.cards.dismiss(u.id).then(load).catch((e) => setMessage(describeError(e)))}>消す</button>
          )}
        </div>
      ))}
      {list && list.items.length === 0 && (list.unresolved.length === 0 || trash) && (
        <p className="muted">{trash ? 'ごみ箱は空です' : q ? '見つかりませんでした' : '名刺はまだありません'}</p>
      )}
      {list?.items.map((c) => (
        trash
          ? <TrashRow key={c.id} item={c} onChanged={load} onError={setMessage} />
          : <CardRow key={c.id} item={c} onOpen={() => onOpen(c.id)} />
      ))}
    </div>
  );
}

/** 一覧の 1 行。 */
function CardRow({ item: c, onOpen }: { item: CardSummary; onOpen: () => void }) {
  return (
    <button className="card-row" onClick={onOpen}>
      <CardThumb cardId={c.cardId} rotation={c.frontRotation} kind={c.frontKind} />
      <div className="card-row-main">
        <strong>{c.name || '（氏名なし）'}</strong>
        <span className="small muted">{[c.company, c.department, c.title].filter(Boolean).join('　')}</span>
      </div>
      <div className="card-row-tail small muted">
        {c.scope === 'personal' && <span className="badge">自分だけ</span>}
        {c.lastReceivedOn && <span>{shortDate(c.lastReceivedOn)}</span>}
      </div>
    </button>
  );
}

/** ごみ箱の 1 行。戻す・いま本当に消す。 */
function TrashRow({ item: c, onChanged, onError }: { item: CardSummary; onChanged: () => void; onError: (m: string) => void }) {
  const act = (run: () => Promise<unknown>) => void run().then(onChanged).catch((e) => onError(describeError(e)));
  return (
    <div className="card-row">
      <CardThumb cardId={c.cardId} rotation={c.frontRotation} kind={c.frontKind} />
      <div className="card-row-main">
        <strong>{c.name || '（氏名なし）'}</strong>
        <span className="small muted">{c.company}{c.trashedAt ? `　${shortDate(c.trashedAt)} にごみ箱へ` : ''}</span>
      </div>
      <button className="btn ghost small" onClick={() => act(() => api.cards.restore(c.id))}>戻す</button>
      <button className="btn ghost small danger" onClick={() => {
        if (window.confirm(`${c.name || 'この名刺'}を、画像ごと消します。元に戻せません。`)) act(() => api.cards.purge(c.id));
      }}>いま消す</button>
    </div>
  );
}

/**
 * 名刺の画像。読んだ中身を画面の中だけで出す（ログインと会社の指定をそのまま使うため）。
 *
 * @param rotation 読み取りで見分けた、正しい向きに回す角度
 * @param kind 画像の形式。ページだけの PDF は画面の中で PDF として出す
 */
function CardImage({ cardId, side, rotation, kind, large = false }: {
  cardId: string | null; side: 'front' | 'back'; rotation: number; kind: string | null; large?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState<string>('');
  useEffect(() => {
    if (!cardId) return;
    let cancelled = false;
    let made: string | null = null;
    void api.cards.image(cardId, side).then(async (b) => {
      if (!b || cancelled) return;
      // 正しい向きに回した画像を作る。枠に収まるよう、見た目でなく画素を回す
      const shown = rotation && b.type.startsWith('image/') ? await rotated(b, rotation).catch(() => b) : b;
      if (cancelled) return;
      made = URL.createObjectURL(shown);
      setType(b.type);
      setUrl(made);
    });
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [cardId, side, rotation]);
  if (!url) return <div className={`card-img placeholder${large ? ' large' : ''}`} />;
  if (type === 'application/pdf' || kind === 'pdf') {
    return large ? <iframe className="card-img large pdf" src={url} title="名刺" /> : <div className="card-img placeholder pdf">PDF</div>;
  }
  // HEIC は表示できないブラウザがある（Safari では出る）。出せなければ形だけ出す
  return (
    <div className={`card-img${large ? ' large' : ''}`}>
      <img src={url} alt="名刺" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
    </div>
  );
}

/**
 * 画像を時計回りに回した画像を作る。
 *
 * @remarks ブラウザが読めない形式（HEIC を読めないブラウザなど）は例外になる。呼ぶ側は元の画像をそのまま出す
 */
async function rotated(blob: Blob, degrees: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const turn = degrees === 90 || degrees === 270;
  const canvas = document.createElement('canvas');
  canvas.width = turn ? bitmap.height : bitmap.width;
  canvas.height = turn ? bitmap.width : bitmap.height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas');
  g.translate(canvas.width / 2, canvas.height / 2);
  g.rotate((degrees * Math.PI) / 180);
  g.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.9));
}

function CardThumb({ cardId, rotation, kind }: { cardId: string | null; rotation: number; kind: string | null }) {
  return <CardImage cardId={cardId} side="front" rotation={rotation} kind={kind} />;
}

/** 詳細。項目はその場で直せる（第27.8節）。 */
function CardDetailView({ id, onBack, onOpen, onAsk }: {
  id: string; onBack: () => void; onOpen: (id: string | null) => void; onAsk: (message: string) => void;
}) {
  const [d, setD] = useState<CardDetail | null>(null);
  const [meetings, setMeetings] = useState<CardMeetings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => {
    api.cards.get(id).then(setD).catch((e) => setMessage(describeError(e, '名刺が見つかりません')));
  }, [id]);
  useEffect(load, [load]);
  // 会った場面は開くたびにカレンダーから引く。保存しない（第27.8節、Q-78）
  useEffect(() => { void api.cards.meetings(id).then(setMeetings).catch(() => setMeetings({ available: false, reason: '予定を取得できませんでした' })); }, [id]);

  const save = async (patch: Partial<CardFields> & { note?: string }) => {
    setMessage(null);
    try {
      await api.cards.update(id, patch);
      load();
    } catch (e) {
      setMessage(describeError(e, '保存できませんでした'));
    }
  };
  const act = (run: () => Promise<unknown>, after?: () => void) =>
    void run().then(() => (after ? after() : load())).catch((e) => setMessage(describeError(e)));

  if (!d) return (
    <div className="cards">
      <button className="link" onClick={onBack}>← 名刺</button>
      {message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>}
    </div>
  );
  const c = d.contact;
  const latest = d.cards[0];
  const mapUrl = c.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}` : null;
  const email = c.emails[0];
  const eventsOn = (date: string) => (meetings?.available ? meetings.days.find((x) => x.date === date)?.events ?? [] : []);

  return (
    <div className="cards card-detail">
      <button className="link" onClick={onBack}>← 名刺</button>
      {message && <p className="error">{message}</p>}
      <div className="card-detail-head">
        <div className="card-images">
          {latest?.hasFront && <CardImage cardId={latest.id} side="front" rotation={latest.frontRotation} kind={null} large />}
          {latest?.hasBack && <CardImage cardId={latest.id} side="back" rotation={latest.backRotation} kind={null} large />}
        </div>
        <div className="card-actions">
          {email && (
            <button className="btn small" onClick={() => onAsk(`${c.company ? `${c.company}の` : ''}${c.name}さん（${email}）に、名刺交換のお礼のメールの下書きを作ってください`)}>
              メールを書く
            </button>
          )}
          {c.phones.filter((p) => p.kind !== 'fax').map((p) => (
            <a key={p.number} className="btn ghost small" href={`tel:${p.number.replace(/[^0-9+]/g, '')}`}>電話（{PHONE_LABELS[p.kind]}）</a>
          ))}
          {mapUrl && <a className="btn ghost small" href={mapUrl} target="_blank" rel="noreferrer">地図</a>}
          <button className="btn ghost small" onClick={() => act(() => api.cards.downloadVCard(c.id, c.name))}>vCard</button>
          {d.canManage && (
            <button className="btn ghost small" onClick={() => act(() => api.cards.setScope(c.id, c.scope === 'company' ? 'personal' : 'company'))}>
              {c.scope === 'company' ? '自分だけにする' : '会社で共有する'}
            </button>
          )}
          {d.canManage && (
            <button className="btn ghost small danger" onClick={() => act(() => api.cards.trash(c.id), () => onOpen(null))}>消す</button>
          )}
        </div>
      </div>

      <div className="card-fields">
        <Field label="氏名"><Editable value={c.name} onSave={(v) => save({ name: v })} /></Field>
        <Field label="ふりがな">
          <Editable value={c.nameKana} onSave={(v) => save({ nameKana: v })} />
          {c.kanaEstimated && c.nameKana && <span className="small muted"> 推定</span>}
        </Field>
        <Field label="会社名"><Editable value={c.company} onSave={(v) => save({ company: v })} /></Field>
        <Field label="部署"><Editable value={c.department} onSave={(v) => save({ department: v })} /></Field>
        <Field label="役職"><Editable value={c.title} onSave={(v) => save({ title: v })} /></Field>
        <Field label="電話"><Phones phones={c.phones} onSave={(phones) => save({ phones })} /></Field>
        <Field label="メール"><Editable value={c.emails.join(', ')} onSave={(v) => save({ emails: v.split(/[,、\s]+/).filter(Boolean) })} /></Field>
        <Field label="郵便番号"><Editable value={c.postalCode} onSave={(v) => save({ postalCode: v })} /></Field>
        <Field label="住所"><Editable value={c.address} onSave={(v) => save({ address: v })} /></Field>
        <Field label="Web"><Editable value={c.website} onSave={(v) => save({ website: v })} /></Field>
        <Field label="そのほか"><Editable value={c.extra} onSave={(v) => save({ extra: v })} /></Field>
        <Field label="メモ"><Editable value={c.note} multiline onSave={(v) => save({ note: v })} /></Field>
        <Field label="範囲"><span>{c.scope === 'company' ? '会社で共有' : '自分だけ'}</span></Field>
      </div>

      <h3>交換の記録</h3>
      <ul className="card-exchanges">
        {d.cards.map((x) => (
          <li key={x.id}>
            {/* 自分が受け取った名刺の日付は、押すとその場で直せる（第27.3節） */}
            {x.mine
              ? <ReceivedOn value={x.receivedOn} onSave={(v) => act(() => api.cards.setReceivedOn(x.id, v))} />
              : <span>{x.receivedOn}</span>}
            <span>{x.receivedBy ?? ''}</span>
            {x.mine && eventsOn(x.receivedOn).map((e) => (
              <span key={`${e.start}-${e.title}`} className="small muted">　この日の予定: {e.title}</span>
            ))}
            {x.note && <span className="small muted">　{x.note}</span>}
            {d.cards.length > 1 && (
              <button className="link small" onClick={() => act(() => api.cards.split(c.id, x.id), load)}>分ける</button>
            )}
          </li>
        ))}
      </ul>
      {meetings && !meetings.available && <p className="small muted">{meetings.reason}</p>}

      {d.history.length > 0 && (
        <>
          <h3>以前の会社・役職</h3>
          <ul className="card-exchanges">
            {d.history.map((h) => (
              <li key={`${h.receivedOn}-${h.company}-${h.title}`}>{h.receivedOn}　{[h.company, h.department, h.title].filter(Boolean).join('　')}</li>
            ))}
          </ul>
        </>
      )}
      <p className="small muted">{d.ownerName ? `取り込んだ人: ${d.ownerName}` : ''}{d.updatedByName ? `　最後に直した人: ${d.updatedByName}` : ''}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

/** その場で直せる値。押すと入力になり、離れるか Enter で保存する。 */
function Editable({ value, onSave, multiline = false }: { value: string; onSave: (v: string) => void; multiline?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => { setEditing(false); if (v !== value) onSave(v); };
  if (!editing) {
    return (
      <button className={`editable${value ? '' : ' empty'}`} onClick={() => setEditing(true)}>
        {value || '—'}
      </button>
    );
  }
  return multiline
    ? <textarea autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={done} rows={3} />
    : <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={done}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) done(); if (e.key === 'Escape') { setV(value); setEditing(false); } }} />;
}

/** 受け取った日。押すと日付の入力になり、選ぶと保存する。今日より後は選べない。 */
function ReceivedOn({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) return <button className="editable" title="受け取った日を直す" onClick={() => setEditing(true)}>{value}</button>;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  return (
    <input type="date" autoFocus defaultValue={value} max={today}
      onBlur={() => setEditing(false)}
      onChange={(e) => { if (e.target.value && e.target.value !== value) { setEditing(false); onSave(e.target.value); } }} />
  );
}

/** 電話番号（種類つき）。行ごとに直し、空にすると消える。 */
function Phones({ phones, onSave }: { phones: ContactPhone[]; onSave: (p: ContactPhone[]) => void }) {
  const [rows, setRows] = useState(phones);
  useEffect(() => setRows(phones), [phones]);
  const commit = (next: ContactPhone[]) => {
    const clean = next.filter((p) => p.number.trim());
    if (JSON.stringify(clean) !== JSON.stringify(phones)) onSave(clean);
  };
  return (
    <div className="card-phones">
      {rows.map((p, i) => (
        <div key={i} className="row small">
          <select value={p.kind} onChange={(e) => { const next = rows.map((x, j) => (j === i ? { ...x, kind: e.target.value as PhoneKind } : x)); setRows(next); commit(next); }}>
            {(Object.keys(PHONE_LABELS) as PhoneKind[]).map((k) => <option key={k} value={k}>{PHONE_LABELS[k]}</option>)}
          </select>
          <input value={p.number} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))} onBlur={() => commit(rows)} />
        </div>
      ))}
      <button className="link small" onClick={() => setRows([...rows, { kind: 'main', number: '' }])}>＋ 番号</button>
    </div>
  );
}

/** `YYYY-MM-DD` か日時を、月と日にする。 */
function shortDate(v: string): string {
  const d = new Date(v.length === 10 ? `${v}T00:00:00+09:00` : v);
  return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' });
}
