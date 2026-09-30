/**
 * @file 店頭サイネージのスタッフのページ（`/m/signage`。仕様書 第31.9.3節）。割り込みを出す・消す、いまの各画面、写真を流れに足す。
 *
 * 受付の横で片手で使う。ワークスペースの枠（左のメニュー・秘書の欄）を出さない。よく出す案内は自動でボタンに並ぶ（人に一覧を作らせない）。
 * 番号の入った案内は、押すと番号だけを打ち直せる。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SIGNAGE_LIMITS, type SignageInterruptView, type SignagePhrase, type SignageScreen } from '@m2office/shared';
import { api, describeError, type Me, type SignageAssetView } from './api.js';
import { prepare } from './Signage.js';

/** 出す先を端末に覚える名前（次に開いたときも同じにする）。 */
const TARGET_STORE = 'm2o-signage-target';
const readTarget = (): string[] | null => { try { return JSON.parse(localStorage.getItem(TARGET_STORE) ?? 'null') as string[] | null; } catch { return null; } };
const writeTarget = (v: string[] | null) => { try { localStorage.setItem(TARGET_STORE, JSON.stringify(v)); } catch { /* 保存できない端末 */ } };

/**
 * スタッフのページ。
 *
 * @param me ログインしている人（会社の名前と、サイネージを使えるか）
 */
