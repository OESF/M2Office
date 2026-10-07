/**
 * @file 共有の端末の打刻の画面（仕様書 第30.6.3節、ADR-0085）。受付などに置いたタブレットかパソコンで開いたままにする。ログインを使わない。
 *
 * 登録の前は 6 桁の番号を出し、人事の担当者が「シフト」の画面で登録する（店頭サイネージと同じ）。登録の後は端末の鍵で名乗る。
 * 打刻は、画面の QR を本人が自分のスマホで読んで行う（QR は 30 秒ごとに変わる）。会社が許していれば、名前を選んで 4 桁の番号でも打てる。
 * 説明文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useState } from 'react';

const devTenant = new URLSearchParams(location.search).get('tenant');
const KEY = 'm2o.hrTerminal.key';
const KINDS = [['in', '出勤'], ['break_start', '休憩'], ['break_end', '休憩終わり'], ['out', '退勤']] as const;

/** 端末の API を呼ぶ（ログインの Cookie を送らない）。 */
async function termFetch(path: string, init: RequestInit = {}, key: string | null = null): Promise<Response> {
  return fetch(`/v1/hr-terminal${path}`, {
    ...init,
    credentials: 'omit',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(devTenant ? { 'x-tenant': devTenant } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });
}

/** 登録の合言葉（端末だけが知る乱数）。 */
function newSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const readKey = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
const saveKey = (k: string | null) => { try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch { /* 覚えられなくても動く */ } };

/** 登録を待つ（番号を出し、登録されたら鍵を受け取る）。 */
function Pairing({ onKey }: { onKey: (key: string) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const secret = newSecret();
    const retry = (ms: number) => { if (!stop) timer = window.setTimeout(() => setRound((r) => r + 1), ms); };
    void (async () => {
      try {
        const r = await termFetch('/pairings', { method: 'POST', body: JSON.stringify({ secret }) });
        if (r.status === 404) { setOff(true); retry(5 * 60_000); return; }
        if (!r.ok) { retry(30_000); return; }
        const got = (await r.json()) as { code: string };
        if (stop) return;
        setOff(false);
        setCode(got.code);
        const poll = async () => {
          if (stop) return;
          try {
            const p = await termFetch('/pairings/poll', { method: 'POST', body: JSON.stringify({ secret }) });
            const b = (await p.json()) as { status: string; key?: string };
            if (b.status === 'registered' && b.key) { onKey(b.key); return; }
            if (b.status === 'expired') { setRound((x) => x + 1); return; }
          } catch { /* つながらない間は尋ね続ける */ }
          timer = window.setTimeout(() => void poll(), 5000);
        };
        timer = window.setTimeout(() => void poll(), 5000);
      } catch {
        retry(10_000);
      }
    })();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [round, onKey]);
  if (off) return <div className="hr-terminal"><p className="muted">人事・給与を使っていません</p></div>;
  return (
    <div className="hr-terminal">
      <p className="muted">打刻の端末の登録の番号</p>
      <div className="hr-terminal-code">{code ? `${code.slice(0, 3)} ${code.slice(3)}` : '…'}</div>
    </div>
  );
}

/** 名前と番号で打刻する（会社が許したときだけ）。 */
function PinPunch({ people, apiKey, onDone }: { people: { employeeId: string; name: string }[]; apiKey: string; onDone: (text: string) => void }) {
  const [who, setWho] = useState<string>('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const punch = async (kind: string) => {
    setError(null);
    const r = await termFetch('/pin-punch', { method: 'POST', body: JSON.stringify({ employeeId: who, pin, kind }) }, apiKey).catch(() => null);
    const b = r ? (await r.json().catch(() => ({}))) as { error?: string; name?: string; label?: string } : { error: 'つながりませんでした' };
    if (!r?.ok) { setError(b.error ?? '打刻できませんでした'); setPin(''); return; }
    setWho(''); setPin('');
    onDone(`${b.name}さん ${b.label}`);
  };
  return (
    <div className="hr-terminal-pin">
      <select value={who} onChange={(e) => { setWho(e.target.value); setPin(''); setError(null); }} aria-label="名前">
        <option value="">名前で打刻する</option>
        {people.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.name}</option>)}
      </select>
      {who && (
        <>
          <input type="password" inputMode="numeric" maxLength={4} autoComplete="off" placeholder="番号" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="4 桁の番号" />
          <div className="row wrap">
            {KINDS.map(([k, label]) => <button key={k} className="btn" disabled={pin.length !== 4} onClick={() => void punch(k)}>{label}</button>)}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * 共有の端末の打刻の画面（`/hr/terminal`）。
 */
export function HrTerminal() {
  const [key, setKey] = useState<string | null>(readKey);
  const [state, setState] = useState<{ terminal: { name: string }; tenantName: string; expiresAt: string; pinAllowed: boolean; people: { employeeId: string; name: string }[] } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const [done, setDone] = useState<string | null>(null);
  const onKey = useCallback((k: string) => { saveKey(k); setKey(k); }, []);

  useEffect(() => {
    if (!key) return;
    let stop = false;
    let url: string | null = null;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await termFetch('/state', {}, key);
        if (s.status === 401) { saveKey(null); setKey(null); return; }
        if (s.ok) setState(await s.json());
        const svg = await termFetch('/qr.svg', {}, key);
        if (svg.ok && !stop) {
          const next = URL.createObjectURL(await svg.blob());
          if (url) URL.revokeObjectURL(url);
          url = next;
          setQr(next);
        }
      } catch { /* つながらない間は前の QR を出したままにする */ }
      // QR は 30 秒ごとに変わる。少し早めに取り直す
      if (!stop) timer = window.setTimeout(() => void tick(), 25_000);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [key]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(null), 5000); return () => clearTimeout(t); }, [done]);

  if (!key) return <Pairing onKey={onKey} />;
  return (
    <div className="hr-terminal">
      <div className="hr-terminal-clock">{now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}</div>
      {qr ? <img className="hr-terminal-qr" src={qr} alt="打刻の QR" /> : <p className="muted">…</p>}
      {state && <p className="muted small">{state.terminal.name}</p>}
      {done && <p className="ok-msg">{done}</p>}
      {state?.pinAllowed && state.people.length > 0 && <PinPunch people={state.people} apiKey={key} onDone={setDone} />}
    </div>
  );
}
