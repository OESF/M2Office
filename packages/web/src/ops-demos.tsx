/**
 * @file マスター管理画面の「体験」（体験版。仕様書 第23.3.2節「マスター管理画面」、ADR-0115）と、設定の体験版の既定。
 *
 * 運営者が相手の会社名・担当者名・案内を送るメールアドレスを入れて体験を出すと、ゲストの ID とパスワードを 1 度だけ出す。
 * 運営者は案内の文を写して、自分のメールで送る（M2Office からは送らない）。一覧には相手の情報と数だけを出し、体験用の会社の中身は見ない。
 * 紹介のページから自分で申し込んだ体験（ADR-0117）も同じ一覧に出し、出し方で見分ける。
 */

import { useCallback, useEffect, useState } from 'react';
import { copyText } from './clipboard.js';
import { OpsTitle } from './ops-help.js';
import { opsApi, OpsApiError, type DemoDefaults, type DemoList, type DemoRow, type OpsMe } from './ops-api.js';

const errText = (e: unknown, fallback: string) => (e instanceof OpsApiError || e instanceof Error ? e.message : fallback);
const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const yen = (n: number) => `${Math.round(n).toLocaleString()} 円`;
const mb = (b: number) => `${Math.round(b / 1e6)} MB`;
const STATE_LABEL: Record<DemoRow['state'], string> = { active: '使える', expired: '期限切れ', ended: '終了' };
const ORIGIN_LABEL: Record<DemoRow['origin'], string> = { ops: '運営が出した', self: '自分で申し込み' };

/** 残りの日数（切り上げ）。 */
function daysLeft(iso: string): string {
  const d = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  return d > 0 ? `残り ${d} 日` : '期限切れ';
}

/** 体験を出したとき・パスワードを出し直したときの、1 度だけの表示。 */
function Issued({ title, loginId, password, url, welcome, onClose }: { title: string; loginId: string; password: string; url: string | null; welcome: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card">
      <h3>{title}</h3>
      <dl className="kv">
        {url && <><dt>入口</dt><dd><code>{url}</code></dd></>}
        <dt>ゲストの ID</dt><dd><code>{loginId}</code></dd>
        <dt>パスワード（いまだけ出します）</dt><dd><code>{password}</code></dd>
      </dl>
      {welcome && <div className="field"><label>相手に送る案内</label><textarea readOnly value={welcome} rows={11} /></div>}
      <button className="btn small" onClick={() => void copyText(welcome ?? `ゲストの ID: ${loginId}\nパスワード: ${password}`).then(setCopied)}>{copied ? '写しました' : '案内を写す'}</button>{' '}
      <button className="btn ghost small" onClick={onClose}>閉じる</button>
    </div>
  );
}

