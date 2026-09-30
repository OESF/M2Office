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
import type { CardCorners, CardFields, ContactPhone, ContactScope, PhoneKind } from '@m2office/shared';
import { api, describeError, type CardDetail, type CardList, type CardMeetings, type CardSummary } from './api.js';
import { cropCard, prepareCardPhoto } from './card-image.js';

/**
 * ファイルを選ぶときに受け付ける形式（第27.4節）。
 *
 * @remarks
 * スマホでは HEIC を挙げない。iPhone の Safari は、受け付ける形式に HEIC が無ければ写真を JPEG にしてから渡すため
 * （サーバーで HEIC を JPEG に直さずに済む。Q-103）。パソコンでは HEIC も挙げる（挙げないと、選ぶ画面で HEIC が隠れる）
 */
const ACCEPT_MOBILE = 'image/png,image/jpeg,image/webp,application/pdf,.webp,.pdf,.csv,.xlsx,text/csv';
const ACCEPT_DESKTOP = 'image/png,image/jpeg,image/heic,image/heif,image/webp,application/pdf,.heic,.heif,.webp,.pdf,.csv,.xlsx,text/csv';
/** 表（CSV・Excel）のファイルか。表は画像の読み取りでなく、表からの取り込みに回す（第27.4節）。 */
const isTable = (f: File) => /\.(csv|xlsx)$/i.test(f.name) || f.type === 'text/csv';

/** スマホ（iPhone・iPad・Android）か。iPad は Mac と名乗るため、触れる点の数でも見る。 */
function isMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

const PHONE_LABELS: Record<PhoneKind, string> = { main: '代表', direct: '直通', mobile: '携帯', fax: 'FAX' };

/**
 * 名刺の画面。
 *
 * @param contactId 開いている詳細。一覧なら `null`
 * @param onOpen 詳細を開く・一覧に戻る（URL を合わせる）
 * @param mailer メールの開き方（本人のアカウントの Gmail か `mailto:`）
 */
export function Cards({ contactId, onOpen, mailer, admin = false }: {
  contactId: string | null;
  onOpen: (contactId: string | null) => void;
  mailer: Mailer;
  /** 管理者か（会社の名刺のまとめての書き出しは管理者だけ。第27.10節）。 */
  admin?: boolean;
}) {
  if (contactId) return <CardDetailView id={contactId} onBack={() => onOpen(null)} onOpen={onOpen} mailer={mailer} />;
  return <CardListView onOpen={onOpen} admin={admin} />;
}

