/**
 * @file スマホ用の在庫のページ（仕様書 第29.11.1節・第29.11.2節）。入庫・出庫・棚卸し（差を見て確定するまで）・探す・登録（バーコードを読んで品目を作る）。
 *
 * 棚の前で品物を片手に持って使う。ワークスペースの枠（左のメニュー・秘書の欄）を出さず、大きなボタンだけにする。
 * 棚のラベルの QR（`/m/inventory?shelf=…`）から開けば、その棚が選ばれた状態で始まる。説明文を常に出さない（原則 u11）。
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { INVENTORY_ITEM_KINDS, inventoryPurposeLabel, type InventoryItemKind, type InventoryCountRow, type InventoryCountView, type InventoryItemView, type InventoryLocation, type InventoryOutPurpose } from '@m2office/shared';
import { api, describeError, type InventoryDetail, type InventoryList, type InventoryRegisterResult, type InventorySlipResult, type Me } from './api.js';
import { Scanner } from './Scanner.js';
import { OutDoneLine, PurposeChips, purposeOf, type OutDone } from './inventory-out.js';
import { YahooCredit } from './yahoo-credit.js';

type Mode = 'home' | 'in' | 'out' | 'count' | 'find' | 'register';

/** 入庫・出庫・棚卸し・探すで知らないバーコードを読んだとき、登録へ進む口（第29.11.2節）。 */
const RegisterContext = createContext<((code: string) => void) | null>(null);

/**
 * はじめの画面の大きなボタン。色とアイコンで、読まなくても見分けられるようにする。
 * いちばん多い出庫を先頭に大きく置き、ほかは 2 列に並べる（2026-10-20 に三浦さんが求めた）。
 */
const HOME_ACTIONS: { mode: Exclude<Mode, 'home'>; label: string; tone: string; icon: JSX.Element }[] = [
  { mode: 'out', label: '出庫', tone: 'out', icon: <><path d="M3 14h5l1.5 2.5h5L16 14h5v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M12 12V3m-4 4l4-4 4 4" /></> },
  { mode: 'in', label: '入庫', tone: 'in', icon: <><path d="M3 14h5l1.5 2.5h5L16 14h5v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M12 3v9m-4-4l4 4 4-4" /></> },
  { mode: 'count', label: '棚卸し', tone: 'count', icon: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></> },
  { mode: 'find', label: '探す', tone: 'find', icon: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></> },
  // バーコードを読んで品目を登録する（第29.11.2節）。5 つ目は横いっぱい
  { mode: 'register', label: '登録', tone: 'reg', icon: <><path d="M4 6v12M7 6v12M10 6v8M13 6v12M16 6v8M19 6v12" /><path d="M16 17h5M18.5 14.5v5" /></> },
];

const round = (n: number) => Math.round(n * 1000) / 1000;
const placeName = (l: InventoryLocation | undefined | null) => (l ? (l.shelf ? `${l.warehouse} ${l.shelf}` : l.warehouse) : '');
const qtyText = (i: { unit: string; packUnit: string; packSize: number | null }, n: number) =>
  (i.packUnit && i.packSize && n !== 0 ? `${round(n)} ${i.unit}（${round(n / i.packSize)} ${i.packUnit}）` : `${round(n)} ${i.unit}`);

/** 読んだ値を引いた結果。 */
type Looked = Awaited<ReturnType<typeof api.inventory.lookup>>;

/**
 * スマホ用の在庫のページ。
 *
 * @param me ログインしている人（会社の名前と、在庫管理を使えるか）
 */
