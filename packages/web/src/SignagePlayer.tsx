/**
 * @file 店頭サイネージの再生のページ（`/signage/play`。仕様書 第31.9.1節）。端末のブラウザで全画面に開き、何か月も開いたまま動かす。
 *
 * **ログインを使わない。** 鍵が無ければ登録の番号と QR を出し、管理者が登録すると画面の鍵を受け取る（第31.5.1節）。
 * 鍵があれば流れを読み、素材を端末に取り置いてから、画像と動画を順に流す。通信が切れても、取り置いた流れを流し続ける。
 * ワークスペースの枠（左のメニュー・秘書の欄）と、ワークスペースの API の呼び出し口（ログインの扱い）を使わない。
 * 説明の文は出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { APP_VERSION } from './version.js';

/** 端末に置く画面の鍵・最後の状態・夜中の読み直しの日の名前。 */
const KEY_STORE = 'm2o-signage-key';
const STATE_STORE = 'm2o-signage-state';
const RELOAD_STORE = 'm2o-signage-reloaded';
/** 素材を取り置く場所の名前。 */
const CACHE_NAME = 'm2o-signage-assets';
/** 開発のときだけ、会社を URL の `tenant` で決める（ワークスペースと同じ）。 */
const devTenant = new URLSearchParams(location.search).get('tenant');

/** 再生に要る状態（`GET /v1/signage-play/state`）。 */
interface PlayState {
  screen: { id: string; name: string; orientation: 'landscape' | 'portrait'; rotation: 0 | 90 | 180 | 270; flowVersion: number };
  entries: { assetId: string; seconds: number | null }[];
  assets: { id: string; kind: 'image' | 'video'; mime: string; sha256: string; bytes: number; width: number; height: number; durationMs: number | null }[];
  imageSeconds: number;
  color: string;
  company: string;
  serverTime: string;
  pageVersion: string | null;
}

/** 表示の 1 枚（前と後ろの 2 枚を重ねて切り替える）。 */
interface Layer { seq: number; assetId: string; kind: 'image' | 'video'; url: string; thumb: string | null; seconds: number; durationMs: number | null }

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 保存できない端末 */ } };

/** 再生のページの API を呼ぶ（画面の鍵を見出しに付ける。URL に載せない）。 */
async function playFetch(path: string, init: RequestInit = {}, key: string | null = null): Promise<Response> {
  return fetch(`/v1/signage-play${path}`, {
    ...init,
    credentials: 'omit',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(devTenant ? { 'x-tenant': devTenant } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });
}

/** 取り置きの場所の名前（素材の SHA-256 で置く。中身が同じなら取り直さない）。 */
const cacheUrl = (sha: string, thumb = false) => `/signage-cache/${thumb ? 'thumb-' : ''}${sha}`;

/** 素材を取り置く。取り置きの場所が使えない端末では記憶に持つ。 */
const memory = new Map<string, Blob>();
async function cached(url: string): Promise<Blob | null> {
  if (memory.has(url)) return memory.get(url)!;
  if (typeof caches === 'undefined') return null;
  const hit = await (await caches.open(CACHE_NAME)).match(url);
  return hit ? hit.blob() : null;
}
async function putCache(url: string, blob: Blob): Promise<void> {
  if (typeof caches === 'undefined') { memory.set(url, blob); return; }
  await (await caches.open(CACHE_NAME)).put(url, new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }));
}
/** 流れから外れた素材を取り置きから消す。 */
async function pruneCache(keep: Set<string>): Promise<void> {
  for (const k of [...memory.keys()]) if (!keep.has(k)) memory.delete(k);
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(CACHE_NAME);
  for (const req of await cache.keys()) if (!keep.has(new URL(req.url).pathname)) await cache.delete(req);
}
async function clearCache(): Promise<void> {
  memory.clear();
  if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME).catch(() => false);
}

