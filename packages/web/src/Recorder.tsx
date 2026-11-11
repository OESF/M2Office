/**
 * @file その場で録音する画面（仕様書 第9.4.5.1節、ADR-0099）。
 *
 * 業務のファイルの欄と秘書バーから開く。録っている間は画面の上に重ね、止めたらできた録音のファイルを呼び出し側に渡す。
 * 途中の録音があれば、続けて録るか、そこまでで使うか、削除するかを選ばせる。
 *
 * 会議の音を録れる環境（パソコンの Chrome・Edge）では、録り方「マイクだけ」「会議の音も」を選ばせる（第9.4.5.2節、ADR-0137）。
 * いまカレンダーに会議の予定があれば「会議の音も」を先に置く。会議の音で録っている間だけ、相手に伝える一言を出す。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError, type LiveRecordingView, type OngoingMeetingView } from './api.js';
import { clock, LiveRecorder, MeetingAudioMissing, meetingAudioSupported, type CaptureMode } from './live-recorder.js';

type Phase =
  | { kind: 'checking' }
  | { kind: 'resume'; rec: LiveRecordingView }
  | { kind: 'choose'; rec: LiveRecordingView }
  | { kind: 'noAudio'; rec: LiveRecordingView; message: string }
  | { kind: 'recording' }
  | { kind: 'interrupted' }
  | { kind: 'finishing' }
  | { kind: 'error'; message: string };

/** 止めて渡すときに添えること。 */
export interface RecordingInfo {
  /** 会議の音も録った */
  meeting: boolean;
  /** 録っていた間の会議の予定（無ければ `null`） */
  event: OngoingMeetingView | null;
}

/**
 * その場で録音する画面。
 *
 * @param onDone 止めてできた録音のファイル（ID と名前）と、会議の音も録ったかを受ける。呼んだあと画面は閉じる
 * @param onClose 録らずに閉じたとき
 */
export function RecorderDialog({ onDone, onClose }: { onDone: (file: { id: string; name: string }, info: RecordingInfo) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [mode, setMode] = useState<CaptureMode>('mic');
  const [event, setEvent] = useState<OngoingMeetingView | null>(null);
  const eventRef = useRef<OngoingMeetingView | null>(null);
  eventRef.current = event;
  const canMeeting = meetingAudioSupported();
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
      const meeting = r.mode === 'meeting';
      done.current(await r.finish(), { meeting, event: meeting ? eventRef.current : null });
    } catch (e) {
      setPhase({ kind: 'error', message: describeError(e, '録音をまとめられませんでした') });
    }
  }, []);

  /** 録音を（続けて）録る。`meeting` は共有の選びを出すので、押した操作の中から呼ぶ。 */
  const record = useCallback(async (rec: LiveRecordingView, how: CaptureMode = 'mic') => {
    const r = new LiveRecorder(rec.id, rec.nextSeq, rec.seconds, {
      onSeconds: setSeconds,
      onLevel: setLevel,
      onPending: setPending,
      onInterrupted: () => setPhase({ kind: 'interrupted' }),
      onLimit: () => void finish(),
      // 会議のタブを閉じた・共有を止めたら、会議が終わったとして止めて渡す（第9.4.5.2節）
      onMeetingEnded: () => void finish(),
    });
    recorder.current = r;
    setSeconds(rec.seconds);
    setMode(how);
    try {
      await r.capture(how);
      setPhase({ kind: 'recording' });
    } catch (e) {
      if (e instanceof MeetingAudioMissing) { setPhase({ kind: 'noAudio', rec, message: e.message }); return; }
      // マイクを使えなかった。まだ何も録っていない録音は残さない
      if (rec.seconds === 0 && rec.nextSeq === 0) await api.recordings.discard(rec.id).catch(() => undefined);
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'マイクを使えませんでした' });
    }
  }, [finish]);

  /** 録り方を選ばせる（会議の音を録れる環境だけ）。選べなければ、マイクだけですぐ録る。 */
  const begin = useCallback(async (rec: LiveRecordingView) => {
    if (!canMeeting) { await record(rec); return; }
    setEvent((await api.recordings.meeting().catch(() => ({ meeting: null }))).meeting);
    setPhase({ kind: 'choose', rec });
  }, [canMeeting, record]);

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
        await begin(started.recording);
      } catch (e) {
        if (live) setPhase({ kind: 'error', message: describeError(e, '録音を始められませんでした') });
      }
    })();
    return () => { live = false; };
  }, [begin]);

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

  const hm = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
  const meetingFirst = event !== null;

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
      done.current(await api.recordings.finish(rec.id), { meeting: false, event: null });
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
              <button className="btn" onClick={() => void begin(phase.rec)}>続けて録る</button>
              <button className="btn ghost" onClick={() => void useResumed(phase.rec)} disabled={phase.rec.seconds === 0}>ここまでで使う</button>
              <span className="spacer" />
              <button className="btn danger" onClick={() => void removeResumed(phase.rec)}>削除</button>
            </div>
          </>
        )}

        {phase.kind === 'choose' && (
          <>
            <h2>録音</h2>
            {event && <p className="small">{event.title}（{hm(event.start)}〜{hm(event.end)}）</p>}
            <div className="row">
              {meetingFirst ? (
                <>
                  <button className="btn" onClick={() => void record(phase.rec, 'meeting')}>会議の音も</button>
                  <button className="btn ghost" onClick={() => void record(phase.rec, 'mic')}>マイクだけ</button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => void record(phase.rec, 'mic')}>マイクだけ</button>
                  <button className="btn ghost" onClick={() => void record(phase.rec, 'meeting')}>会議の音も</button>
                </>
              )}
              <span className="spacer" />
              <button className="btn ghost" onClick={onClose}>キャンセル</button>
            </div>
          </>
        )}

        {phase.kind === 'noAudio' && (
          <>
            <p className="error">{phase.message}</p>
            <div className="row">
              <button className="btn" onClick={() => void record(phase.rec, 'meeting')}>選び直す</button>
              <button className="btn ghost" onClick={() => void record(phase.rec, 'mic')}>マイクだけで録る</button>
              <span className="spacer" />
              <button className="btn ghost" onClick={onClose}>キャンセル</button>
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
            {/* 会議の音を録っている間だけ。相手の画面には知らせが出ないため（第9.4.5.2節「相手への一言」） */}
            {phase.kind === 'recording' && mode === 'meeting' && <p className="small">録音することを、参加している人に伝えてください</p>}
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