export function MobileInventory({ me }: { me: Me }) {
  const [mode, setMode] = useState<Mode>('home');
  const [list, setList] = useState<InventoryList | null>(null);
  const [shelf, setShelf] = useState<InventoryLocation | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    api.inventory.list().then(setList).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);

  // 棚のラベルから開いたとき（?shelf=…）は、その棚を選んでおく
  useEffect(() => {
    const key = new URLSearchParams(location.search).get('shelf');
    if (!key) return;
    api.inventory.lookup(key).then((r) => { if (r.location) setShelf(r.location); }).catch(() => undefined);
  }, []);

  if (!me.inventory) return <div className="m-inv"><p className="muted">在庫管理は使えません（会社で切っているか、利用範囲の外です）。</p></div>;

  const back = () => { setMode('home'); setMessage(null); load(); };
  // 作業の途中で知らないバーコードを読んだら、登録へ進み、終わったら元の作業に戻る
  const [registerFrom, setRegisterFrom] = useState<{ code: string; back: Mode } | null>(null);
  const startRegister = (code: string) => { setRegisterFrom({ code, back: mode }); setMode('register'); };
  const endRegister = () => { const to = registerFrom?.back ?? 'home'; setRegisterFrom(null); setMode(to); load(); };
  const choose = (id: string) => setShelf(list?.locations.find((l) => l.id === id) ?? null);

  return (
    <div className="m-inv">
      <header className="m-head">
        {mode !== 'home'
          // 矢印だけでは分かりにくいので、言葉つきのボタンにする（2026-10-20 に三浦さんが求めた）
          ? <button className="m-back" onClick={back}><span aria-hidden="true">‹</span> メニュー</button>
          : <span className="m-title">在庫管理</span>}
        <span className="m-tenant">{me.tenant.name}</span>
        {list && list.locations.length > 1 && (
          <select className="m-shelf" value={shelf?.id ?? ''} onChange={(e) => choose(e.target.value)} aria-label="棚">
            <option value="">棚: 今ある場所</option>
            {list.locations.map((l) => <option key={l.id} value={l.id}>{placeName(l)}</option>)}
          </select>
        )}
      </header>
      {message && <p className="m-note" role="status">{message}</p>}
      {mode === 'home' && (
        <div className="m-home">
          {HOME_ACTIONS.map((a) => (
            <button key={a.mode} className={`m-big m-action ${a.tone}`} onClick={() => setMode(a.mode)}>
              <span className="m-action-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{a.icon}</svg>
              </span>
              {a.label}
            </button>
          ))}
        </div>
      )}
      <RegisterContext.Provider value={startRegister}>
        {(mode === 'in' || mode === 'out') && list && (
          <MoveFlow kind={mode} list={list} shelf={shelf} onShelf={setShelf} onRecorded={load} />
        )}
        {mode === 'count' && list && <CountFlow list={list} shelf={shelf} onShelf={setShelf} userId={me.user.id} />}
        {mode === 'find' && list && <FindFlow list={list} onShelf={setShelf} />}
      </RegisterContext.Provider>
      {mode === 'register' && list && (
        <RegisterFlow list={list} shelf={shelf} initialCode={registerFrom?.code ?? null}
          backLabel={registerFrom && registerFrom.back !== 'home' ? `${HOME_ACTIONS.find((a) => a.mode === registerFrom.back)?.label ?? ''}に戻る` : null}
          onBack={endRegister} onChanged={load} />
      )}
      {/* Yahoo!ショッピングで JAN から商品名を引く「登録」の画面だけに出す（第29.11.3節） */}
      {list?.yahooCredit && mode === 'register' && <YahooCredit />}
    </div>
  );
}

/**
 * 読むか名前で探して品目を選ぶ部分。棚のラベルを読んだら棚を選ぶ。
 *
 * @param quickOf よく使う品目のボタンに出す品目の絞り込み（出庫は販売品を除く。読む・探すは絞らない）
 */
