/**
 * @file ローカルの形の「機械」の画面（仕様書 第8.6.7節）。管理者ページの「機械」と、機械の管理者の画面（第8.6.3節）で同じものを使う。
 *
 * 版と更新・各部の動き・ディスク・証明書・ローカル AI・控え・遠隔の保守・稼働の知らせ・システムログと証拠保全。業務の中身は出さない。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError, type MachineApi, type MachineView } from './api.js';
import { PageTitle, type PageHelp } from './help.js';
import { SystemLogs, type LogSource } from './SystemLogs.js';
import { RuntimeCard } from './runtime-card.js';

/** バイトを GB・MB で表す。 */
const bytesText = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
/** 日時を「10/7 2:03」の形で表す。 */
const whenText = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * ローカルの形の「機械」（仕様書 第8.6.7節）。版・各部の動き・ディスク・証明書・ローカル AI・控え。今すぐ控えを取れる。
 *
 * @param fns 機械の口（会社の管理者は管理者ページの口、機械の管理者は機械の管理者の口。第8.6.3節）
 * @param help 題名の「？」で開くヘルプ（ヘルプを読めない機械の管理者の画面では出さない）
 */
export function MachinePanel({ fns, help }: { fns: MachineApi; help?: PageHelp }) {
  const [data, setData] = useState<MachineView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { fns.machine().then(setData).catch((e) => setError(describeError(e, '読み込めませんでした'))); }, [fns]);
  useEffect(() => { load(); const t = window.setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const backup = () => {
    setNote(null);
    fns.machineBackup().then(() => setNote('控えを取り始めました。1 分ほどで結果が出ます')).catch((e) => setError(describeError(e, '頼めませんでした')));
  };
  const state = (ok: boolean, okText: string, ngText: string) => <span className={`badge ${ok ? 'ok' : 'warn'}`}>{ok ? okText : ngText}</span>;
  const space = (d: { free: number; total: number } | null) => (d ? `空き ${bytesText(d.free)} / ${bytesText(d.total)}` : '分かりません');
  const logs = useMemo(() => machineLogs(fns), [fns]);
  const st = data?.backup.status;
  const off = data?.backup.offsite.status;
  return (
    <>
      <PageTitle trail={['機械']} help={help ?? null} />
      {/* 動いている環境（第8.6.7.1節）。いちばん上に置き、すぐ下に機械の資源（第23.8.7節「機械の資源の図」） */}
      <RuntimeCard load={fns.runtime} loadSamples={fns.runtimeSamples} />
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="card">
            <h3>各部の動き</h3>
            <dl className="kv">
              <dt>版</dt><dd>{data.version}</dd>
              <dt>データベース</dt><dd>{state(data.database.ok, '動いています', '止まっています')} {data.database.ms !== null && <span className="small muted">{data.database.ms} ms</span>} {data.database.error && <span className="small muted">{data.database.error}</span>}</dd>
              <dt>ワーカー</dt><dd>{state(data.worker.ok, '動いています', '止まっています')} {data.worker.lastSeen && <span className="small muted">最後の知らせ {whenText(data.worker.lastSeen)}</span>}</dd>
              <dt>入口と証明書</dt><dd>{data.entrance.host ? <>{data.entrance.host} {data.entrance.certExpires
                ? state((data.entrance.certDaysLeft ?? 0) > 14, `期限 ${whenText(data.entrance.certExpires)}（あと ${data.entrance.certDaysLeft} 日）`, `期限 ${whenText(data.entrance.certExpires)}（あと ${data.entrance.certDaysLeft} 日）`)
                : <span className="badge warn">確かめられません</span>} {data.entrance.error && <span className="small muted">{data.entrance.error}</span>}</> : <span className="muted">—</span>}</dd>
              <dt>ローカル AI</dt><dd>{data.localAi.configured ? <>{state(data.localAi.ok, '動いています', '答えません')} <span className="small muted">{data.localAi.models.join('、') || data.localAi.error}</span></> : <span className="muted">設定していません</span>}</dd>
              <dt>データのディスク</dt><dd>{space(data.disk.data)}</dd>
            </dl>
          </div>
          <div className="card">
            <h3>控え</h3>
            {!data.backup.configured ? <p className="muted">控えの置き場が設定されていません</p> : (
              <>
                <dl className="kv">
                  <dt>最後の控え</dt><dd>{st?.last ? <>{state(st.last.ok, whenText(st.last.at), `${whenText(st.last.at)} 失敗`)} {st.last.ok ? <span className="small muted">データベース {bytesText(st.last.dbBytes)}</span> : <span className="small muted">{st.last.error}</span>}</> : <span className="muted">まだありません</span>}</dd>
                  <dt>戻せるかの確かめ</dt><dd>{st?.restoreTest ? <>{state(st.restoreTest.ok, `${whenText(st.restoreTest.at)} 戻せました`, `${whenText(st.restoreTest.at)} 戻せませんでした`)} {st.restoreTest.error && <span className="small muted">{st.restoreTest.error}</span>}</> : <span className="muted">まだありません</span>}</dd>
                  <dt>控えのディスク</dt><dd>{space(data.disk.backup)}</dd>
                  <dt>社外の控え</dt><dd>{!data.backup.offsite.configured ? <span className="muted">設定していません</span> : off?.last
                    ? <>{state(off.last.ok, `${whenText(off.last.at)} 送りました`, `${whenText(off.last.at)} 送れませんでした`)} {off.last.ok ? <span className="small muted">新しく送った量 {bytesText(off.last.bytesAdded)}</span> : <span className="small muted">{off.last.error}</span>}</>
                    : <span className="muted">まだありません</span>}</dd>
                  {data.backup.offsite.configured && <><dt>社外の控えの確かめ</dt><dd>{off?.check ? <>{state(off.check.ok, `${whenText(off.check.at)} 壊れていません`, `${whenText(off.check.at)} 確かめに失敗`)} {off.check.error && <span className="small muted">{off.check.error}</span>}</> : <span className="muted">まだありません</span>}</dd></>}
                </dl>
                <button className="btn small" onClick={backup}>今すぐ控えを取る</button>
                {note && <p className="ok-msg small">{note}</p>}
              </>
            )}
          </div>
          <MachineUpdate fns={fns} data={data.update} onChanged={load} onError={setError} />
          <MachineMaintenance fns={fns} data={data.maintenance} onChanged={load} onError={setError} />
        </>
      )}
      <SystemLogs source={logs} />
    </>
  );
}