export function MobileSignage({ me }: { me: Me }) {
  const [screens, setScreens] = useState<SignageScreen[]>([]);
  const [recent, setRecent] = useState<SignageInterruptView[]>([]);
  const [phrases, setPhrases] = useState<SignagePhrase[]>([]);
  const [assets, setAssets] = useState<SignageAssetView[]>([]);
  const [useCount, setUseCount] = useState<Record<string, number>>({});
  const [target, setTarget] = useState<string[] | null>(readTarget);
  const [text, setText] = useState('');
  const [numberFor, setNumberFor] = useState<SignagePhrase | null>(null);
  const [num, setNum] = useState('');
  const [seconds, setSeconds] = useState<number | null>(null);
  const [chime, setChime] = useState(true);
  const [more, setMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const photo = useRef<HTMLInputElement>(null);
  const press = useRef<number | null>(null);

  const load = useCallback(() => {
    api.signage.overview().then((r) => setScreens(r.screens)).catch((e) => setMessage(describeError(e, '読み込めませんでした')));
    api.signage.interrupts().then((r) => setRecent(r.interrupts)).catch(() => undefined);
  }, []);
  const loadButtons = useCallback(() => {
    api.signage.phrases().then((r) => { setPhrases(r.phrases); setUseCount(Object.fromEntries(r.assets.map((a) => [a.assetId, a.count]))); }).catch(() => undefined);
    api.signage.assets().then((r) => setAssets(r.assets.filter((a) => a.isInterrupt))).catch(() => undefined);
  }, []);
  useEffect(() => { load(); loadButtons(); }, [load, loadButtons]);
  // 開いている間、3 秒ごとに状態を読み直す
  useEffect(() => { const t = window.setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    for (const a of assets) {
      if (thumbs[a.id]) continue;
      void api.signage.thumbnail(a.id).then((b) => { if (b) setThumbs((t) => ({ ...t, [a.id]: URL.createObjectURL(b) })); });
    }
  }, [assets]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me.signage) return <div className="m-inv"><p className="muted">サイネージは使えません（会社で切っているか、利用範囲の外です）。</p></div>;

  const chosen = target?.filter((id) => screens.some((s) => s.id === id)) ?? null;
  const toggle = (id: string | null) => {
    const next = id === null ? null : chosen?.includes(id) ? (chosen.filter((x) => x !== id).length ? chosen.filter((x) => x !== id) : null) : [...(chosen ?? []), id];
    setTarget(next);
    writeTarget(next);
  };
  const send = async (input: { text?: string; assetId?: string }) => {
    setMessage(null);
    try {
      const r = await api.signage.sendInterrupt({ ...input, ...(chosen ? { screens: chosen } : {}), ...(seconds ? { seconds } : {}), ...(!chime ? { chime: false } : {}) });
      setMessage(r.screens.length ? '出しました' : '同じ案内を出しています');
      setText('');
      setNumberFor(null);
      setNum('');
      load();
      loadButtons();
    } catch (e) {
      setMessage(describeError(e, '出せませんでした'));
    }
  };
  // 長押しで外す（外したものは、また 3 回使うまで出さない）
  const holdStart = (p: SignagePhrase) => { press.current = window.setTimeout(() => { press.current = null; void api.signage.hidePhrase(p.id).then(loadButtons); }, 700); };
  const holdEnd = () => { if (press.current) { clearTimeout(press.current); press.current = null; return true; } return false; };
  const addPhoto = async (f: File) => {
    const screen = chosen?.length === 1 ? chosen[0]! : null;
    if (!screen) return;
    const p = await prepare(f);
    if ('error' in p || 'guide' in p) { setMessage('error' in p ? p.error : p.guide); return; }
    try {
      const r = await api.signage.upload(p.file, p.name, p.size);
      if (!r.existing && p.thumb) await api.signage.setThumbnail(r.asset.id, p.thumb).catch(() => undefined);
      const flow = await api.signage.flow(screen);
      await api.signage.saveFlow(screen, flow.version, [...flow.entries, { assetId: r.asset.id, seconds: null }]);
      setMessage('流れの最後に足しました');
    } catch (e) {
      setMessage(describeError(e, '足せませんでした'));
    }
  };

  const orderedAssets = [...assets].sort((a, b) => (useCount[b.id] ?? 0) - (useCount[a.id] ?? 0)).slice(0, 8);
  const since = Date.now() - 10 * 60_000;
  return (
    <div className="m-inv m-signage">
      <header className="m-head"><span className="m-title">サイネージ</span><span className="m-tenant">{me.tenant.name}</span></header>
      <div className="m-sig-targets">
        <button className={`m-chip${!chosen ? ' on' : ''}`} onClick={() => toggle(null)}>すべて</button>
        {screens.map((s) => <button key={s.id} className={`m-chip${chosen?.includes(s.id) ? ' on' : ''}`} onClick={() => toggle(s.id)}>{s.name}</button>)}
      </div>
      <div className="m-sig-buttons">
        {orderedAssets.map((a) => (
          <button key={a.id} className="m-sig-button" onClick={() => void send({ assetId: a.id })}>
            {thumbs[a.id] ? <img src={thumbs[a.id]} alt="" /> : null}<span>{a.name}</span>
          </button>
        ))}
        {phrases.map((p) => (
          <button key={p.id} className="m-sig-button text" onPointerDown={() => holdStart(p)} onPointerUp={() => {
            if (!holdEnd()) return;
            if (p.hasNumber) { setNumberFor(p); setNum(''); } else void send({ text: p.template });
          }} onPointerLeave={() => holdEnd()}>
            <span>{p.template.replace('{番号}', '〇')}</span>
          </button>
        ))}
      </div>
      {numberFor && (
        <div className="m-sig-number">
          <input inputMode="numeric" autoFocus maxLength={4} value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, ''))} aria-label="番号" />
          <button className="btn" disabled={!num} onClick={() => void send({ text: numberFor.template.replace('{番号}', num) })}>出す</button>
          <button className="btn ghost" onClick={() => setNumberFor(null)} aria-label="やめる">×</button>
        </div>
      )}
      <div className="m-sig-compose">
        <textarea rows={2} maxLength={SIGNAGE_LIMITS.textChars} value={text} onChange={(e) => setText(e.target.value)} placeholder="出す文" aria-label="出す文" />
        <button className="btn" disabled={!text.trim()} onClick={() => void send({ text })}>出す</button>
      </div>
      <button className="link" onClick={() => setMore(!more)}>{more ? '閉じる' : '秒数・音'}</button>
      {more && (
        <div className="row wrap small">
          <label>秒数 <select value={seconds ?? ''} onChange={(e) => setSeconds(e.target.value ? Number(e.target.value) : null)}>
            <option value="">既定</option>{[5, 10, 15, 20, 30, 45, 60].map((n) => <option key={n} value={n}>{n} 秒</option>)}
          </select></label>
          <label className="check"><input type="checkbox" checked={chime} onChange={(e) => setChime(e.target.checked)} /> ジングル</label>
        </div>
      )}
      {message && <p className="small">{message}</p>}
      <div className="m-sig-screens">
        {screens.map((s) => {
          const mine = recent.filter((i) => i.targets.some((t) => t.screenId === s.id));
          const showingNow = mine.find((i) => i.targets.some((t) => t.screenId === s.id && t.state === 'showing'));
          const waiting = mine.filter((i) => i.targets.some((t) => t.screenId === s.id && t.state === 'waiting')).length;
          const expired = mine.filter((i) => i.targets.some((t) => t.screenId === s.id && t.state === 'expired') && Date.parse(i.createdAt) > since);
          return (
            <div key={s.id} className="card m-sig-screen">
              <div className="row"><strong className="grow">{s.name}</strong>
                {!s.online && <span className="badge warn">つながっていない</span>}
                {s.lastReport?.audio === false && <span className="badge warn">音なし</span>}
              </div>
              <p className="small">{showingNow ? (showingNow.text ?? assets.find((a) => a.id === showingNow.assetId)?.name ?? '割り込み') : '流れ'}{waiting ? `（待ち ${waiting}）` : ''}</p>
              {expired.map((i) => <p key={i.id} className="small error">出せなかった: {i.text ?? assets.find((a) => a.id === i.assetId)?.name ?? ''}</p>)}
              <div className="row">
                {showingNow && <button className="btn ghost small" onClick={() => void api.signage.clearInterrupt(showingNow.id).then(load)}>消す</button>}
                {(showingNow || waiting > 0) && <button className="btn ghost small" onClick={() => void api.signage.clearAll([s.id]).then(load)}>すべて消す</button>}
              </div>
            </div>
          );
        })}
      </div>
      {chosen?.length === 1 && (
        <>
          <button className="btn ghost" onClick={() => photo.current?.click()}>写真・動画を流れに足す</button>
          <input ref={photo} type="file" accept="image/jpeg,image/png,video/mp4" capture="environment" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addPhoto(f); }} />
        </>
      )}
    </div>
  );
}
