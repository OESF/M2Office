/**
 * @file サイネージのメッセージ（割り込み）を表示する欄（仕様書 第31.9.3節・第31.9.4節）。スタッフのページ（スマホ）と管理の画面（パソコン）の両方で使う。
 *
 * 表示する画面・よく出す案内と割り込みの素材のボタン・番号の入れ直し・自由な文・表示時間・ジングルを持つ。
 * よく出す案内は自動でボタンに並ぶ（人に一覧を作らせない）。長押しで外す。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SIGNAGE_LIMITS, type SignagePhrase, type SignageScreen } from '@m2office/shared';
import { api, describeError, type SignageAssetView } from './api.js';

/** 出す先を端末に覚える名前（次に開いたときも同じにする）。 */
const TARGET_STORE = 'm2o-signage-target';
const readTarget = (): string[] | null => { try { return JSON.parse(localStorage.getItem(TARGET_STORE) ?? 'null') as string[] | null; } catch { return null; } };
const writeTarget = (v: string[] | null) => { try { localStorage.setItem(TARGET_STORE, JSON.stringify(v)); } catch { /* 保存できない端末 */ } };

/**
 * メッセージを表示する欄。
 *
 * @param screens 会社の画面（表示する先を選ぶ）
 * @param defaults 会社の既定の表示時間とジングル（読み込む前は `null`）
 * @param onSent 表示したあと（画面の様子を読み直す）
 */
export function SignageMessageSender({ screens, defaults, onSent }: {
  screens: SignageScreen[];
  defaults: { seconds: number; chime: boolean } | null;
  onSent: () => void;
}) {
  const [phrases, setPhrases] = useState<SignagePhrase[]>([]);
  const [assets, setAssets] = useState<SignageAssetView[]>([]);
  const [useCount, setUseCount] = useState<Record<string, number>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<string[] | null>(readTarget);
  const [text, setText] = useState('');
  const [numberFor, setNumberFor] = useState<SignagePhrase | null>(null);
  const [num, setNum] = useState('');
  const [seconds, setSeconds] = useState<number | null>(null);
  const [chime, setChime] = useState(true);
  /** 操作の結果の知らせ（失敗は未接続と同じオレンジ系で出す）。 */
  const [message, setMessageState] = useState<{ text: string; warn: boolean } | null>(null);
  const setMessage = (t: string | null, warn = false) => setMessageState(t ? { text: t, warn } : null);
  const press = useRef<number | null>(null);

  const loadButtons = useCallback(() => {
    api.signage.phrases().then((r) => { setPhrases(r.phrases); setUseCount(Object.fromEntries(r.assets.map((a) => [a.assetId, a.count]))); }).catch(() => undefined);
    api.signage.assets().then((r) => setAssets(r.assets.filter((a) => a.isInterrupt))).catch(() => undefined);
  }, []);
  useEffect(loadButtons, [loadButtons]);
  // 会社の既定のジングルに合わせる（最初に読んだときだけ）
  const chimeDefault = defaults?.chime;
  useEffect(() => { if (chimeDefault !== undefined) setChime(chimeDefault); }, [chimeDefault]);
  // ボタンに出す素材の縮小画像
  useEffect(() => {
    for (const a of assets) {
      if (thumbs[a.id]) continue;
      void api.signage.thumbnail(a.id).then((b) => { if (b) setThumbs((t) => ({ ...t, [a.id]: URL.createObjectURL(b) })); });
    }
  }, [assets]); // eslint-disable-line react-hooks/exhaustive-deps

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
      onSent();
      loadButtons();
    } catch (e) {
      setMessage(describeError(e, '表示できませんでした'), true);
    }
  };
  // 長押しで外す（外したものは、また 3 回使うまで出さない）
  const holdStart = (p: SignagePhrase) => { press.current = window.setTimeout(() => { press.current = null; void api.signage.hidePhrase(p.id).then(loadButtons); }, 700); };
  const holdEnd = () => { if (press.current) { clearTimeout(press.current); press.current = null; return true; } return false; };

  const orderedAssets = [...assets].sort((a, b) => (useCount[b.id] ?? 0) - (useCount[a.id] ?? 0)).slice(0, 8);
  return (
    <>
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
          <input inputMode="numeric" autoFocus maxLength={4} value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, ''))} aria-label="番号"
            onKeyDown={(e) => { if (e.key === 'Enter' && num && !e.nativeEvent.isComposing) void send({ text: numberFor.template.replace('{番号}', num) }); }} />
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
    </>
  );
}