/** 体験を出す。 */
function CreateDemo({ defaults, maxDays, onClose, onCreated }: { defaults: DemoList['defaults']; maxDays: number; onClose: () => void; onCreated: (r: { loginId: string; password: string; url: string; welcome: string }) => void }) {
  const [f, setF] = useState({ company: '', contact: '', email: '', days: String(defaults.days), aiCapJpy: String(defaults.aiCapJpy) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = () => {
    setBusy(true); setError(null);
    opsApi.createDemo({ company: f.company, contact: f.contact, email: f.email, days: Number(f.days), aiCapJpy: Number(f.aiCapJpy) })
      .then(onCreated).catch((e) => setError(errText(e, '出せませんでした'))).finally(() => setBusy(false));
  };
  return (
    <div className="card">
      <h3>体験を出す</h3>
      <div className="field"><label htmlFor="demo-company">相手の会社名</label><input id="demo-company" value={f.company} onChange={set('company')} /></div>
      <div className="field"><label htmlFor="demo-contact">担当者名</label><input id="demo-contact" value={f.contact} onChange={set('contact')} /></div>
      <div className="field"><label htmlFor="demo-email">案内を送るメールアドレス</label><input id="demo-email" type="email" value={f.email} onChange={set('email')} placeholder="name@example.co.jp" /></div>
      <div className="field"><label htmlFor="demo-days">日数</label><input id="demo-days" type="number" min={1} max={maxDays} value={f.days} onChange={set('days')} style={{ maxWidth: 120 }} /></div>
      <div className="field"><label htmlFor="demo-cap">AI の上限（円・期間を通して）</label><input id="demo-cap" type="number" min={1} value={f.aiCapJpy} onChange={set('aiCapJpy')} style={{ maxWidth: 160 }} /></div>
      {error && <p className="error">{error}</p>}
      <button className="btn small" disabled={busy || !f.company.trim()} onClick={submit}>出す</button>{' '}
      <button className="btn ghost small" onClick={onClose}>キャンセル</button>
    </div>
  );
}

/** 「体験」のページ。 */
export function OpsDemos({ me }: { me: OpsMe }) {
  const [list, setList] = useState<DemoList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ title: string; loginId: string; password: string; url: string | null; welcome: string | null } | null>(null);
  const manage = me.can['demo.manage'];
  const load = useCallback(() => { opsApi.demos().then(setList).catch((e) => setError(errText(e, '読み込めませんでした'))); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const extend = (d: DemoRow) => {
    const max = list?.extendMaxDays ?? 7;
    const v = prompt(`${d.company} の体験を何日延ばしますか？（1〜${max} 日）`, String(max));
    if (v === null) return;
    setError(null);
    opsApi.extendDemo(d.id, Number(v)).then(load).catch((e) => setError(errText(e, '延ばせませんでした')));
  };
  const reset = (d: DemoRow) => {
    if (!confirm(`${d.company} のパスワードを出し直しますか？前のパスワードは使えなくなり、ログイン中の画面も切れます。`)) return;
    setError(null);
    opsApi.resetDemoPassword(d.id)
      .then((r) => setIssued({ title: 'パスワードを出し直しました', loginId: d.loginId, password: r.password, url: list?.url ?? null, welcome: null }))
      .catch((e) => setError(errText(e, '出し直せませんでした')));
  };
  const end = (d: DemoRow) => {
    if (!confirm(`${d.company} の体験を終えますか？すぐにログインできなくなり、体験用の会社とデータを削除します（元に戻せません）。`)) return;
    setError(null);
    opsApi.endDemo(d.id).then(load).catch((e) => setError(errText(e, '終えられませんでした')));
  };

  return (
    <>
      <OpsTitle title="体験" help={{ chapter: '16-demo', text: '導入を考えている会社に、体験版のゲストの ID とパスワードを出します。' }} />
      {error && <p className="error">{error}</p>}
      {list && !list.url && <p className="error">体験版の入口が設定されていません（DEMO_SUBDOMAIN）</p>}
      {list?.signupUrl && (
        <p className="small muted">
          申し込みの画面 <code>{list.signupUrl}</code>{list.defaults.selfSignup ? '' : '（止めています）'}・今月の AI {yen(list.aiMonthJpy)} / {yen(list.defaults.monthlyAiCapJpy)}
        </p>
      )}
      {list?.url && manage && !creating && !issued && <p><button className="btn small" onClick={() => setCreating(true)}>体験を出す</button></p>}
      {creating && list && (
        <CreateDemo defaults={list.defaults} maxDays={list.maxDays} onClose={() => setCreating(false)}
          onCreated={(r) => { setCreating(false); setIssued({ title: '出しました', ...r }); load(); }} />
      )}
      {issued && <Issued {...issued} onClose={() => setIssued(null)} />}
      {list && list.demos.length > 0 && (
        <div className="table-scroll"><table className="table ops-table">
          <thead><tr><th>相手</th><th>出し方</th><th>ゲストの ID</th><th>状態</th><th>期限</th><th>最後に使った日時</th><th className="num">ログイン</th><th className="num">AI</th><th className="num">置き場</th><th /></tr></thead>
          <tbody>
            {list.demos.map((d) => (
              <tr key={d.id}>
                <td>{d.contactPurgedAt ? <span className="muted">（相手の情報は削除済み）</span> : <>{d.company}<div className="small muted">{[d.contact, d.email].filter(Boolean).join(' ・ ')}</div></>}</td>
                <td>{ORIGIN_LABEL[d.origin]}</td>
                <td><code>{d.loginId}</code></td>
                <td>{STATE_LABEL[d.state]}{d.lockedUntil && Date.parse(d.lockedUntil) > Date.now() && <span className="badge warn">ログインを止めています</span>}</td>
                <td>{when(d.expiresAt)}<div className="small muted">{d.state === 'active' ? daysLeft(d.expiresAt) : d.deletedAt ? `削除 ${when(d.deletedAt)}` : ''}</div></td>
                <td>{when(d.lastLoginAt)}</td>
                <td className="num">{d.loginCount}</td>
                <td className="num">{yen(d.aiUsedJpy)} / {yen(d.aiCapJpy)}</td>
                <td className="num">{mb(d.filesBytes)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {manage && d.state === 'active' && <>
                    <button className="btn ghost small" onClick={() => extend(d)}>延ばす</button>{' '}
                    <button className="btn ghost small" onClick={() => reset(d)}>パスワードを出し直す</button>{' '}
                  </>}
                  {manage && d.state !== 'ended' && <button className="btn ghost small danger" onClick={() => end(d)}>終える</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {list && list.demos.length === 0 && <p className="muted">出した体験はありません</p>}
    </>
  );
}

/** 設定の「体験版」（日数と AI の上限の既定と、自分で申し込む体験の設定。運営管理者だけが変えられる）。 */
export function DemoDefaultsCard({ me }: { me: OpsMe }) {
  type Form = { days: string; aiCapJpy: string; selfSignup: boolean; dailyLimit: string; monthlyAiCapJpy: string };
  const [f, setF] = useState<Form | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = me.can['settings.manage'];
  const toForm = (d: DemoDefaults): Form => ({
    days: String(d.days), aiCapJpy: String(d.aiCapJpy), selfSignup: d.selfSignup, dailyLimit: String(d.dailyLimit), monthlyAiCapJpy: String(d.monthlyAiCapJpy),
  });
  useEffect(() => {
    opsApi.demos().then((r) => setF(toForm(r.defaults))).catch((e) => setError(errText(e, '読み込めませんでした')));
  }, []);
  const save = () => {
    if (!f) return;
    setMsg(null); setError(null);
    opsApi.setDemoDefaults({
      days: Number(f.days), aiCapJpy: Number(f.aiCapJpy), selfSignup: f.selfSignup, dailyLimit: Number(f.dailyLimit), monthlyAiCapJpy: Number(f.monthlyAiCapJpy),
    }).then((d) => { setF(toForm(d)); setMsg('保存しました'); }).catch((e) => setError(errText(e, '保存できませんでした')));
  };
  return (
    <div className="card">
      <h3>体験版</h3>
      {f && <>
        <div className="field"><label htmlFor="demo-default-days">日数の既定</label><input id="demo-default-days" type="number" min={1} value={f.days} disabled={!manage} onChange={(e) => setF({ ...f, days: e.target.value })} style={{ maxWidth: 120 }} /></div>
        <div className="field"><label htmlFor="demo-default-cap">AI の上限の既定（円・期間を通して）</label><input id="demo-default-cap" type="number" min={1} value={f.aiCapJpy} disabled={!manage} onChange={(e) => setF({ ...f, aiCapJpy: e.target.value })} style={{ maxWidth: 160 }} /></div>
        <div className="field"><label><input type="checkbox" checked={f.selfSignup} disabled={!manage} onChange={(e) => setF({ ...f, selfSignup: e.target.checked })} /> 紹介のページから自分で申し込める</label></div>
        <div className="field"><label htmlFor="demo-daily">自分で申し込む体験の 1 日の数</label><input id="demo-daily" type="number" min={0} value={f.dailyLimit} disabled={!manage} onChange={(e) => setF({ ...f, dailyLimit: e.target.value })} style={{ maxWidth: 120 }} /></div>
        <div className="field"><label htmlFor="demo-monthly">体験版全体の月の AI の上限（円）</label><input id="demo-monthly" type="number" min={0} value={f.monthlyAiCapJpy} disabled={!manage} onChange={(e) => setF({ ...f, monthlyAiCapJpy: e.target.value })} style={{ maxWidth: 160 }} /></div>
        {manage && <button className="btn small" onClick={save}>保存</button>}
      </>}
      {msg && <p className="small">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
