/**
 * @file 共有の端末の QR を本人のスマホで読んだあとの打刻のページ（仕様書 第30.6.3節、ADR-0085）。本人のログインで打つ。
 *
 * QR に入っている端末の印（30 秒ごとに変わる）を添えて打刻し、どの端末で打ったかを記録に残す。いまの状態で押せるものだけを出す。
 * ワークスペースの枠（左のメニュー・秘書の欄）を出さない。
 */

import { useEffect, useState } from 'react';
import type { AttPunchKind } from '@m2office/shared';
import { api, describeError, type MyHrView } from './api.js';

const NEXT: Record<MyHrView['state']['state'], [AttPunchKind, string][]> = {
  off: [['in', '出勤']],
  working: [['break_start', '休憩'], ['out', '退勤']],
  break: [['break_end', '休憩終わり']],
};

/** 共有の端末の QR から開く打刻のページ（`/m/punch?t=…`）。 */
export function MobilePunch() {
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [info, setInfo] = useState<{ terminal: { name: string }; state: MyHrView['state'] } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.myHr.terminal(token).then(setInfo).catch((e) => setMessage({ ok: false, text: describeError(e, '打刻の QR を読めませんでした') }));
  }, [token]);
  const punch = async (kind: AttPunchKind, label: string) => {
    setBusy(true); setMessage(null);
    try {
      const r = await api.myHr.terminalPunch(kind, token);
      const at = new Date(r.punch.at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
      setMessage({ ok: true, text: `${label}しました（${at}・${r.terminal.name}）` });
      setInfo(null);
    } catch (e) {
      setMessage({ ok: false, text: describeError(e, '打刻できませんでした') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="m-inv m-punch">
      {info && <p className="muted small">{info.terminal.name}</p>}
      {message && <p className={message.ok ? 'ok-msg' : 'error'}>{message.text}</p>}
      {info && (
        <div className="m-punch-buttons">
          {NEXT[info.state.state].map(([k, label]) => <button key={k} className="btn" disabled={busy} onClick={() => void punch(k, label)}>{label}</button>)}
        </div>
      )}
    </div>
  );
}
