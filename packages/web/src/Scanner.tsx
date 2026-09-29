/**
 * @file バーコードの読み取り（仕様書 第29.11節、ADR-0050）。スマホのカメラで続けて読み、読めたら音と振動で知らせる。
 *
 * 端末を問わず ZXing（画面に同梱）で読む。部品は読み取りを開いたときだけ読み込む（配布物を重くしないため）。
 * カメラは開いている間だけ使い、映像を送らず残さない。読めないときのために、数字を手で入れる欄を置く。
 * USB のバーコードリーダー（キーボードとして入力するもの）は、手で入れる欄にそのまま入る。
 */

import { useEffect, useRef, useState } from 'react';

/** 同じ値を続けて読んだとき、これより短い間隔なら 2 度目を無視する（ミリ秒）。 */
const SAME_CODE_GAP_MS = 1500;

/** 読めたことを短い音で知らせる。音が出せない端末では黙る。 */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1760;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => void ctx.close();
  } catch {
    // 音が出せなくても読み取りは続ける
  }
}

/**
 * バーコードの読み取り。
 *
 * @param onCode 読めた値（GS1 の区切りの文字を含む生の値）。同じ値を続けて読んだときは間を空ける
 * @param onClose 閉じる。省けば「閉じる」を出さない（スマホ用のページは、作業の間カメラを開いたままにする）
 * @param busy 読んだ値の処理中（処理中は次の値を渡さない）
 */
export function Scanner({ onCode, onClose, busy = false }: { onCode: (code: string) => void; onClose?: () => void; busy?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<{ stop(): void; switchTorch?: (on: boolean) => Promise<void> } | null>(null);
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const handler = useRef(onCode);
  const busyRef = useRef(busy);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [manual, setManual] = useState('');
  handler.current = onCode;
  busyRef.current = busy;

  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera');
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
        const hints = new Map<unknown, unknown>([
          [DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.RSS_14, BarcodeFormat.RSS_EXPANDED, BarcodeFormat.QR_CODE,
          ]],
          [DecodeHintType.TRY_HARDER, true],
        ]);
        const reader = new BrowserMultiFormatReader(hints as never, { delayBetweenScanAttempts: 120 });
        if (stopped || !video.current) return;
        const c = await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video.current, (result) => {
          if (!result || busyRef.current) return;
          const code = result.getText();
          const now = Date.now();
          if (code === last.current.code && now - last.current.at < SAME_CODE_GAP_MS) return;
          last.current = { code, at: now };
          beep();
          navigator.vibrate?.(60);
          handler.current(code);
        });
        if (stopped) { c.stop(); return; }
        controls.current = c;
        setTorch(c.switchTorch ? false : null);
      } catch {
        if (!stopped) setError('カメラを使えません。数字を入れるか、名前で探してください');
      }
    })();
    return () => {
      stopped = true;
      controls.current?.stop();
      controls.current = null;
    };
  }, []);

  const toggleTorch = async () => {
    if (!controls.current?.switchTorch || torch === null) return;
    try {
      await controls.current.switchTorch(!torch);
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const submit = () => {
    const code = manual.trim();
    if (!code) return;
    setManual('');
    handler.current(code);
  };

  return (
    <div className="scanner">
      {error
        ? <p className="small muted">{error}</p>
        : <video ref={video} className="scanner-video" muted playsInline aria-label="カメラの映像" />}
      <div className="row wrap">
        <input className="grow" inputMode="numeric" placeholder="バーコードの数字" value={manual} aria-label="バーコードの数字"
          onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        {torch !== null && <button className="btn ghost small" onClick={() => void toggleTorch()}>{torch ? 'ライトを消す' : 'ライト'}</button>}
        {onClose && <button className="btn ghost small" onClick={onClose}>閉じる</button>}
      </div>
    </div>
  );
}