/**
 * 再生のページ。鍵が無ければ登録、あれば再生。
 */
export function SignagePlayer() {
  const [key, setKey] = useState<string | null>(() => read(KEY_STORE));
  // ページそのものを端末に取り置き、つながらないまま電源を入れ直しても開けるようにする（第31.9.1節）
  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/signage-sw.js', { scope: '/signage/' }).catch(() => undefined);
  }, []);
  if (!key) return <Pairing onKey={(k) => { write(KEY_STORE, k); setKey(k); }} />;
  return (
    <Player
      screenKey={key}
      onUnregistered={() => {
        // 外された（第31.5.1節）。鍵と取り置きを消して、登録の番号の表示に戻る
        write(KEY_STORE, null);
        write(STATE_STORE, null);
        void clearCache();
        setKey(null);
      }}
    />
  );
}

/** 推測されにくい登録の合言葉（32 字）。 */
function newSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 登録の番号と QR を出し、登録されたら画面の鍵を受け取る（第31.5.1節）。 */
function Pairing({ onKey }: { onKey: (key: string) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    let qrUrl: string | null = null;
    const secret = newSecret();
    const retry = (ms: number) => { if (!stop) timer = window.setTimeout(() => setRound((r) => r + 1), ms); };
    void (async () => {
      try {
        const r = await playFetch('/pairings', { method: 'POST', body: JSON.stringify({ secret, viewport: { width: screen.width || innerWidth, height: screen.height || innerHeight } }) });
        if (r.status === 404) { setOff(true); retry(5 * 60_000); return; }
        if (!r.ok) { retry(30_000); return; }
        const got = (await r.json()) as { code: string };
        if (stop) return;
        setOff(false);
        setCode(got.code);
        const svg = await playFetch(`/pairings/qr.svg?code=${got.code}`);
        if (svg.ok && !stop) { qrUrl = URL.createObjectURL(await svg.blob()); setQr(qrUrl); }
        // 5 秒ごとに「登録されたか」を尋ねる。切れたら新しい番号にする（人の操作は要らない）
        const poll = async () => {
          if (stop) return;
          try {
            const p = await playFetch('/pairings/poll', { method: 'POST', body: JSON.stringify({ secret }) });
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
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      if (qrUrl) URL.revokeObjectURL(qrUrl);
    };
  }, [round, onKey]);

  if (off) return <div className="signage-root signage-blank" />;
  return (
    <div className="signage-root signage-pairing">
      {qr && <img className="signage-qr" src={qr} alt="" />}
      <div className="signage-code">{code ? `${code.slice(0, 3)} ${code.slice(3)}` : ''}</div>
    </div>
  );
}

/** 再生（第31.9.1節）。 */
function Player({ screenKey, onUnregistered }: { screenKey: string; onUnregistered: () => void }) {
  const [ps, setPs] = useState<PlayState | null>(() => {
    try { return JSON.parse(read(STATE_STORE) ?? 'null') as PlayState | null; } catch { return null; }
  });
  const [blank, setBlank] = useState(false);
  const [layers, setLayers] = useState<[Layer | null, Layer | null]>([null, null]);
  const [front, setFront] = useState<0 | 1>(0);
  const [empty, setEmpty] = useState(false);

  const psRef = useRef<PlayState | null>(ps);
  const ready = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const uncached = useRef(new Set<string>());
  const pos = useRef(-1);
  const current = useRef<string | null>(null);
  const seq = useRef(0);
  const frontRef = useRef<0 | 1>(0);
  const deadline = useRef(0);
  const misses = useRef(0);
  const reloadPending = useRef(false);
  const serverOffset = useRef(0);
  const lastBeatOk = useRef(0);
  const advanceRef = useRef<() => void>(() => undefined);
  const busy = useRef(false);

  /** 状態を読み直し、素材を取り置く。通信が切れていれば、最後に読んだ状態のまま流し続ける。 */
  const load = useCallback(async () => {
    let r: Response;
    try {
      r = await playFetch('/state', {}, screenKey);
    } catch {
      return;
    }
    if (r.status === 401) { onUnregistered(); return; }
    if (r.status === 404 || r.status === 403) { setBlank(true); return; }
    if (!r.ok) return;
    const next = (await r.json()) as PlayState;
    setBlank(false);
    serverOffset.current = Date.parse(next.serverTime) - Date.now();
    psRef.current = next;
    setPs(next);
    write(STATE_STORE, JSON.stringify(next));
    // 素材を取り置く。取り置けた素材から流し始める（第31.6.2節）
    const keep = new Set<string>();
    for (const a of next.assets) {
      keep.add(cacheUrl(a.sha256));
      if (a.kind === 'video') keep.add(cacheUrl(a.sha256, true));
    }
    for (const a of next.assets) {
      const url = cacheUrl(a.sha256);
      try {
        if (!(await cached(url))) {
          const got = await playFetch(`/assets/${a.id}`, {}, screenKey);
          if (!got.ok) throw new Error(String(got.status));
          await putCache(url, await got.blob());
        }
        if (a.kind === 'video' && !(await cached(cacheUrl(a.sha256, true)))) {
          const t = await playFetch(`/assets/${a.id}/thumbnail`, {}, screenKey);
          if (t.ok) await putCache(cacheUrl(a.sha256, true), await t.blob());
        }
        ready.current.add(a.id);
        uncached.current.delete(a.id);
      } catch {
        uncached.current.add(a.id);
      }
    }
    await pruneCache(keep).catch(() => undefined);
    // 流しているものが無ければ始める
    if (!current.current) advanceRef.current();
  }, [screenKey, onUnregistered]);

  /** 次の素材へ進む（第31.6.2節）。いま出している行の次の行。無くなっていれば最初から。 */
  const advance = useCallback(() => {
    // 同時に 2 回進まないようにする（読み込みの終わりと見張りが重なったとき）
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      const state = psRef.current;
      // 読み直しは、素材と素材の切り替えの時に行う（夜中の読み直し・ページの版が変わったとき。第31.9.1節）
      const jst = new Date(Date.now() + serverOffset.current + 9 * 3_600_000);
      const day = jst.toISOString().slice(0, 10);
      const online = Date.now() - lastBeatOk.current < 2 * 60_000;
      if (online && (reloadPending.current || (jst.getUTCHours() === 3 && read(RELOAD_STORE) !== day))) {
        write(RELOAD_STORE, day);
        location.reload();
        return;
      }
      if (!state) return;
      const byId = new Map(state.assets.map((a) => [a.id, a]));
      const list = state.entries;
      let start = 0;
      if (current.current) {
        const same = list[pos.current]?.assetId === current.current ? pos.current : list.findIndex((e) => e.assetId === current.current);
        start = same >= 0 ? same + 1 : 0;
      }
      for (let i = 0; i < list.length; i++) {
        const at = (start + i) % list.length;
        const e = list[at]!;
        const a = byId.get(e.assetId);
        // 取り置く前の素材は飛ばす（読み込み中の画面を出さない）
        if (!a || !ready.current.has(a.id)) continue;
        const blob = await cached(cacheUrl(a.sha256));
        if (!blob) continue;
        const thumbBlob = a.kind === 'video' ? await cached(cacheUrl(a.sha256, true)) : null;
        const layer: Layer = {
          seq: ++seq.current, assetId: a.id, kind: a.kind, url: URL.createObjectURL(blob), thumb: thumbBlob ? URL.createObjectURL(thumbBlob) : null,
          seconds: e.seconds ?? state.imageSeconds, durationMs: a.durationMs,
        };
        pos.current = at;
        current.current = a.id;
        setEmpty(false);
        // 後ろの 1 枚に置き、読めたら前に出す（黒い画面を挟まない）
        const back: 0 | 1 = frontRef.current === 0 ? 1 : 0;
        setLayers((prev) => {
          const next: [Layer | null, Layer | null] = [prev[0], prev[1]];
          const old = next[back];
          if (old) { URL.revokeObjectURL(old.url); if (old.thumb) URL.revokeObjectURL(old.thumb); }
          next[back] = layer;
          return next;
        });
        return;
      }
      // 流せるものが無い（流れが空・まだ取り置けていない）。会社の名前を出し、少し後にもう一度見る
      current.current = null;
      setEmpty(true);
      deadline.current = 0;
      window.setTimeout(() => advanceRef.current(), 5000);
    })().finally(() => { busy.current = false; });
  }, []);
  advanceRef.current = advance;

  /** 後ろの 1 枚が読めたら前に出し、出す時間を決める。 */
  const onReady = useCallback((which: 0 | 1, layer: Layer) => {
    if (frontRef.current === which && deadline.current) return;
    frontRef.current = which;
    setFront(which);
    misses.current = 0;
    const ms = layer.kind === 'video' ? (layer.durationMs ?? 60_000) : layer.seconds * 1000;
    // 止まったときの見張り: 決めた時間を 10 秒過ぎても進まなければ、次へ進む（第31.9.1節）
    deadline.current = Date.now() + ms + 10_000;
    if (layer.kind === 'image') window.setTimeout(() => { if (current.current === layer.assetId && seq.current === layer.seq) advanceRef.current(); }, ms);
  }, []);

  /** 流せなかった素材（動画が開けないなど）。3 回続けばページを読み直す。 */
  const onFail = useCallback((layer: Layer) => {
    failed.current.add(layer.assetId);
    misses.current++;
    if (misses.current >= 3) { location.reload(); return; }
    advanceRef.current();
  }, []);

  // 最初の読み込みと、つながらないときの読み直し
  useEffect(() => {
    void load();
    if (psRef.current && !current.current) {
      // 最後の状態が端末にあれば、つながる前から取り置いた素材で流し始める
      for (const a of psRef.current.assets) void cached(cacheUrl(a.sha256)).then((b) => { if (b) ready.current.add(a.id); });
      window.setTimeout(() => { if (!current.current) advanceRef.current(); }, 500);
    }
  }, [load]);

  // 無地の間は 5 分ごとに尋ね直す（サイネージを切った・停止した会社。第31.9.1節）
  useEffect(() => {
    if (!blank) return;
    const t = window.setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(t);
  }, [blank, load]);

  // 生きている知らせ（1 分ごと）。答えのサーバーの時刻で夜中の読み直しを決め、版の違いに気づく
  useEffect(() => {
    const beat = async () => {
      let storageFree: number | null = null;
      try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota !== undefined && est.usage !== undefined) storageFree = est.quota - est.usage;
      } catch { /* 分からない */ }
      const state = psRef.current;
      try {
        const r = await playFetch('/heartbeat', {
          method: 'POST',
          body: JSON.stringify({
            current: current.current, flowVersion: state?.screen.flowVersion ?? 0, cached: ready.current.size, uncached: [...uncached.current], failed: [...failed.current],
            pageVersion: APP_VERSION ?? '', viewport: { width: innerWidth, height: innerHeight }, storageFree,
          }),
        }, screenKey);
        if (r.status === 401) { onUnregistered(); return; }
        if (r.status === 404 || r.status === 403) { setBlank(true); return; }
        if (!r.ok) return;
        const b = (await r.json()) as { serverTime: string; flowVersion: number; pageVersion: string | null };
        lastBeatOk.current = Date.now();
        serverOffset.current = Date.parse(b.serverTime) - Date.now();
        failed.current.clear();
        if (b.pageVersion && APP_VERSION && b.pageVersion !== APP_VERSION) reloadPending.current = true;
        if (state && b.flowVersion !== state.screen.flowVersion) void load();
      } catch { /* つながらない間は流し続ける */ }
    };
    void beat();
    const t = window.setInterval(() => void beat(), 60_000);
    return () => clearInterval(t);
  }, [screenKey, load, onUnregistered]);

  // 即時の知らせ（流れ・画面・設定が変わった、外された）。切れたら 10 秒ごとにつなぎ直す
  useEffect(() => {
    let stop = false;
    let ctrl: AbortController | null = null;
    const connect = async () => {
      while (!stop) {
        ctrl = new AbortController();
        try {
          const r = await playFetch('/events', { signal: ctrl.signal }, screenKey);
          if (r.status === 401) { onUnregistered(); return; }
          if (r.ok && r.body) {
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i: number;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const ev = /^event: (\w+)/m.exec(block)?.[1];
                if (ev === 'flow' || ev === 'screen' || ev === 'settings' || ev === 'removed') void load();
              }
            }
          }
        } catch { /* つながらない */ }
        if (!stop) await new Promise((res) => setTimeout(res, 10_000));
      }
    };
    void connect();
    return () => { stop = true; ctrl?.abort(); };
  }, [screenKey, load, onUnregistered]);

  // 止まったときの見張り
  useEffect(() => {
    const t = window.setInterval(() => {
      if (deadline.current && Date.now() > deadline.current) {
        deadline.current = 0;
        const layer = layers[frontRef.current];
        if (layer) onFail(layer); else advanceRef.current();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [layers, onFail]);

  // 画面を消灯させない（第31.9.1節）。ページが隠れて戻ったら取り直す
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const take = async () => {
      try { lock = await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { lock = null; }
    };
    void take();
    const onVis = () => { if (document.visibilityState === 'visible') void take(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); void lock?.release().catch(() => undefined); };
  }, []);

  if (blank) return <div className="signage-root signage-blank" />;
  const rot = ps?.screen.rotation ?? 0;
  // 回し方（0・90・180・270 度）で、ページ全体を回して描く
  const frame: CSSProperties = rot === 0 ? {} : {
    position: 'fixed', top: '50%', left: '50%', width: rot % 180 ? '100vh' : '100vw', height: rot % 180 ? '100vw' : '100vh',
    transform: `translate(-50%, -50%) rotate(${rot}deg)`,
  };
  return (
    <div className="signage-root" style={{ background: ps?.color ?? '#000' }}>
      <div className="signage-frame" style={frame}>
        {empty || !ps
          ? <div className="signage-empty">{ps?.company ?? ''}</div>
          : ([0, 1] as const).map((i) => {
            const l = layers[i];
            return l ? <LayerView key={l.seq} layer={l} front={front === i} onReady={() => onReady(i, l)} onEnded={() => advanceRef.current()} onFail={() => onFail(l)} /> : null;
          })}
      </div>
    </div>
  );
}

/** 表示の 1 枚。向きの合わない素材は切らずに収め、余白にぼかして暗くしたものを敷く（第31.6.2節）。 */
function LayerView({ layer, front, onReady, onEnded, onFail }: {
  layer: Layer; front: boolean; onReady: () => void; onEnded: () => void; onFail: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (front) { v.currentTime = 0; void v.play().catch(() => onFail()); } else v.pause();
  }, [front, onFail]);
  const bg = layer.kind === 'image' ? layer.url : layer.thumb;
  return (
    <div className={`signage-layer${front ? ' front' : ''}`}>
      {bg && <div className="signage-bg" style={{ backgroundImage: `url(${bg})` }} />}
      {layer.kind === 'image'
        ? <img className="signage-media" src={layer.url} alt="" onLoad={onReady} onError={onFail} />
        : <video ref={video} className="signage-media" src={layer.url} muted playsInline preload="auto" onCanPlay={onReady} onEnded={onEnded} onError={onFail} />}
    </div>
  );
}