/** 一覧・撮る・ファイルを選ぶ・探す・書き出す。 */
function CardListView({ onOpen, admin }: { onOpen: (id: string) => void; admin: boolean }) {
  const [list, setList] = useState<CardList | null>(null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | ContactScope>('all');
  const [trash, setTrash] = useState(false);
  // 表から取り込んだ結果など、うまくいった知らせ
  const [notice, setNotice] = useState<string | null>(null);
  // ごみ箱で選んだ名刺（まとめて戻す・完全に削除する。第27.7節）。ごみ箱を開き直したら選び直す
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [trash, scope, q]);
  const [personal, setPersonal] = useState<boolean | null>(null);
  const [withBack, setWithBack] = useState(false);
  const [front, setFront] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const mobile = isMobile();

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
  const send = async (chosen: File[], backOf?: (number | null)[]) => {
    if (chosen.length === 0) return;
    setBusy(true);
    setMessage(null);
    setNotice(null);
    // 表（CSV・Excel）は、1 行を 1 枚の名刺として、その場で取り込む（第27.4節「表から取り込む」）
    const tables = backOf ? [] : chosen.filter(isTable);
    const picked = chosen.filter((f) => !tables.includes(f));
    const notes: string[] = [];
    for (const t of tables) {
      try {
        const r = await api.cards.importTable(t, personal ? 'personal' : 'company');
        notes.push(`${t.name}: ${r.created} 件を登録${r.merged ? `、${r.merged} 件を同じ人にまとめました` : 'しました'}`
          + (r.skipped.length ? `（取り込めなかった行: ${r.skipped.slice(0, 5).map((x) => `${x.row} 行目 ${x.reason}`).join('、')}${r.skipped.length > 5 ? ` ほか ${r.skipped.length - 5} 行` : ''}）` : ''));
      } catch (e) {
        setMessage(describeError(e, `${t.name} を取り込めませんでした`));
      }
    }
    if (notes.length) setNotice(notes.join(' / '));
    if (picked.length === 0) { setBusy(false); load(); return; }
    try {
      // 写真の向きの情報を反映した画素にしてから送る（読み取りと画面が同じ画素を見るため。第27.4節）
      const files = await Promise.all(picked.map(prepareCardPhoto));
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
        {/* 「撮る」はスマホだけに出す。パソコンのブラウザはカメラの指定を無視し、「ファイルを選ぶ」と同じ画面になるため（第27.4節） */}
        {mobile && (
          <button className="btn" disabled={busy} onClick={() => camera.current?.click()}>
            {front ? '裏を撮る' : '撮る'}
          </button>
        )}
        {front && <button className="btn ghost small" onClick={() => { const f = front; setFront(null); void send([f]); }}>裏は無し</button>}
        <button className={mobile ? 'btn ghost' : 'btn'} disabled={busy || !!front} onClick={() => picker.current?.click()}>ファイルを選ぶ</button>
        {mobile && <label className="small check"><input type="checkbox" checked={withBack} disabled={!!front} onChange={(e) => setWithBack(e.target.checked)} /> 裏も撮る</label>}
        <label className="small check"><input type="checkbox" checked={!!personal} onChange={(e) => setPersonal(e.target.checked)} /> 自分だけ</label>
        {admin && (
          <select className="cards-export" value="" disabled={busy} aria-label="書き出す"
            onChange={(e) => { const f = e.target.value as 'csv' | 'xlsx'; e.target.value = ''; if (f) void api.cards.exportTable(f).catch((err) => setMessage(describeError(err, '書き出せませんでした'))); }}>
            <option value="">書き出す…</option>
            <option value="csv">CSV</option>
            <option value="xlsx">Excel</option>
          </select>
        )}
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden
          onChange={(e) => { shot(e.target.files?.[0]); e.target.value = ''; }} />
        <input ref={picker} type="file" accept={mobile ? ACCEPT_MOBILE : ACCEPT_DESKTOP} multiple hidden
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
      {notice && <p className="ok-msg">{notice}</p>}
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
            <button className="btn ghost small" onClick={() => void api.cards.dismiss(u.id).then(load).catch((e) => setMessage(describeError(e)))}>削除</button>
          )}
        </div>
      ))}
      {list && list.items.length === 0 && (list.unresolved.length === 0 || trash) && (
        <p className="muted">{trash ? 'ごみ箱は空です' : q ? '見つかりませんでした' : '名刺はまだありません'}</p>
      )}
      {trash && list && list.items.length > 0 && (
        <TrashBar items={list.items} selected={selected} onSelect={setSelected} onChanged={load} onMessage={setMessage} />
      )}
      {list?.items.map((c) => (
        trash
          ? <TrashRow key={c.id} item={c} onChanged={load} onError={setMessage}
            checked={selected.has(c.id)} onCheck={(on) => setSelected((cur) => { const n = new Set(cur); if (on) n.add(c.id); else n.delete(c.id); return n; })} />
          : <CardRow key={c.id} item={c} onOpen={() => onOpen(c.id)} />
      ))}
    </div>
  );
}