function Picker({ items, onItem, onShelf, busy, quickOf }: {
  items: InventoryItemView[];
  onItem: (item: InventoryItemView, looked: Looked | null) => void;
  onShelf: (loc: InventoryLocation) => void;
  busy?: boolean;
  quickOf?: (item: InventoryItemView) => boolean;
}) {
  const [q, setQ] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const register = useContext(RegisterContext);
  // よく使う品目（直近 4 週の 1 日あたりの出庫の多い順）。押すだけで選べるようにし、名前を打たずに済ませる
  const [frequent, setFrequent] = useState<string[]>([]);
  useEffect(() => {
    api.inventory.usage().then((r) => setFrequent(r.rows.filter((x) => x.daily > 0).sort((a, b) => b.daily - a.daily).map((x) => x.itemId))).catch(() => undefined);
  }, []);
  const quick = frequent.map((id) => items.find((i) => i.id === id && i.status === 'active'))
    .filter((i): i is InventoryItemView => !!i && (!quickOf || quickOf(i))).slice(0, 6);
  /** ボタンや名前で品目を選ぶ（前に読んだバーコードの知らせは消す）。 */
  const choose = (i: InventoryItemView) => { setNote(null); setUnknown(null); setQ(''); onItem(i, null); };
  const onCode = async (code: string) => {
    try {
      const r = await api.inventory.lookup(code);
      setUnknown(null);
      if (r.location) { onShelf(r.location); setNote(`${placeName(r.location)} を選びました`); return; }
      const item = r.item ? items.find((i) => i.id === r.item!.id) : undefined;
      if (!item) { setNote(`知らないバーコードです（${r.parsed.code}）`); setUnknown(r.parsed.code); return; }
      setNote(null);
      onItem(item, r);
    } catch (e) {
      setNote(describeError(e, '読めませんでした'));
    }
  };
  const hits = q.trim() ? items.filter((i) => `${i.name}${i.sku}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  return (
    <div className="m-picker">
      <Scanner onCode={(c) => void onCode(c)} busy={busy} />
      {quick.length > 0 && !q && (
        <div className="m-quick" role="group" aria-label="よく使う品目">
          {quick.map((i) => <button key={i.id} className="m-quick-item" onClick={() => choose(i)}>{i.name}</button>)}
        </div>
      )}
      <input className="m-search" placeholder="名前で探す" value={q} onChange={(e) => setQ(e.target.value)} aria-label="品目を名前で探す" />
      {hits.length > 0 && (
        <div className="m-hits">
          {hits.map((i) => <button key={i.id} className="m-hit" onClick={() => choose(i)}>{i.name}</button>)}
        </div>
      )}
      {note && <p className="m-note">{note}</p>}
      {unknown && register && <button className="m-secondary" onClick={() => register(unknown)}>この品目を登録する</button>}
    </div>
  );
}

/** 数を合わせる部品（指で押しやすい大きさ。＋5・＋10 で打たずに大きな数にできる）。 */
function QtyStepper({ value, onChange, unit, min = 1 }: { value: number; onChange: (n: number) => void; unit: string; min?: number }) {
  return (
    <>
      <div className="m-stepper">
        <button className="m-step" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="1 つ減らす">−</button>
        <span className="m-qty">{value}<span className="m-unit">{unit}</span></span>
        <button className="m-step" onClick={() => onChange(value + 1)} aria-label="1 つ増やす">＋</button>
      </div>
      <div className="m-step-more">
        <button className="m-chip-btn" onClick={() => onChange(value + 5)}>＋5</button>
        <button className="m-chip-btn" onClick={() => onChange(value + 10)}>＋10</button>
        <button className="m-chip-btn" onClick={() => onChange(1)} disabled={value === 1}>1 に戻す</button>
      </div>
    </>
  );
}

/** 登録で選べる単位（打たずに選ぶ。どれでもなければ「ほか」で打つ）。 */
const UNIT_CHOICES = ['個', '本', '箱', '枚', '袋', '冊', 'セット'];

/** 登録で作る前の案（読んだコードと、調べて見つかった名前）。 */
interface RegisterDraft { code: string; name: string; category: string; maker: string; found: boolean; force: boolean }

/** 登録した品目（「取り消す」を出すため）。 */
interface Registered { item: InventoryItemView; qty: number; maker: string; warning?: string }

/**
 * 登録: バーコードを読む → 知らなければ JAN で商品名を調べて案を出す → 名前・区分・単位・いまの数を整えて「決定」で作る
 * （第29.11.2節、Q-250）。**読んだだけでは作らない。**
 *
 * 同じ名前でバーコードの無い品目があれば、作らずに結び付けを先に出す。見つからなければ名前を打って作る。
 * 作った直後は「取り消す」で戻せる。
 */
function RegisterFlow({ list, shelf, initialCode, backLabel, onBack, onChanged }: {
  list: InventoryList; shelf: InventoryLocation | null; initialCode: string | null; backLabel: string | null;
  onBack: () => void; onChanged: () => void;
}) {
  const [result, setResult] = useState<InventoryRegisterResult | null>(null);
  const [draft, setDraft] = useState<RegisterDraft | null>(null);
  const [registered, setRegistered] = useState<Registered | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const code = draft?.code ?? (result?.kind === 'similar' ? result.code : null);
  /** カメラで読んだとき。表示中と同じコードは読み直さない（カメラは同じコードを繰り返し読むため）。 */
  const onScan = (scanned: string) => {
    if (busy || scanned === code || (result?.kind === 'known' && result.item.codes?.includes(scanned))
      || registered?.item.codes?.includes(scanned)) return;
    void run(scanned);
  };
  /** 今の結果を閉じて、次の商品を読む。 */
  const skip = () => { setResult(null); setDraft(null); setNote(null); setError(null); setQ(''); };
  /** 読んだコードを調べる（作らない）。 */
  const run = async (scanned: string) => {
    setBusy(true);
    setError(null);
    setRegistered(null);
    setQ('');
    setNote('調べています…');
    try {
      const r = await api.inventory.register(scanned);
      setNote(null);
      if (r.kind === 'proposal' || r.kind === 'notFound') {
        setResult(null);
        setDraft(r.kind === 'proposal'
          ? { code: r.code, name: r.name, category: r.category, maker: r.maker, found: true, force: false }
          : { code: r.code, name: '', category: '', maker: '', found: false, force: false });
      } else {
        setDraft(null);
        setResult(r);
      }
    } catch (e) {
      setNote(null);
      setError(describeError(e, '調べられませんでした'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (initialCode) void run(initialCode); }, [initialCode]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 「決定」で品目を作る。打った名前に同じ名前の品目があれば、作らずに結び付けを先に出す。 */
  const decide = async (d: RegisterDraft, form: { name: string; kind: InventoryItemKind; unit: string; price?: number; qty: number }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.inventory.registerCreate(d.code, {
        ...form, force: d.force, ...(d.category ? { category: d.category } : {}), ...(shelf ? { locationId: shelf.id } : {}),
      });
      if (r.kind === 'created') {
        setDraft(null);
        setRegistered({ item: r.item, qty: form.qty, maker: r.maker, ...(r.warning ? { warning: r.warning } : {}) });
        onChanged();
      } else {
        setDraft(null);
        setResult(r);
      }
    } catch (e) {
      setError(describeError(e, '登録できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const link = async (itemId: string, linkCode: string, itemName: string) => {
    try {
      await api.inventory.update(itemId, { codes: [linkCode] });
      setResult(null);
      setDraft(null);
      setNote(`${itemName} にバーコードを結び付けました`);
      onChanged();
    } catch (e) {
      setError(describeError(e, '結び付けられませんでした'));
    }
  };
  const undo = async (r: Registered) => {
    try {
      await api.inventory.registerUndo(r.item.id);
      setRegistered(null);
      setNote('登録を取り消しました');
      onChanged();
    } catch (e) {
      setError(describeError(e, '取り消せませんでした'));
    }
  };
  const hits = code && q.trim() ? list.items.filter((i) => i.status === 'active' && `${i.name}${i.sku}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];

  return (
    <div className="m-flow">
      <h2 className="m-flow-title">登録{shelf ? <span className="m-sub">{placeName(shelf)}</span> : null}</h2>
      <Scanner onCode={onScan} busy={busy} />
      {note && <p className="m-note" role="status">{note}</p>}
      {error && <p className="m-note error">{error}</p>}
      {registered && (
        <>
          <p className="m-done" role="status">
            「{registered.item.name}」を登録しました{registered.qty > 0 && !registered.warning ? `。${registered.qty} ${registered.item.unit} 入庫しました` : ''}
          </p>
          {registered.warning && <p className="m-note error">{registered.warning}</p>}
          <button className="m-tertiary" onClick={() => void undo(registered)}>取り消す</button>
        </>
      )}
      {result?.kind === 'location' && <p className="m-note">{placeName(result.location)} の棚のラベルです</p>}
      {result?.kind === 'known' && (
        <div className="m-card">
          <div className="m-name">{result.item.name}</div>
          <div className="m-sub">登録済みのバーコードです。使える数 {qtyText(result.item, result.item.available)}</div>
        </div>
      )}
      {result?.kind === 'similar' && (
        <div className="m-card">
          <div className="m-name">{result.name}</div>
          <div className="m-sub">同じ名前の品目があります。同じものなら結び付けてください</div>
          <div className="m-hits">
            {result.similar.map((i) => <button key={i.id} className="m-hit" onClick={() => void link(i.id, result.code, i.name)}>{i.name} に結び付ける</button>)}
          </div>
          <button className="m-secondary" onClick={() => { setDraft({ code: result.code, name: result.name, category: result.category, maker: result.maker, found: true, force: true }); setResult(null); }}>別の品目として登録する</button>
          <button className="m-tertiary" onClick={skip}>スキップして次を読む</button>
        </div>
      )}
      {draft && <DraftCard key={`${draft.code}:${draft.force}`} draft={draft} busy={busy} onDecide={(form) => void decide(draft, form)} onSkip={skip} />}
      {code && (
        <div className="m-card">
          <div className="m-sub">既にある品目に結び付ける</div>
          <input className="m-search" placeholder="名前で探す" value={q} onChange={(e) => setQ(e.target.value)} aria-label="結び付ける品目を探す" />
          {hits.length > 0 && <div className="m-hits">{hits.map((i) => <button key={i.id} className="m-hit" onClick={() => void link(i.id, code, i.name)}>{i.name}</button>)}</div>}
        </div>
      )}
      {backLabel && <button className="m-secondary" onClick={onBack}>{backLabel}</button>}
    </div>
  );
}

