/**
 * @file その場で録音する画面（仕様書 第9.4.5.1節、ADR-0099）。
 *
 * 業務のファイルの欄と秘書バーから開く。録っている間は画面の上に重ね、止めたらできた録音のファイルを呼び出し側に渡す。
 * 途中の録音があれば、続けて録るか、そこまでで使うか、削除するかを選ばせる。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError, type LiveRecordingView } from './api.js';
import { clock, LiveRecorder } from './live-recorder.js';

type Phase =
  | { kind: 'checking' }
  | { kind: 'resume'; rec: LiveRecordingView }
  | { kind: 'recording' }
  | { kind: 'interrupted' }
  | { kind: 'finishing' }
  | { kind: 'error'; message: string };

/**
 * その場で録音する画面。
 *
 * @param onDone 止めてできた録音のファイル（ID と名前）を受ける。呼んだあと画面は閉じる
 * @param onClose 録らずに閉じたとき
 */
export function RecorderDialog({ onDone, onClose }: { onDone: (file: { id: string; name: string }) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [pending, setPending] = useState(0);
  const recorder = useRef<LiveRecorder | null>(null);
  // 呼び出し側は描くたびに新しい関数を渡すため、開いたときの処理を描き直しで繰り返さないよう、最新のものを持っておく
  const done = useRef(onDone);
  done.current = onDone;
  const busy = phase.kind === 'recording' || phase.kind === 'finishing';

  const finish = useCallback(async () => {
    const r = recorder.current;
    if (!r) return;
    setPhase({ kind: 'finishing' });
    try {
      done.current(await r.finish());
    } catch (e) {
      setPhase({ kind: 'error', message: describeError(e, '録音をまとめられませんでした') });
    }
  }, []);

  /** 録音を（続けて）録る。 */
  const record = useCallback(async (rec: LiveRecordingView) => {
    const r = new LiveRecorder(rec.id, rec.nextSeq, rec.seconds, {
      onSeconds: setSeconds,
      onLevel: setLevel,
      onPending: setPending,
      onInterrupted: () => setPhase({ kind: 'interrupted' }),
      onLimit: () => void finish(),
    });
    recorder.current = r;
    setSeconds(rec.seconds);
    try {
      await r.capture();
      setPhase({ kind: 'recording' });
    } catch (e) {
      // マイクを使えなかった。まだ何も録っていない録音は残さない
      if (rec.seconds === 0 && rec.nextSeq === 0) await api.recordings.discard(rec.id).catch(() => undefined);
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'マイクを使えませんでした' });
    }
  }, [finish]);

  // 開いたら、途中の録音があるかを見る。無ければすぐ録り始める
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // 何も録れていない途中の録音（マイクの許可を待つ間に閉じたものなど）は、選ばせずにそのまま録る
        const { recording } = await api.recordings.current();
        if (!live) return;
        if (recording && recording.seconds > 0) { setPhase({ kind: 'resume', rec: recording }); return; }
        const started = recording ? { recording, resumed: false } : await api.recordings.start();
        if (!live) return;
        if (started.resumed && started.recording.seconds > 0) { setPhase({ kind: 'resume', rec: started.recording }); return; }
        await record(started.recording);
      } catch (e) {
        if (live) setPhase({ kind: 'error', message: describeError(e, '録音を始められませんでした') });
      }
    })();
    return () => { live = false; };
  }, [record]);

  // 閉じるとき・ページを離れるとき。録っている途中なら止める（送り終えた分はサーバーに残る）
  useEffect(() => () => recorder.current?.pause(), []);
  useEffect(() => {
    if (!busy && !(recorder.current?.pending ?? false)) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy, pending]);
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  /** 止まった録音を、同じ録音の後ろに続けて録る。 */
  const again = async () => {
    const r = recorder.current;
    if (!r) return;
    try {
      await r.capture();
      setPhase({ kind: 'recording' });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'マイクを使えませんでした' });
    }
  };

  const cancel = async () => {
    const r = recorder.current;
    if (r && r.seconds >= 30 && !window.confirm('録音を削除しますか？')) return;
    try {
      if (r) await r.cancel();
    } finally {
      onClose();
    }
  };

  const useResumed = async (rec: LiveRecordingView) => {
    setPhase({ kind: 'finishing' });
    try {
      done.current(await api.recordings.finish(rec.id));
    } catch (e) {
      setPhase({ kind: 'error', message: describeError(e, '録音をまとめられませんでした') });
    }
  };

  const removeResumed = async (rec: LiveRecordingView) => {
    try {
      await api.recordings.discard(rec.id);
      onClose();
    } catch (e) {
      setPhase({ kind: 'error', message: describeError(e, '録音を削除できませんでした') });
    }
  };

  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-label="録音">
      <div className="tour recorder">
        {phase.kind === 'checking' && <p className="muted">録音の用意をしています…</p>}

        {phase.kind === 'resume' && (
          <>
            <h2>途中の録音があります（{clock(phase.rec.seconds)}）</h2>
            <div className="row">
              <button className="btn" onClick={() => void record(phase.rec)}>続けて録る</button>
              <button className="btn ghost" onClick={() => void useResumed(phase.rec)} disabled={phase.rec.seconds === 0}>ここまでで使う</button>
              <span className="spacer" />
              <button className="btn danger" onClick={() => void removeResumed(phase.rec)}>削除</button>
            </div>
          </>
        )}

        {(phase.kind === 'recording' || phase.kind === 'interrupted') && (
          <>
            <div className="recorder-head">
              <span className={`recorder-dot${phase.kind === 'recording' ? ' on' : ''}`} aria-hidden="true" />
              <span className="recorder-time" aria-live="off">{clock(seconds)}</span>
              {phase.kind === 'recording' && (
                <span className="recorder-level" aria-hidden="true"><span style={{ width: `${Math.round(level * 100)}%` }} /></span>
              )}
            </div>
            {phase.kind === 'interrupted' && <p>録音が止まりました（{clock(seconds)} まで録れています）</p>}
            {pending > 1 && <p className="muted small">つながるのを待っています（送れていない録音 {pending * 10} 秒ほど）</p>}
            <div className="row">
              {phase.kind === 'recording' ? (
                <button className="btn" onClick={() => void finish()}>止める</button>
              ) : (
                <>
                  <button className="btn" onClick={() => void again()}>続けて録る</button>
                  <button className="btn ghost" onClick={() => void finish()}>ここまでで使う</button>
                </>
              )}
              <span className="spacer" />
              <button className="btn ghost" onClick={() => void cancel()}>キャンセル</button>
            </div>
          </>
        )}

        {phase.kind === 'finishing' && <p className="muted">{pending ? '残りの録音を送っています…' : '録音をまとめています…'}</p>}

        {phase.kind === 'error' && (
          <>
            <p className="error">{phase.message}</p>
            <div className="row"><span className="spacer" /><button className="btn ghost" onClick={onClose}>閉じる</button></div>
          </>
        )}
      </div>
    </div>
  );
}