/** 一覧の 1 行。 */
function CardRow({ item: c, onOpen }: { item: CardSummary; onOpen: () => void }) {
  return (
    <button className="card-row" onClick={onOpen}>
      <CardThumb cardId={c.cardId} rotation={c.frontRotation} corners={c.frontCorners} kind={c.frontKind} />
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

/**
 * ごみ箱のまとめての操作（仕様書 第27.7節）。選んだ名刺をまとめて戻す・完全に削除する。
 *
 * @remarks 完全に削除は元に戻せないため、件数を示して 1 度だけ確かめる。できなかった名刺があっても、ほかは進める
 */
function TrashBar({ items, selected, onSelect, onChanged, onMessage }: {
  items: CardSummary[]; selected: Set<string>; onSelect: (s: Set<string>) => void; onChanged: () => void; onMessage: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const chosen = items.filter((c) => selected.has(c.id));
  const all = chosen.length === items.length;
  const run = async (label: string, one: (id: string) => Promise<unknown>) => {
    setBusy(true);
    onMessage(null);
    let failed = 0;
    for (const c of chosen) await one(c.id).catch(() => { failed++; });
    setBusy(false);
    onSelect(new Set());
    onChanged();
    if (failed > 0) onMessage(`${chosen.length - failed} 件を${label}。${failed} 件はできませんでした（完全に削除できるのは、取り込んだ本人と管理者です）`);
  };
  return (
    <div className="cards-toolbar trash-bar">
      <label className="small check">
        <input type="checkbox" checked={all} onChange={() => onSelect(all ? new Set() : new Set(items.map((c) => c.id)))} /> すべて選ぶ
      </label>
      {chosen.length > 0 && (
        <>
          <button className="btn ghost small" disabled={busy} onClick={() => void run('戻しました', (id) => api.cards.restore(id))}>
            選んだ {chosen.length} 件を戻す
          </button>
          <button className="btn ghost small danger" disabled={busy} onClick={() => {
            if (window.confirm(`選んだ ${chosen.length} 件の名刺を、画像ごと削除します。元に戻せません。`)) void run('完全に削除しました', (id) => api.cards.purge(id));
          }}>選んだ {chosen.length} 件を完全に削除</button>
        </>
      )}
    </div>
  );
}

/** ごみ箱の 1 行。選ぶ・戻す・完全に削除。 */
function TrashRow({ item: c, onChanged, onError, checked, onCheck }: {
  item: CardSummary; onChanged: () => void; onError: (m: string) => void; checked: boolean; onCheck: (on: boolean) => void;
}) {
  const act = (run: () => Promise<unknown>) => void run().then(onChanged).catch((e) => onError(describeError(e)));
  return (
    <div className="card-row">
      <input type="checkbox" className="card-row-check" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`${c.name || 'この名刺'}を選ぶ`} />
      <CardThumb cardId={c.cardId} rotation={c.frontRotation} corners={c.frontCorners} kind={c.frontKind} />
      <div className="card-row-main">
        <strong>{c.name || '（氏名なし）'}</strong>
        <span className="small muted">{c.company}{c.trashedAt ? `　${shortDate(c.trashedAt)} にごみ箱へ` : ''}</span>
      </div>
      <button className="btn ghost small" onClick={() => act(() => api.cards.restore(c.id))}>戻す</button>
      <button className="btn ghost small danger" onClick={() => {
        if (window.confirm(`${c.name || 'この名刺'}を、画像ごと削除します。元に戻せません。`)) act(() => api.cards.purge(c.id));
      }}>完全に削除</button>
    </div>
  );
}

/**
 * 名刺の画像。読んだ中身を画面の中だけで出す（ログインと会社の指定をそのまま使うため）。
 *
 * @param rotation 読み取りで見分けた、正しい向きに回す角度
 * @param corners 名刺の四隅。あれば名刺の範囲を切り出して傾きを直し（第27.5節）、無ければ写真全体を回して出す
 * @param kind 画像の形式。ページだけの PDF は画面の中で PDF として出す
 * @remarks 詳細（`large`）では、押すと元の写真に切り替わる（切り出しがずれたときに確かめられるように）
 */
function CardImage({ cardId, side, rotation, corners, kind, large = false }: {
  cardId: string | null; side: 'front' | 'back'; rotation: number; corners: CardCorners | null; kind: string | null; large?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState<string>('');
  const [original, setOriginal] = useState(false);
  const key = corners ? corners.flat().join(',') : '';
  useEffect(() => {
    if (!cardId) return;
    let cancelled = false;
    let made: string | null = null;
    void api.cards.image(cardId, side).then(async (b) => {
      if (!b || cancelled) return;
      const image = b.type.startsWith('image/');
      // 名刺の範囲を切り出して傾きを直す。四隅が無いか、切り出せなければ、写真全体を正しい向きに回す（見た目でなく画素を回す）
      const whole = async () => (rotation ? rotated(b, rotation).catch(() => b) : b);
      const shown = !image ? b : corners && !original ? await cropCard(b, corners).catch(whole) : await whole();
      if (cancelled) return;
      made = URL.createObjectURL(shown);
      setType(b.type);
      setUrl(made);
    });
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [cardId, side, rotation, key, original]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!url) return <div className={`card-img placeholder${large ? ' large' : ''}`} />;
  if (type === 'application/pdf' || kind === 'pdf') {
    return large ? <iframe className="card-img large pdf" src={url} title="名刺" /> : <div className="card-img placeholder pdf">PDF</div>;
  }
  // HEIC は表示できないブラウザがある（Safari では出る）。出せなければ形だけ出す
  const img = <img src={url} alt="名刺" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />;
  if (large && corners) {
    return (
      <button type="button" className="card-img large card-img-toggle" onClick={() => setOriginal((o) => !o)}
        aria-label={original ? '名刺の範囲を出す' : '元の写真を出す'} title={original ? '名刺の範囲を出す' : '元の写真を出す'}>
        {img}
      </button>
    );
  }
  return <div className={`card-img${large ? ' large' : ''}`}>{img}</div>;
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

function CardThumb({ cardId, rotation, corners = null, kind }: { cardId: string | null; rotation: number; corners?: CardCorners | null; kind: string | null }) {
  return <CardImage cardId={cardId} side="front" rotation={rotation} corners={corners} kind={kind} />;
}

/** 詳細。画像の横に氏名と操作、その下に項目を狭い幅で並べる。項目はその場で直せる（第27.8節）。 */
function CardDetailView({ id, onBack, onOpen, mailer }: {
  id: string; onBack: () => void; onOpen: (id: string | null) => void; mailer: Mailer;
}) {
  const [d, setD] = useState<CardDetail | null>(null);
  const [meetings, setMeetings] = useState<CardMeetings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
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

  /**
   * お礼のメールを書く（第27.8節）。件名と本文を作ってもらい、Gmail の新しいメールの画面に入れて開く。送るのは本人。
   *
   * @remarks 作るのを待ってから新しいタブを開くとブラウザに止められるため、押したときに先にタブを開いておく
   */
  const writeMail = async () => {
    if (!d) return;
    setMessage(null);
    const tab = mailer.google ? window.open('about:blank', '_blank') : null;
    setWriting(true);
    try {
      const draft = await api.cards.mailDraft(d.contact.id);
      const url = composeUrl(mailer, draft.to, draft.subject, draft.body);
      if (tab) tab.location.href = url;
      else if (mailer.google) window.open(url, '_blank', 'noopener');
      else location.href = url;
    } catch (e) {
      tab?.close();
      setMessage(describeError(e, 'メールを用意できませんでした'));
    } finally {
      setWriting(false);
    }
  };

  if (!d) return (
    <div className="cards">
      <button className="link" onClick={onBack}>← 名刺管理</button>
      {message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>}
    </div>
  );
  const c = d.contact;
  const latest = d.cards[0];
  const eventsOn = (date: string) => (meetings?.available ? meetings.days.find((x) => x.date === date)?.events ?? [] : []);

  return (
    <div className="cards card-detail">
      <button className="link" onClick={onBack}>← 名刺管理</button>
      {message && <p className="error">{message}</p>}
      <div className="card-head">
        <div className="card-images">
          {latest?.hasFront && <CardImage cardId={latest.id} side="front" rotation={latest.frontRotation} corners={latest.frontCorners} kind={null} large />}
          {latest?.hasBack && <CardImage cardId={latest.id} side="back" rotation={latest.backRotation} corners={latest.backCorners} kind={null} large />}
        </div>
        <div className="card-summary">
          <h2>{c.name || '（氏名なし）'}</h2>
          {c.nameKana && <div className="small muted">{c.nameKana}{c.kanaEstimated ? '（推定）' : ''}</div>}
          <div>{c.company}</div>
          <div className="small muted">{[c.department, c.title].filter(Boolean).join('　')}</div>
          {/* 範囲は「会社で共有」「自分だけ」の 2 つの言葉だけで示す。変えられる人には切り替えで出す（第27.7節） */}
          {d.canManage ? (
            <div className="segmented small card-scope" role="group" aria-label="範囲">
              {(['company', 'personal'] as const).map((s) => (
                <button key={s} className={c.scope === s ? 'on' : ''} aria-pressed={c.scope === s}
                  onClick={() => { if (c.scope !== s) act(() => api.cards.setScope(c.id, s)); }}>
                  {s === 'company' ? '会社で共有' : '自分だけ'}
                </button>
              ))}
            </div>
          ) : <div className="small"><span className="badge">{c.scope === 'company' ? '会社で共有' : '自分だけ'}</span></div>}
          <div className="card-actions">
            {c.emails[0] && <button className="btn small" disabled={writing} onClick={() => void writeMail()}>{writing ? '用意しています…' : 'メールを書く'}</button>}
            <button className="btn ghost small" onClick={() => act(() => api.cards.downloadVCard(c.id, c.name))}>vCard</button>
            {d.canManage && (
              <button className="btn ghost small danger" onClick={() => act(() => api.cards.trash(c.id), () => onOpen(null))}>削除</button>
            )}
          </div>
        </div>
      </div>

      <dl className="card-fields">
        <Field label="氏名"><Editable value={c.name} onSave={(v) => save({ name: v })} /></Field>
        <Field label="ふりがな">
          <Editable value={c.nameKana} onSave={(v) => save({ nameKana: v })} />
          {c.kanaEstimated && c.nameKana && <span className="small muted"> 推定</span>}
        </Field>
        <Field label="会社名"><Editable value={c.company} onSave={(v) => save({ company: v })} /></Field>
        <Field label="部署"><Editable value={c.department} onSave={(v) => save({ department: v })} /></Field>
        <Field label="役職"><Editable value={c.title} onSave={(v) => save({ title: v })} /></Field>
        <Field label="電話"><Phones phones={c.phones} onSave={(phones) => save({ phones })} /></Field>
        <Field label="メール">
          <LinkField value={c.emails.join(', ')} onSave={(v) => save({ emails: v.split(/[,、\s]+/).filter(Boolean) })}>
            {c.emails.map((e) => <a key={e} href={composeUrl(mailer, e)} target={mailer.google ? '_blank' : undefined} rel="noreferrer">{e}</a>)}
          </LinkField>
        </Field>
        <Field label="郵便番号"><Editable value={c.postalCode} onSave={(v) => save({ postalCode: v })} /></Field>
        <Field label="住所">
          <LinkField value={c.address} onSave={(v) => save({ address: v })}>
            {c.address && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}`} target="_blank" rel="noreferrer">{c.address}</a>}
          </LinkField>
        </Field>
        <Field label="Web">
          <LinkField value={c.website} onSave={(v) => save({ website: v })}>
            {c.website && <a href={webUrl(c.website)} target="_blank" rel="noreferrer">{c.website}</a>}
          </LinkField>
        </Field>
        <Field label="そのほか"><Editable value={c.extra} onSave={(v) => save({ extra: v })} /></Field>
        <Field label="メモ"><Editable value={c.note} multiline onSave={(v) => save({ note: v })} /></Field>
      </dl>

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
              <span key={`${e.start}-${e.title}`} className="small muted">この日の予定: {e.title}</span>
            ))}
            {x.note && <span className="small muted">{x.note}</span>}
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

/** メールの開き方。会社が Google とつないでいれば、本人のアカウントの Gmail で開く（第27.8節）。 */
export interface Mailer {
  /** 本人のメールアドレス（Gmail のアカウントを選ぶのに使う）。 */
  email: string;
  google: boolean;
}

/** 新しいメールの画面の URL。Google とつないでいれば Gmail、つないでいなければ `mailto:`。 */
function composeUrl(m: Mailer, to: string, subject = '', body = ''): string {
  if (!m.google) {
    const q = new URLSearchParams({ ...(subject ? { subject } : {}), ...(body ? { body } : {}) }).toString().replace(/\+/g, '%20');
    return `mailto:${encodeURIComponent(to)}${q ? `?${q}` : ''}`;
  }
  const p = new URLSearchParams({ authuser: m.email, view: 'cm', fs: '1', to, ...(subject ? { su: subject } : {}), ...(body ? { body } : {}) });
  return `https://mail.google.com/mail/?${p.toString()}`;
}

/** Web の項目を開ける URL にする（`http` の無いものは `https://` を付ける）。 */
function webUrl(v: string): string {
  return /^https?:\/\//i.test(v) ? v : `https://${v.replace(/^\/+/, '')}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

/**
 * リンクになっている項目。ふだんはリンク（押すと開く）を出し、横の「直す」で入力に切り替える。
 *
 * @param value 直すときの文字
 * @param children ふだん出すリンク。空なら「—」と直すボタンだけ
 */
function LinkField({ value, onSave, children }: { value: string; onSave: (v: string) => void; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <Editable value={value} startEditing onSave={(v) => { setEditing(false); onSave(v); }} onCancel={() => setEditing(false)} />;
  const empty = !value.trim();
  return (
    <span className="link-field">
      {empty ? <span className="muted">—</span> : <span className="link-values">{children}</span>}
      <button className="edit-btn" title="直す" aria-label="直す" onClick={() => setEditing(true)}>✎</button>
    </span>
  );
}

/** その場で直せる値。押すと入力になり、離れるか Enter で保存する。 */
function Editable({ value, onSave, multiline = false, startEditing = false, onCancel }: {
  value: string; onSave: (v: string) => void; multiline?: boolean; startEditing?: boolean; onCancel?: () => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => { setEditing(false); if (v !== value) onSave(v); else onCancel?.(); };
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
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) done(); if (e.key === 'Escape') { setV(value); setEditing(false); onCancel?.(); } }} />;
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

/**
 * 電話番号（種類つき）。ふだんは種類と番号のリンク（`tel:`。スマホではそのまま発信）を出し、「直す」で行ごとの入力にする。空にした行は消える。
 */
function Phones({ phones, onSave }: { phones: ContactPhone[]; onSave: (p: ContactPhone[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState(phones);
  useEffect(() => setRows(phones), [phones]);
  if (!editing) {
    return (
      <span className="link-field">
        {phones.length === 0 ? <span className="muted">—</span> : (
          <span className="link-values">
            {phones.map((p) => (
              <span key={p.number} className="phone">
                <span className="small muted">{PHONE_LABELS[p.kind]}</span>{' '}
                {p.kind === 'fax' ? <span>{p.number}</span> : <a href={`tel:${p.number.replace(/[^0-9+]/g, '')}`}>{p.number}</a>}
              </span>
            ))}
          </span>
        )}
        <button className="edit-btn" title="直す" aria-label="直す" onClick={() => setEditing(true)}>✎</button>
      </span>
    );
  }
  const finish = () => {
    setEditing(false);
    const clean = rows.filter((p) => p.number.trim());
    if (JSON.stringify(clean) !== JSON.stringify(phones)) onSave(clean);
  };
  return (
    <div className="card-phones">
      {rows.map((p, i) => (
        <div key={i} className="row small">
          <select value={p.kind} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, kind: e.target.value as PhoneKind } : x)))}>
            {(Object.keys(PHONE_LABELS) as PhoneKind[]).map((k) => <option key={k} value={k}>{PHONE_LABELS[k]}</option>)}
          </select>
          <input value={p.number} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))} />
        </div>
      ))}
      <div className="row small">
        <button className="link small" onClick={() => setRows([...rows, { kind: 'main', number: '' }])}>＋ 番号</button>
        <button className="btn small" onClick={finish}>保存</button>
      </div>
    </div>
  );
}

/** `YYYY-MM-DD` か日時を、月と日にする。 */
function shortDate(v: string): string {
  const d = new Date(v.length === 10 ? `${v}T00:00:00+09:00` : v);
  return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' });
}
