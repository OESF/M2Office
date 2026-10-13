/**
 * @file サイネージのスタッフのページ（`/m/signage`。仕様書 第31.9.3節）。メッセージ（割り込み）を表示する・消す、いまの各画面と
 * そのスケジュール（流れ）、写真・動画をスケジュールに追加する。スタッフの言葉に合わせ、流れを「スケジュール」、割り込みの文を「メッセージ」と呼ぶ。
 *
 * 受付の横で片手で使う。ワークスペースの枠（左のメニュー・秘書の欄）を出さない。よく出す案内は自動でボタンに並ぶ（人に一覧を作らせない）。
 * 番号の入った案内は、押すと番号だけを打ち直せる。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SIGNAGE_LIMITS, type SignageEntry, type SignageInterruptView, type SignagePhrase, type SignageScreen } from '@m2office/shared';
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
  /** 会社の既定（表示時間とジングル）。 */
  const [defaults, setDefaults] = useState<{ seconds: number; chime: boolean } | null>(null);
  /** 画面ごとのスケジュール（いつもの流れ）と、名前を引くための素材。 */
  const [schedules, setSchedules] = useState<Record<string, SignageEntry[]>>({});
  const [allAssets, setAllAssets] = useState<SignageAssetView[]>([]);
  /** 操作の結果の知らせ（失敗は未接続と同じオレンジ系で出す）。 */
  const [message, setMessageState] = useState<{ text: string; warn: boolean } | null>(null);
  const setMessage = (text: string | null, warn = false) => setMessageState(text ? { text, warn } : null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const photo = useRef<HTMLInputElement>(null);
  const press = useRef<number | null>(null);

  const load = useCallback(() => {
    api.signage.overview().then((r) => {
      setScreens(r.screens);
      setDefaults((d) => d ?? { seconds: r.settings.interruptSeconds, chime: r.settings.chime });
    }).catch((e) => setMessage(describeError(e, '読み込めませんでした'), true));
    api.signage.interrupts().then((r) => setRecent(r.interrupts)).catch(() => undefined);
  }, []);
  const loadButtons = useCallback(() => {
    api.signage.phrases().then((r) => { setPhrases(r.phrases); setUseCount(Object.fromEntries(r.assets.map((a) => [a.assetId, a.count]))); }).catch(() => undefined);
    api.signage.assets().then((r) => { setAllAssets(r.assets); setAssets(r.assets.filter((a) => a.isInterrupt)); }).catch(() => undefined);
  }, []);
  /** 画面ごとのスケジュールを読む（開いたときと、写真・動画を追加したとき）。 */
  const loadSchedules = useCallback((ids: string[]) => {
    for (const id of ids) void api.signage.flow(id).then((f) => setSchedules((m) => ({ ...m, [id]: f.entries }))).catch(() => undefined);
  }, []);
  useEffect(() => { load(); loadButtons(); }, [load, loadButtons]);
  const screenIds = screens.map((s) => s.id).join(',');
  useEffect(() => { if (screenIds) loadSchedules(screenIds.split(',')); }, [screenIds, loadSchedules]);
  // 会社の既定のジングルに合わせる（最初に読んだときだけ）
  useEffect(() => { if (defaults) setChime(defaults.chime); }, [defaults]);
  // 開いている間、3 秒ごとに状態を読み直す
  useEffect(() => { const t = window.setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  // ボタンとスケジュールに出す素材の縮小画像
  const scheduledIds = Object.values(schedules).flat().map((e) => e.assetId).join(',');
  useEffect(() => {
    const ids = new Set([...assets.map((a) => a.id), ...(scheduledIds ? scheduledIds.split(',') : [])]);
    for (const id of ids) {
      if (thumbs[id]) continue;
      void api.signage.thumbnail(id).then((b) => { if (b) setThumbs((t) => ({ ...t, [id]: URL.createObjectURL(b) })); });
    }
  }, [assets, scheduledIds]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me.signage) return <div className="m-inv"><p className="muted">サイネージは使えません（会社で切っているか、利用範囲の外です）。</p></div>;

  // 覚えていた画面が無くなっていれば（切断した画面など）、すべての画面に戻す（表示する先が空のまま送らない）
  const kept = target?.filter((id) => screens.some((s) => s.id === id)) ?? null;
  const chosen = kept && kept.length ? kept : null;
  const toggle = (id: string | null) => {
    const next = id === null ? null : chosen?.includes(id) ? (chosen.filter((x) => x !== id).length ? chosen.filter((x) => x !== id) : null) : [...(chosen ?? []), id];
    setTarget(next);
    writeTarget(next);
  };
  const send = async (input: { text?: string; assetId?: string }) => {
    setMessage(null);
    try {
      const r = await api.signage.sendInterrupt({ ...input, ...(chosen ? { screens: chosen } : {}), ...(seconds ? { seconds } : {}), ...(!chime ? { chime: false } : {}) });
      setMessage(r.screens.length ? '表示しました' : '同じメッセージを表示しています');
      setText('');
      setNumberFor(null);
      setNum('');
      load();
      loadButtons();
    } catch (e) {
      setMessage(describeError(e, '表示できませんでした'), true);
    }
  };
  // 長押しで外す（外したものは、また 3 回使うまで出さない）
  const holdStart = (p: SignagePhrase) => { press.current = window.setTimeout(() => { press.current = null; void api.signage.hidePhrase(p.id).then(loadButtons); }, 700); };
  const holdEnd = () => { if (press.current) { clearTimeout(press.current); press.current = null; return true; } return false; };
  /** 写真・動画を足す先の画面（各画面の欄の「写真・動画を追加」で決める）。 */
  const addTo = useRef<string | null>(null);
  const addPhoto = async (f: File) => {
    const screen = addTo.current;
    if (!screen) return;
    const p = await prepare(f);
    if ('error' in p || 'guide' in p) { setMessage('error' in p ? p.error : p.guide, true); return; }
    try {
      const r = await api.signage.upload(p.file, p.name, p.size);
      if (!r.existing && p.thumb) await api.signage.setThumbnail(r.asset.id, p.thumb).catch(() => undefined);
      const flow = await api.signage.flow(screen);
      await api.signage.saveFlow(screen, flow.version, [...flow.entries, { assetId: r.asset.id, seconds: null }]);
      setMessage(`${screens.find((x) => x.id === screen)?.name ?? ''}のスケジュールの最後に追加しました`);
      loadButtons();
      loadSchedules([screen]);
    } catch (e) {
      setMessage(describeError(e, '追加できませんでした'), true);
    }
  };

  const orderedAssets = [...assets].sort((a, b) => (useCount[b.id] ?? 0) - (useCount[a.id] ?? 0)).slice(0, 8);
  const since = Date.now() - 10 * 60_000;
  return (
    <div className="m-inv m-signage">
      <header className="m-head"><span className="m-title">サイネージ</span><span className="m-tenant">{me.tenant.name}</span></header>

      {/* メッセージ（割り込み）を表示する操作 */}
      <section className="m-sig-section" aria-labelledby="m-sig-send">
        <h2 id="m-sig-send" className="m-sig-heading">メッセージ</h2>
        <div className="m-sig-targets" role="group" aria-label="表示する画面">
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
            <button className="btn" disabled={!num} onClick={() => void send({ text: numberFor.template.replace('{番号}', num) })}>表示</button>
            <button className="btn ghost" onClick={() => setNumberFor(null)}>キャンセル</button>
          </div>
        )}
        <div className="m-sig-compose">
          <textarea rows={2} maxLength={SIGNAGE_LIMITS.textChars} value={text} onChange={(e) => setText(e.target.value)} placeholder="メッセージ" aria-label="メッセージ" />
          <button className="btn" disabled={!text.trim()} onClick={() => void send({ text })}>表示</button>
        </div>
        <div className="m-sig-options small">
          <label>表示時間
            <select value={seconds ?? ''} onChange={(e) => setSeconds(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{defaults ? `デフォルト（${defaults.seconds}秒）` : 'デフォルト'}</option>
              {[5, 10, 15, 20, 30, 45, 60].map((n) => <option key={n} value={n}>{n}秒</option>)}
            </select>
          </label>
          <span className="row small">ジングル
            <button type="button" role="switch" aria-checked={chime} aria-label="ジングル" className={chime ? 'switch on' : 'switch'} onClick={() => setChime(!chime)}><span /></button>
          </span>
        </div>
        {message && <p className={`small m-sig-message${message.warn ? ' warn' : ''}`} role="status">{message.text}</p>}
      </section>

      {/* 画面ごとの様子とスケジュール（確認と、写真・動画の追加） */}
      <section className="m-sig-section" aria-labelledby="m-sig-screens">
        <h2 id="m-sig-screens" className="m-sig-heading">画面とスケジュール</h2>
        <div className="m-sig-screens">
          {screens.map((s) => {
            const mine = recent.filter((i) => i.targets.some((t) => t.screenId === s.id));
            const showingNow = mine.find((i) => i.targets.some((t) => t.screenId === s.id && t.state === 'showing'));
            const waiting = mine.filter((i) => i.targets.some((t) => t.screenId === s.id && t.state === 'waiting')).length;
            const expired = mine.filter((i) => i.targets.some((t) => t.screenId === s.id && t.state === 'expired') && Date.parse(i.createdAt) > since);
            const schedule = schedules[s.id] ?? [];
            return (
              <div key={s.id} className="card m-sig-screen">
                <div className="row"><strong className="grow">{s.name}</strong>
                  {!s.online && <span className="badge warn">未接続</span>}
                  {s.online && s.lastReport?.audio === false && <span className="badge warn">音なし</span>}
                </div>
                {/* メッセージを表示しているとき・待っているときだけ出す（いつもの状態の言葉は出さない） */}
                {showingNow && <p className="small m-sig-now">表示中: {showingNow.text ?? assets.find((a) => a.id === showingNow.assetId)?.name ?? ''}</p>}
                {waiting > 0 && <p className="small muted">待ち {waiting} 件</p>}
                {expired.map((i) => <p key={i.id} className="small m-sig-message warn">表示できなかった: {i.text ?? assets.find((a) => a.id === i.assetId)?.name ?? ''}</p>)}
                {(showingNow || waiting > 0) && (
                  <div className="row">
                    {showingNow && <button className="btn ghost small" onClick={() => void api.signage.clearInterrupt(showingNow.id).then(load)}>消す</button>}
                    <button className="btn ghost small" onClick={() => void api.signage.clearAll([s.id]).then(load)}>すべて消す</button>
                  </div>
                )}
                {/* この画面のスケジュール（いつもの流れ。止めている行は薄く） */}
                <div className="m-sig-schedule-head small"><span className="grow">スケジュール{schedule.length ? `（${schedule.length}）` : ''}</span>
                  <button className="btn ghost small" onClick={() => { addTo.current = s.id; photo.current?.click(); }}>写真・動画を追加</button>
                </div>
                {schedule.length > 0 ? (
                  <div className="m-sig-schedule" aria-label={`${s.name}のスケジュール`}>
                    {schedule.map((e, i) => {
                      const a = allAssets.find((x) => x.id === e.assetId);
                      return (
                        <div key={`${e.assetId}-${i}`} className={`m-sig-schedule-item${e.paused ? ' paused' : ''}`}>
                          {thumbs[e.assetId] ? <img src={thumbs[e.assetId]} alt="" /> : <span className="m-sig-schedule-blank" />}
                          <span>{a?.name ?? ''}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : <p className="small muted">まだ何もありません</p>}
              </div>
            );
          })}
        </div>
        <input ref={photo} type="file" accept="image/jpeg,image/png,video/mp4" capture="environment" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addPhoto(f); }} />
      </section>
    </div>
  );
}