/** 「機械」のシステムログと証拠保全の口（ローカルの形の管理者と機械の管理者。仕様書 第16.10.4節・第16.10.5節）。 */
const machineLogs = (fns: MachineApi): LogSource => ({
  load: (q) => fns.systemLogs(q),
  digests: (q) => fns.systemLogDigests(q),
  exportLogs: (q, format) => fns.systemLogExport(q, format),
  files: { list: () => fns.systemLogFiles(), download: (name) => fns.systemLogFile(name) },
  evidence: {
    list: () => fns.evidence(),
    create: (_tenant, reason, days) => fns.createEvidence(reason, days),
    download: (id) => fns.downloadEvidence(id),
    remove: (id, reason) => fns.deleteEvidence(id, reason),
    canCreate: true,
  },
  describe: (e, fallback) => describeError(e, fallback),
});

/** 更新の結果の呼び名。 */
const UPDATE_RESULT: Record<string, string> = { updated: '入れました', 'rolled-back': '入れられず、前の版に戻しました', failed: '入れられませんでした', none: '新しい版はありませんでした' };

/**
 * 「機械」の更新（仕様書 第8.6.4節）。直近の結果と、夜の自動の更新を止める・延ばす。
 *
 * @remarks 更新そのものは機械の上で動く（導入した技術者が設定する）。ここからは止める・延ばすことだけができる
 */
