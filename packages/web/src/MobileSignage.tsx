/**
 * @file サイネージのスタッフのページ（`/m/signage`。仕様書 第31.9.3節）。メッセージ（割り込み）を表示する・消す、いまの各画面と
 * そのスケジュール（流れ）、写真・動画をスケジュールに追加する。スタッフの言葉に合わせ、流れを「スケジュール」、割り込みの文を「メッセージ」と呼ぶ。
 *
 * 受付の横で片手で使う。ワークスペースの枠（左のメニュー・秘書の欄）を出さない。よく出す案内は自動でボタンに並ぶ（人に一覧を作らせない）。
 * 番号の入った案内は、押すと番号だけを打ち直せる。説明文を常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type SignageEntry, type SignageInterruptView, type SignageScreen } from '@m2office/shared';
import { api, describeError, type Me, type SignageAssetView } from './api.js';
import { prepare } from './Signage.js';
import { SignageMessageSender } from './signage-message.js';

/**
 * スタッフのページ。
 *
 * @param me ログインしている人（会社の名前と、サイネージを使えるか）
 */
export function MobileSignage({ me }: { me: Me }) {
  const [screens, setScreens] = useState<SignageScreen[]>([]);
  const [recent, setRecent] = useState<SignageInterruptView[]>([]);
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

  const load = useCallback(() => {
    api.signage.overview().then((r) => {
      setScreens(r.screens);
      setDefaults((d) => d ?? { seconds: r.settings.interruptSeconds, chime: r.settings.chime });
    }).catch((e) => setMessage(describeError(e, '読み込めませんでした'), true));
    api.signage.interrupts().then((r) => setRecent(r.interrupts)).catch(() => undefined);
  }, []);
  const loadAssets = useCallback(() => {
    api.signage.assets().then((r) => setAllAssets(r.assets)).catch(() => undefined);
  }, []);
  /** 画面ごとのスケジュールを読む（開いたときと、写真・動画を追加したとき）。 */
  const loadSchedules = useCallback((ids: string[]) => {
    for (const id of ids) void api.signage.flow(id).then((f) => setSchedules((m) => ({ ...m, [id]: f.entries }))).catch(() => undefined);
  }, []);
  useEffect(() => { load(); loadAssets(); }, [load, loadAssets]);
  const screenIds = screens.map((s) => s.id).join(',');
  useEffect(() => { if (screenIds) loadSchedules(screenIds.split(',')); }, [screenIds, loadSchedules]);
  // 開いている間、3 秒ごとに状態を読み直す
  useEffect(() => { const t = window.setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  // スケジュールに出す素材の縮小画像
  const scheduledIds = Object.values(schedules).flat().map((e) => e.assetId).join(',');
  useEffect(() => {
    for (const id of new Set(scheduledIds ? scheduledIds.split(',') : [])) {
      if (thumbs[id]) continue;
      void api.signage.thumbnail(id).then((b) => { if (b) setThumbs((t) => ({ ...t, [id]: URL.createObjectURL(b) })); });
    }
  }, [scheduledIds]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me.signage) return <div className="m-inv"><p className="muted">サイネージは使えません（会社で切っているか、利用範囲の外です）。</p></div>;

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
      loadAssets();
      loadSchedules([screen]);
    } catch (e) {
      setMessage(describeError(e, '追加できませんでした'), true);
    }
  };

  const since = Date.now() - 10 * 60_000;
  return (
    <div className="m-inv m-signage">
      <header className="m-head"><span className="m-title">サイネージ</span><span className="m-tenant">{me.tenant.name}</span></header>

      {/* メッセージ（割り込み）を表示する操作 */}
      <section className="m-sig-section" aria-labelledby="m-sig-send">
        <h2 id="m-sig-send" className="m-sig-heading">メッセージ</h2>
        <SignageMessageSender screens={screens} defaults={defaults} onSent={load} />
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
                {showingNow && <p className="small m-sig-now">表示中: {showingNow.text ?? allAssets.find((a) => a.id === showingNow.assetId)?.name ?? ''}</p>}
                {waiting > 0 && <p className="small muted">待ち {waiting} 件</p>}
                {expired.map((i) => <p key={i.id} className="small m-sig-message warn">表示できなかった: {i.text ?? allAssets.find((a) => a.id === i.assetId)?.name ?? ''}</p>)}
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