/** 作る前の案のカード。名前・区分・単位・いまの数を整え、「決定」で作る（押すまで作らない）。 */
function DraftCard({ draft, busy, onDecide, onSkip }: {
  draft: RegisterDraft; busy: boolean;
  onDecide: (form: { name: string; kind: InventoryItemKind; unit: string; price?: number; qty: number }) => void; onSkip: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [kind, setKind] = useState<InventoryItemKind>('supply');
  const [unit, setUnit] = useState('個');
  const [otherUnit, setOtherUnit] = useState(false);
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState(1);
  const priceNum = kind === 'sale' && price !== '' && Number.isFinite(Number(price)) && Number(price) >= 0 ? Number(price) : undefined;
  return (
    <div className="m-card">
      <div className="m-sub">{draft.found ? `見つかりました${draft.maker ? `（${draft.maker}）` : ''}` : `商品名が見つかりませんでした（${draft.code}）`}</div>
      <input className="m-search" placeholder="品名" value={name} onChange={(e) => setName(e.target.value)} aria-label="品名" />
      <div className="segmented m-purposes" role="radiogroup" aria-label="区分">
        {INVENTORY_ITEM_KINDS.map((k) => (
          <button key={k.id} role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id as InventoryItemKind)}>{k.label}</button>
        ))}
      </div>
      <div className="m-units-pick" role="radiogroup" aria-label="単位">
        {UNIT_CHOICES.map((u) => (
          <button key={u} role="radio" aria-checked={!otherUnit && unit === u} className={`m-chip-btn${!otherUnit && unit === u ? ' on' : ''}`} onClick={() => { setOtherUnit(false); setUnit(u); }}>{u}</button>
        ))}
        <button role="radio" aria-checked={otherUnit} className={`m-chip-btn${otherUnit ? ' on' : ''}`} onClick={() => { setOtherUnit(true); setUnit(''); }}>ほか</button>
      </div>
      {otherUnit && <input className="m-search" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="単位" placeholder="単位（例: 回）" />}
      {kind === 'sale' && <input className="m-search" type="number" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="販売価格" placeholder="販売価格（円）" />}
      <div className="m-sub">いまの数</div>
      <QtyStepper value={qty} onChange={setQty} unit={unit.trim() || '個'} min={0} />
      <button className="m-primary" disabled={busy || !name.trim()}
        onClick={() => onDecide({ name: name.trim(), kind, unit: unit.trim() || '個', ...(priceNum !== undefined ? { price: priceNum } : {}), qty })}>決定</button>
      <button className="m-tertiary" onClick={onSkip}>スキップして次を読む</button>
    </div>
  );
}