function MachineUpdate({ fns, data, onChanged, onError }: { fns: MachineApi; data: MachineView['update']; onChanged: () => void; onError: (m: string) => void }) {
  const hold = (days: number | null) => void fns.machineUpdateHold(days).then(onChanged).catch((e) => onError(describeError(e, '変えられませんでした')));
  const s = data.settings;
  return (
    <div className="card">
      <h3>更新</h3>
      <dl className="kv">
        <dt>自動の更新</dt><dd>{!s ? <span className="muted">設定されていません</span> : s.auto ? `毎晩 ${s.hour} 時ごろ` : <span className="muted">切っています{s.signed ? '' : '（署名の鍵が入っていません）'}</span>}</dd>
        <dt>直近の更新</dt><dd>{data.last ? <>
          <span className={`badge ${data.last.result === 'updated' || data.last.result === 'none' ? 'ok' : 'warn'}`}>{whenText(data.last.at)} {UPDATE_RESULT[data.last.result] ?? data.last.result}</span>
          {' '}<span className="small muted">{data.last.result === 'none' ? data.last.from : `${data.last.from} → ${data.last.to}`}{data.last.error ? `（${data.last.error}）` : ''}</span>
        </> : <span className="muted">まだありません</span>}</dd>
        {data.heldUntil && <><dt>止めている</dt><dd>{whenText(data.heldUntil)} まで</dd></>}
      </dl>
      {s?.auto && (data.heldUntil
        ? <button className="btn ghost small" onClick={() => hold(null)}>止めるのをやめる</button>
        : <button className="btn ghost small" onClick={() => hold(7)}>7 日延ばす</button>)}
    </div>
  );
}

/**
 * 「機械」の遠隔の保守（仕様書 第8.6.4節）。
 *
 * @remarks 遠隔の保守は、ふだん閉じておき、会社の管理者が時間を限って開ける（運営は自分で開けられない）。開けた回と、つないだ相手を出す。
 * 同じ機械の M2Medical が持つときは、開けるボタンを出さず、どちらが開けるかだけを出す（第8.6.9節）
 */
function MachineMaintenance({ fns, data, onChanged, onError }: {
  fns: MachineApi; data: MachineView['maintenance']; onChanged: () => void; onError: (m: string) => void;
}) {
  const [hours, setHours] = useState(4);
  const run = (p: Promise<unknown>) => void p.then(onChanged).catch((e) => onError(describeError(e, '変えられませんでした')));
  const managed = data.managedBy ?? null;
  if (!data.configured && !managed) return null;
  return (
    <div className="card">
      <h3>遠隔の保守</h3>
      <dl className="kv">
        {managed && <><dt>遠隔の保守</dt><dd className="muted">{managed} の管理者が開けます</dd></>}
        {data.configured && (
          <>
            <dt>遠隔の保守</dt>
            <dd>{data.until ? <span className="badge warn">{whenText(data.until)} まで開けています{data.open ? '' : '（開けている途中）'}</span> : <span className="muted">閉じています</span>}</dd>
            {data.sessions.length > 0 && <><dt>これまで</dt><dd><ul className="plain small">{data.sessions.slice(0, 5).map((s) => (
              <li key={s.openedAt}>{whenText(s.openedAt)}〜{s.closedAt ? whenText(s.closedAt) : ''} {s.peers.length ? `つないだ相手: ${s.peers.join('、')}` : 'つないだ相手なし'}</li>
            ))}</ul></dd></>}
          </>
        )}
      </dl>
      <div className="row wrap">
        {data.configured && (data.until
          ? <button className="btn ghost small" onClick={() => run(fns.machineMaintenance(null))}>閉じる</button>
          : <>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="開けておく時間">
              {[1, 2, 4, 8, 24].map((h) => <option key={h} value={h}>{h} 時間</option>)}
            </select>
            <button className="btn small" onClick={() => run(fns.machineMaintenance(hours))}>遠隔の保守を開ける</button>
          </>)}
      </div>
    </div>
  );
}