/**
 * 入庫・出庫: 読む → 数を合わせる → 記録する。記録したらすぐ次を読める。
 *
 * 出庫は用途を選べ（既定はその品目で前に選んだ用途）、続けて別の品目を読むと前の品目をその数と用途で記録する（第29.9.1節）。
 */
function MoveFlow({ kind, list, shelf, onShelf, onRecorded }: {
  kind: 'in' | 'out'; list: InventoryList; shelf: InventoryLocation | null; onShelf: (l: InventoryLocation) => void; onRecorded: () => void;
}) {
  const [item, setItem] = useState<InventoryItemView | null>(null);
  const [lot, setLot] = useState<{ lot?: string; expiresOn?: string }>({});
  const [qty, setQty] = useState(1);
  const [pack, setPack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<OutDone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<InventoryOutPurpose>('internal');
  const canPack = list.settings.features.units && !!item?.packUnit && !!item?.packSize;
  const [slip, setSlip] = useState<InventorySlipResult | null>(null);

  /** 納品書を撮って入庫する（第29.9節）。照らせた行はすぐ入庫になる。照らせない行はパソコンの画面で入れる。 */
  const takeSlip = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    setDone({ text: '納品書を読み取っています…', moveId: null });
    try {
      setSlip(await api.inventory.slip(f, shelf?.id));
      setDone(null);
      onRecorded();
    } catch (e) {
      setError(describeError(e, '納品書を読み取れませんでした'));
      setDone(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = (i: InventoryItemView, r: Looked | null) => {
    // 同じ品目を続けて読んだら 1 つ足す
    if (item?.id === i.id) { setQty((n) => n + 1); return; }
    // 別の品目を選んだら選び直す（前の品目は記録しない。記録するのは「記録する」を押したときだけ。2026-10-20 に三浦さんが求めた）
    setItem(i);
    setQty(1);
    setPack(false);
    setPurpose(purposeOf(i));
    setError(null);
    setLot(r ? { ...(r.parsed.lot ? { lot: r.parsed.lot } : {}), ...(r.parsed.expiresOn ? { expiresOn: r.parsed.expiresOn } : {}) } : {});
  };
  const record = async () => {
    if (!item || qty <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.inventory.move({
        kind, itemId: item.id, qty, unit: pack && canPack ? 'pack' : 'unit',
        ...(shelf ? { locationId: shelf.id } : {}), ...(kind === 'in' ? lot : { purpose }),
      });
      const how = kind === 'in' ? '入庫' : `出庫（${inventoryPurposeLabel(purpose)}）`;
      setDone({
        text: [`${item.name} を ${pack && canPack ? `${qty} ${item.packUnit}` : `${qty} ${item.unit}`} ${how}しました。使える数は ${qtyText(r.item, r.item.available)}`, ...r.warnings].join('。'),
        moveId: r.moves[0]?.id ?? null,
      });
      setItem(null);
      onRecorded();
    } catch (e) {
      setError(describeError(e, '記録できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  /** 記録したものを取り消す（その日のうちの取り消し。第29.9節）。 */
  const undo = async () => {
    if (!done?.moveId) return;
    try {
      await api.inventory.undo(done.moveId);
      setDone({ text: '取り消しました', moveId: null });
      onRecorded();
    } catch (e) {
      setError(describeError(e, '取り消せませんでした'));
    }
  };

  return (
    <div className="m-flow">
      <h2 className="m-flow-title">{kind === 'in' ? '入庫' : '出庫'}{shelf ? <span className="m-sub">{placeName(shelf)}</span> : null}</h2>
      {/* 出庫のボタンは社内で使うもの（消耗品など）だけ。販売品の出庫は販売管理から API で届く（第29.9.1節） */}
      <Picker items={list.items} onItem={pick} onShelf={onShelf} busy={busy} quickOf={kind === 'out' ? (i) => i.kind !== 'sale' : undefined} />
      {kind === 'in' && (
        <label className="m-secondary m-file">
          納品書を撮る
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void takeSlip(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      )}
      {slip && (
        <div className="m-card">
          {!slip.read.ok ? <p className="m-note error">{slip.read.reason}</p> : (
            <>
              {slip.recorded.map((r, i) => <p key={i} className="m-row-nums">入庫: {r.text}</p>)}
              {slip.unmatched.map((u, i) => (
                <p key={`u${i}`} className="m-sub">入れていない: {u.line.name || u.line.sku || u.line.code}（{u.reason}）</p>
              ))}
              {slip.unmatched.length > 0 && <p className="m-sub">入れていない行は、パソコンの在庫管理の画面で品目を選んで入れられます</p>}
            </>
          )}
        </div>
      )}
      {item && (
        <div className="m-card">
          <div className="m-name">{item.name}</div>
          <div className="m-sub">使える数 {qtyText(item, item.available)}{lot.lot ? `・ロット ${lot.lot}` : ''}{lot.expiresOn ? `・期限 ${lot.expiresOn}` : ''}</div>
          <QtyStepper value={qty} onChange={setQty} unit={pack && canPack ? item.packUnit : item.unit} />
          {canPack && (
            <div className="segmented m-units">
              <button className={!pack ? 'on' : ''} onClick={() => setPack(false)}>{item.unit}</button>
              <button className={pack ? 'on' : ''} onClick={() => setPack(true)}>{item.packUnit}</button>
            </div>
          )}
          {kind === 'out' && <PurposeChips value={purpose} onChange={setPurpose} className="m-purposes" />}
          <button className="m-primary" disabled={busy} onClick={() => void record()}>決定</button>
        </div>
      )}
      {error && <p className="m-note error">{error}</p>}
      {done && <OutDoneLine done={done} onUndo={() => void undo()} className="m-done" />}
    </div>
  );
}

/** 棚卸し: 始める → 棚を読む → 品物を読むたびに 1 つ足す → 差を見る → 確定する。 */
function CountFlow({ list, shelf, onShelf, userId }: {
  list: InventoryList; shelf: InventoryLocation | null; onShelf: (l: InventoryLocation) => void; userId: string;
}) {
  const [view, setView] = useState<InventoryCountView | null | undefined>(undefined);
  const [last, setLast] = useState<InventoryCountRow | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [explain, setExplain] = useState<string | null | undefined>(undefined);
  const [setTo, setSetTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.inventory.counts.current().then((r) => setView(r.open)).catch((e) => setNote(describeError(e, '読み込めませんでした')));
  }, []);
  useEffect(refresh, [refresh]);

  const start = async (onlyShelf: boolean) => {
    try {
      const r = await api.inventory.counts.start(onlyShelf && shelf ? 'location' : 'all', onlyShelf && shelf ? shelf.id : undefined);
      setView(r.view);
    } catch (e) {
      setNote(describeError(e, '始められませんでした'));
    }
  };
  const count = async (itemId: string, extra: { lot?: string; expiresOn?: string } = {}, set?: number) => {
    if (!view) return;
    setBusy(true);
    try {
      const r = await api.inventory.counts.count(view.count.id, {
        itemId, qty: set ?? 1, mode: set === undefined ? 'add' : 'set', ...(shelf ? { locationId: shelf.id } : {}), ...extra,
      });
      setLast(r.row);
      setNote(null);
      refresh();
    } catch (e) {
      setNote(describeError(e, '数えられませんでした'));
    } finally {
      setBusy(false);
    }
  };
  const openDiff = () => {
    setShowDiff(true);
    if (view && view.differing > 0 && explain === undefined) {
      setExplain(null);
      api.inventory.counts.explain(view.count.id).then((r) => setExplain(r.text)).catch(() => setExplain(null));
    }
  };
  const close = async () => {
    if (!view) return;
    try {
      const r = await api.inventory.counts.close(view.count.id);
      setNote(`確定しました。${r.adjusted} 件を調整しました${r.uncounted ? `。数えていない ${r.uncounted} 件はそのままです` : ''}`);
      setShowDiff(false);
      setLast(null);
      refresh();
    } catch (e) {
      setNote(describeError(e, '確定できませんでした'));
    }
  };
  const cancel = async () => {
    if (!view) return;
    try {
      await api.inventory.counts.cancel(view.count.id);
      setNote('棚卸しをやめました。帳簿は変えていません');
      setShowDiff(false);
      refresh();
    } catch (e) {
      setNote(describeError(e, 'やめられませんでした'));
    }
  };

  if (view === undefined) return <p className="muted">読み込んでいます…</p>;
  if (!view) {
    return (
      <div className="m-flow">
        <h2 className="m-flow-title">棚卸し</h2>
        {shelf && <button className="m-big wide" onClick={() => void start(true)}>{placeName(shelf)} を数える</button>}
        <button className={shelf ? 'm-secondary' : 'm-big wide'} onClick={() => void start(false)}>全体を数える</button>
        {note && <p className="m-note">{note}</p>}
      </div>
    );
  }
  const canClose = view.count.startedBy === userId || list.admin;
  const locs = new Map(list.locations.map((l) => [l.id, l]));

  if (showDiff) {
    return (
      <div className="m-flow">
        <h2 className="m-flow-title">差<span className="m-sub">数えた {view.counted}・数えていない {view.uncounted}</span></h2>
        {explain && <div className="m-card m-explain">{explain.split('\n').map((l, i) => <p key={i}>{l.replace(/^-\s*/, '')}</p>)}</div>}
        <div className="m-rows">
          {view.rows.map((r) => (
            <div key={`${r.itemId}:${r.locationId}:${r.lotId ?? ''}`} className={`m-row ${r.counted === null ? 'uncounted' : ''}`}>
              <div className="m-row-name">{r.itemName}<span className="m-sub"> {placeName(locs.get(r.locationId))}{r.lot ? `・${r.lot}` : ''}</span></div>
              <div className="m-row-nums">
                {r.counted === null
                  ? <span className="m-sub">数えていない（帳簿 {qtyText(r, r.book)}）</span>
                  : <>帳簿 {qtyText(r, r.book)} → {qtyText(r, r.counted)} <b className={r.diff && r.diff < 0 ? 'minus' : ''}>{r.diff! > 0 ? '+' : ''}{round(r.diff ?? 0)}</b></>}
              </div>
            </div>
          ))}
        </div>
        {canClose && view.uncounted > 0 && <p className="m-sub m-center">数えていない {view.uncounted} 件はそのままにします</p>}
        {canClose && <button className="m-primary" onClick={() => void close()}>確定する</button>}
        <button className="m-secondary" onClick={() => setShowDiff(false)}>数える画面へ</button>
        {canClose && <button className="m-link danger" onClick={() => void cancel()}>キャンセル</button>}
        {note && <p className="m-note">{note}</p>}
      </div>
    );
  }

  return (
    <div className="m-flow">
      <h2 className="m-flow-title">棚卸し{shelf ? <span className="m-sub">{placeName(shelf)}</span> : null}</h2>
      <Picker items={list.items} busy={busy} onShelf={onShelf}
        onItem={(i, r) => void count(i.id, r ? { ...(r.parsed.lot ? { lot: r.parsed.lot } : {}), ...(r.parsed.expiresOn ? { expiresOn: r.parsed.expiresOn } : {}) } : {})} />
      {last && (
        <div className="m-card">
          <div className="m-name">{last.itemName}{last.lot ? <span className="m-sub"> ロット {last.lot}</span> : null}</div>
          <div className="m-qty big">{qtyText(last, last.counted ?? 0)}</div>
          <div className="m-sub">{placeName(locs.get(last.locationId))}・帳簿 {qtyText(last, last.book)}</div>
          <div className="m-stepper">
            <button className="m-step" disabled={busy} onClick={() => void count(last.itemId, last.lot ? { lot: last.lot } : {})} aria-label="1 つ足す">＋1</button>
            <input className="m-set" type="number" inputMode="decimal" min={0} placeholder="数え直す" value={setTo} onChange={(e) => setSetTo(e.target.value)} aria-label="数え直した数" />
            <button className="m-step" disabled={busy || setTo === ''} onClick={() => {
              const n = Number(setTo);
              if (!Number.isFinite(n) || n < 0) return;
              setSetTo('');
              void count(last.itemId, last.lot ? { lot: last.lot } : {}, n);
            }} aria-label="数え直した数にする">＝</button>
          </div>
        </div>
      )}
      <button className="m-secondary" onClick={openDiff}>差を見る{view.differing ? `（${view.differing}）` : ''}</button>
      {note && <p className="m-note">{note}</p>}
    </div>
  );
}

/** 探す: 読むか名前を入れると、使える数と置き場所を出す。 */
function FindFlow({ list, onShelf }: { list: InventoryList; onShelf: (l: InventoryLocation) => void }) {
  const [detail, setDetail] = useState<InventoryDetail | null>(null);
  const locs = new Map(list.locations.map((l) => [l.id, l]));
  const show = (i: InventoryItemView) => {
    api.inventory.get(i.id).then(setDetail).catch(() => setDetail(null));
  };
  return (
    <div className="m-flow">
      <h2 className="m-flow-title">探す</h2>
      <Picker items={list.items} onItem={(i) => show(i)} onShelf={onShelf} />
      {detail && (
        <div className="m-card">
          <div className="m-name">{detail.item.name}</div>
          <div className="m-qty big">{qtyText(detail.item, detail.item.available)}</div>
          <div className="m-sub">
            使える数{detail.item.onHand !== detail.item.available ? `・在庫 ${qtyText(detail.item, detail.item.onHand)}` : ''}
            {detail.item.expired > 0 ? `・期限切れ ${qtyText(detail.item, detail.item.expired)}` : ''}{detail.item.low ? '・残りわずか' : ''}
          </div>
          {detail.stock.length > 0 && (
            <div className="m-rows">
              {detail.stock.map((s) => (
                <div key={`${s.locationId}:${s.lotId ?? ''}`} className="m-row">
                  <div className="m-row-name">{placeName(locs.get(s.locationId))}{s.lot ? <span className="m-sub"> {s.lot}{s.expiresOn ? `・${s.expiresOn}` : ''}</span> : null}</div>
                  <div className="m-row-nums">{qtyText(detail.item, s.qty)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
