/**
 * @file 店頭サイネージの再生のページ（`/signage/play`。仕様書 第31.9.1節）。端末のブラウザで全画面に開き、何か月も開いたまま動かす。
 *
 * **ログインを使わない。** 鍵が無ければ登録の番号と QR を出し、管理者が登録すると画面の鍵を受け取る（第31.5.1節）。
 * 鍵があれば流れを読み、素材を端末に取り置いてから、画像・動画・HTML を順に流す。通信が切れても、取り置いた流れを流し続ける。
 * 割り込みが来たら、流れを止めて全画面で重ね、ジングルを鳴らし、決めた秒数のあと止めた所から続ける（第31.9.2節）。
 * ワークスペースの枠（左のメニュー・秘書の欄）と、ワークスペースの API の呼び出し口（ログインの扱い）を使わない。
 * 説明の文は出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { APP_VERSION } from './version.js';
import { JinglePlayer } from './signage-audio.js';
import { HtmlFrame, InterruptText } from './signage-view.js';

/** 端末に置く画面の鍵・最後の状態・夜中の読み直しの日の名前。 */
const KEY_STORE = 'm2o-signage-key';
/** 再生のページに足す見出し。囲い（`iframe`）は同じ場所と `srcdoc` だけを開かせ、プラグインと基準の URL の差し替えを止める。 */
const PLAYER_CSP = "frame-src 'self'; child-src 'self'; object-src 'none'; base-uri 'self'";
const STATE_STORE = 'm2o-signage-state';
const RELOAD_STORE = 'm2o-signage-reloaded';
/** 素材を取り置く場所の名前。 */
const CACHE_NAME = 'm2o-signage-assets';
/** 開発のときだけ、会社を URL の `tenant` で決める（ワークスペースと同じ）。 */
const devTenant = new URLSearchParams(location.search).get('tenant');

/** 画面に渡される割り込み（`GET /v1/signage-play/interrupts`）。 */
interface PlayInterrupt {
  id: string; kind: 'text' | 'asset'; text: string | null; number: string | null; assetId: string | null; seconds: number;
  jingle: string | null; state: 'waiting' | 'showing'; ageMs: number;
}

/** 再生に要る状態（`GET /v1/signage-play/state`）。 */
interface PlayState {
  screen: { id: string; name: string; orientation: 'landscape' | 'portrait'; rotation: 0 | 90 | 180 | 270; volume: number; flowVersion: number };
  entries: { assetId: string; seconds: number | null }[];
  assets: { id: string; kind: 'image' | 'video' | 'html'; mime: string; sha256: string; bytes: number; width: number; height: number; durationMs: number | null }[];
  interruptAssets?: string[];
  sounds?: { id: string; mime: string }[];
  interrupts?: PlayInterrupt[];
  jingle?: string;
  imageSeconds: number;
  color: string;
  company: string;
  serverTime: string;
  pageVersion: string | null;
}

/** 表示の 1 枚（前と後ろの 2 枚を重ねて切り替える）。 */
interface Layer { seq: number; assetId: string; kind: 'image' | 'video' | 'html'; url: string; html: string | null; thumb: string | null; seconds: number; durationMs: number | null }

/** 出している割り込み（素材なら中身を開いたもの）。 */
interface Showing { item: PlayInterrupt; url: string | null; html: string | null; kind: 'text' | 'image' | 'html' }

/** 割り込みを出せる時間（作ってから。第31.7.2節）。 */
const EXPIRE_MS = 2 * 60_000;

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
/** 会社のジングルの音の取り置きの名前。 */
const soundUrl = (id: string) => `/signage-cache/sound-${id}`;

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
  // 会社の HTML が囲いの中で自分を外の URL に移しても開かせない（第31.6.3節の「移動を止める」）。再生のページだけに足す
  useEffect(() => {
    if (document.querySelector('meta[data-signage-csp]')) return;
    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = PLAYER_CSP;
    meta.dataset['signageCsp'] = '';
    document.head.appendChild(meta);
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

/** 再生（第31.9.1節・第31.9.2節）。 */
function Player({ screenKey, onUnregistered }: { screenKey: string; onUnregistered: () => void }) {
  const [ps, setPs] = useState<PlayState | null>(() => {
    try { return JSON.parse(read(STATE_STORE) ?? 'null') as PlayState | null; } catch { return null; }
  });
  const [blank, setBlank] = useState(false);
  const [layers, setLayers] = useState<[Layer | null, Layer | null]>([null, null]);
  const [front, setFront] = useState<0 | 1>(0);
  const [empty, setEmpty] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showing, setShowing] = useState<Showing | null>(null);
  const [audioOk, setAudioOk] = useState(true);

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
  const layersRef = useRef<[Layer | null, Layer | null]>([null, null]);
  // 流れの時間（画像と HTML の残り。割り込みの間は止める）
  const flowTimer = useRef<{ id: number | null; until: number; remaining: number; seq: number }>({ id: null, until: 0, remaining: 0, seq: 0 });
  const pausedRef = useRef(false);
  // 割り込み
  const showingRef = useRef<Showing | null>(null);
  const intTimer = useRef<number | null>(null);
  const sseUp = useRef(false);
  const jingle = useRef<JinglePlayer | null>(null);
  if (!jingle.current) jingle.current = new JinglePlayer();
  const refreshRef = useRef<(list?: PlayInterrupt[]) => void>(() => undefined);
  layersRef.current = layers;

  /** 状態を読み直し、素材と会社の音を取り置く。通信が切れていれば、最後に読んだ状態のまま流し続ける。 */
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
    write(STATE_STORE, JSON.stringify({ ...next, interrupts: [] }));
    // 素材（流れと割り込みの素材）と会社の音を取り置く。取り置けた素材から流し始める（第31.6.2節）
    const keep = new Set<string>();
    for (const a of next.assets) {
      keep.add(cacheUrl(a.sha256));
      if (a.kind === 'video') keep.add(cacheUrl(a.sha256, true));
    }
    for (const snd of next.sounds ?? []) keep.add(soundUrl(snd.id));
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
    for (const snd of next.sounds ?? []) {
      try {
        if (!(await cached(soundUrl(snd.id)))) {
          const got = await playFetch(`/sounds/${snd.id}`, {}, screenKey);
          if (got.ok) await putCache(soundUrl(snd.id), await got.blob());
        }
      } catch { /* 取り置けなければ既定の音 */ }
    }
    await pruneCache(keep).catch(() => undefined);
    // 流しているものが無ければ始める
    if (!current.current && !pausedRef.current) advanceRef.current();
    refreshRef.current(next.interrupts ?? []);
  }, [screenKey, onUnregistered]);

  /** 画像と HTML の時間を数え始める。 */
  const startTimer = useCallback((ms: number, layerSeq: number) => {
    const t = flowTimer.current;
    if (t.id) clearTimeout(t.id);
    t.seq = layerSeq;
    t.until = performance.now() + ms;
    t.remaining = 0;
    t.id = window.setTimeout(() => { t.id = null; if (seq.current === layerSeq && !pausedRef.current) advanceRef.current(); }, ms);
    deadline.current = Date.now() + ms + 10_000;
  }, []);

  /** 流れを止める（割り込みの間。動画は止め、画像と HTML は残りの秒数を止める。第31.7.2節）。 */
  const pauseFlow = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    setPaused(true);
    const t = flowTimer.current;
    if (t.id) { clearTimeout(t.id); t.id = null; t.remaining = Math.max(500, t.until - performance.now()); }
    deadline.current = 0;
  }, []);

  /** 止めた所から続ける。 */
  const resumeFlow = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    const t = flowTimer.current;
    const layer = layersRef.current[frontRef.current];
    if (!current.current || !layer) { advanceRef.current(); return; }
    if (layer.kind === 'video') deadline.current = Date.now() + (layer.durationMs ?? 60_000) + 10_000;
    else if (t.remaining > 0 && t.seq === layer.seq) startTimer(t.remaining, layer.seq);
    else advanceRef.current();
  }, [startTimer]);

  /** 次の素材へ進む（第31.6.2節）。いま出している行の次の行。無くなっていれば最初から。 */
  const advance = useCallback(() => {
    // 同時に 2 回進まないようにする。割り込みの間は進まない
    if (busy.current || pausedRef.current) return;
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
        const html = a.kind === 'html' ? await blob.text() : null;
        const layer: Layer = {
          seq: ++seq.current, assetId: a.id, kind: a.kind, url: a.kind === 'html' ? '' : URL.createObjectURL(blob), html,
          thumb: thumbBlob ? URL.createObjectURL(thumbBlob) : null, seconds: e.seconds ?? state.imageSeconds, durationMs: a.durationMs,
        };
        pos.current = at;
        current.current = a.id;
        setEmpty(false);
        // 後ろの 1 枚に置き、読めたら前に出す（黒い画面を挟まない）
        const back: 0 | 1 = frontRef.current === 0 ? 1 : 0;
        setLayers((prev) => {
          const next: [Layer | null, Layer | null] = [prev[0], prev[1]];
          const old = next[back];
          if (old) { if (old.url) URL.revokeObjectURL(old.url); if (old.thumb) URL.revokeObjectURL(old.thumb); }
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
    if (layer.kind === 'video') deadline.current = Date.now() + (layer.durationMs ?? 60_000) + 10_000;
    // 止まったときの見張り: 決めた時間を 10 秒過ぎても進まなければ、次へ進む（第31.9.1節）
    else startTimer(layer.seconds * 1000, layer.seq);
  }, [startTimer]);

  /** 流せなかった素材（動画が開けないなど）。3 回続けばページを読み直す。 */
  const onFail = useCallback((layer: Layer) => {
    failed.current.add(layer.assetId);
    misses.current++;
    if (misses.current >= 3) { location.reload(); return; }
    advanceRef.current();
  }, []);

  /** 割り込みを出し終える（秒数が過ぎた・消された）。 */
  const finish = useCallback((report: boolean) => {
    const s = showingRef.current;
    if (!s) return;
    if (intTimer.current) { clearTimeout(intTimer.current); intTimer.current = null; }
    showingRef.current = null;
    if (s.url) URL.revokeObjectURL(s.url);
    setShowing(null);
    jingle.current?.stop();
    if (report) void playFetch(`/interrupts/${s.item.id}/ended`, { method: 'POST' }, screenKey).catch(() => undefined);
    // 次の割り込みか、止めた所から続ける
    refreshRef.current();
  }, [screenKey]);

  /** 割り込みを出す（流れの上に全画面で重ね、ジングルを 1 回鳴らす。第31.9.2節）。 */
  const show = useCallback(async (item: PlayInterrupt) => {
    const state = psRef.current;
    let kind: Showing['kind'] = 'text';
    let url: string | null = null;
    let html: string | null = null;
    if (item.kind === 'asset') {
      const a = state?.assets.find((x) => x.id === item.assetId);
      const blob = a ? await cached(cacheUrl(a.sha256)) : null;
      if (!a || !blob) { void playFetch(`/interrupts/${item.id}/ended`, { method: 'POST' }, screenKey).catch(() => undefined); return false; }
      kind = a.kind === 'html' ? 'html' : 'image';
      if (kind === 'html') html = await blob.text(); else url = URL.createObjectURL(blob);
    }
    pauseFlow();
    const s: Showing = { item, url, html, kind };
    showingRef.current = s;
    setShowing(s);
    if (item.state === 'waiting') void playFetch(`/interrupts/${item.id}/started`, { method: 'POST' }, screenKey).catch(() => undefined);
    if (item.jingle) {
      const file = item.jingle && !['pinpon', 'pinponpanpon', 'poron', 'bell'].includes(item.jingle) ? await cached(soundUrl(item.jingle)) : null;
      void jingle.current?.play(item.jingle, state?.screen.volume ?? 70, file);
    }
    intTimer.current = window.setTimeout(() => finish(true), item.seconds * 1000);
    return true;
  }, [pauseFlow, finish, screenKey]);

  /** 割り込みを読み直し、消されたものを下げ、次のものを出す。無ければ流れに戻る。 */
  const refresh = useCallback((given?: PlayInterrupt[]) => {
    void (async () => {
      let list = given;
      if (!list) {
        try {
          const r = await playFetch('/interrupts', {}, screenKey);
          if (!r.ok) return;
          list = ((await r.json()) as { interrupts: PlayInterrupt[] }).interrupts;
        } catch { list = []; }
      }
      const cur = showingRef.current;
      if (cur && !list.some((x) => x.id === cur.item.id)) {
        // 消された
        if (intTimer.current) { clearTimeout(intTimer.current); intTimer.current = null; }
        showingRef.current = null;
        if (cur.url) URL.revokeObjectURL(cur.url);
        setShowing(null);
        jingle.current?.stop();
      }
      if (showingRef.current) return;
      // 作ってから 2 分を過ぎたものは出さない（経過はサーバーが数える）
      for (const item of list.filter((x) => x.state === 'showing' || x.ageMs <= EXPIRE_MS)) {
        if (await show(item)) return;
      }
      resumeFlow();
    })();
  }, [screenKey, show, resumeFlow]);
  refreshRef.current = refresh;

  // 最初の読み込みと、つながらないときの読み直し
  useEffect(() => {
    void load();
    if (psRef.current && !current.current) {
      // 最後の状態が端末にあれば、つながる前から取り置いた素材で流し始める
      for (const a of psRef.current.assets) void cached(cacheUrl(a.sha256)).then((b) => { if (b) ready.current.add(a.id); });
      window.setTimeout(() => { if (!current.current) advanceRef.current(); }, 500);
    }
  }, [load]);

  // 音を出せるかを確かめる（自動再生を許す設定の端末では開いたときから出せる。第31.9.2節）
  useEffect(() => {
    void jingle.current?.unlock().then(setAudioOk);
  }, []);

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
            audio: jingle.current?.ok ?? null, interrupting: !!showingRef.current,
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

  // 即時の知らせ（流れ・画面・設定が変わった、外された、割り込み、消す、音の大きさ）。切れたら 10 秒ごとにつなぎ直す
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
            sseUp.current = true;
            refreshRef.current();
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
                else if (ev === 'interrupt' || ev === 'clear') refreshRef.current();
                // 音の大きさを変えたら、ジングルを 1 回鳴らす（第31.9.2節）
                else if (ev === 'volume') void load().then(() => jingle.current?.play(psRef.current?.jingle ?? 'pinpon', psRef.current?.screen.volume ?? 70));
              }
            }
          }
        } catch { /* つながらない */ }
        sseUp.current = false;
        if (!stop) await new Promise((res) => setTimeout(res, 10_000));
      }
    };
    void connect();
    return () => { stop = true; ctrl?.abort(); };
  }, [screenKey, load, onUnregistered]);

  // 即時の知らせが切れている間は、10 秒ごとに待っている割り込みを尋ねる
  useEffect(() => {
    const t = window.setInterval(() => { if (!sseUp.current) refreshRef.current(); }, 10_000);
    return () => clearInterval(t);
  }, []);

  // 止まったときの見張り（割り込みの間は見ない）
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!pausedRef.current && deadline.current && Date.now() > deadline.current) {
        deadline.current = 0;
        const layer = layersRef.current[frontRef.current];
        if (layer) onFail(layer); else advanceRef.current();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [onFail]);

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
            return l ? <LayerView key={l.seq} layer={l} front={front === i} paused={paused} onReady={() => onReady(i, l)} onEnded={() => advanceRef.current()} onFail={() => onFail(l)} /> : null;
          })}
        {showing && (
          <div className="signage-int" key={showing.item.id}>
            {showing.kind === 'text' && <InterruptText text={showing.item.text ?? ''} number={showing.item.number} color={ps?.color ?? '#1f3a5f'} />}
            {showing.kind === 'image' && showing.url && (
              <>
                <div className="signage-bg" style={{ backgroundImage: `url(${showing.url})` }} />
                <img className="signage-media" src={showing.url} alt="" />
              </>
            )}
            {showing.kind === 'html' && showing.html !== null && <HtmlFrame html={showing.html} />}
          </div>
        )}
      </div>
      {/* 音が出せない端末では、隅に小さな印だけを出し、押されたら音を許す（説明文は出さない） */}
      {!audioOk && <button className="signage-mute" aria-label="音を出す" onClick={() => void jingle.current?.unlock().then(setAudioOk)}>🔇</button>}
    </div>
  );
}

/** 表示の 1 枚。向きの合わない素材は切らずに収め、余白にぼかして暗くしたものを敷く（第31.6.2節）。 */
function LayerView({ layer, front, paused, onReady, onEnded, onFail }: {
  layer: Layer; front: boolean; paused: boolean; onReady: () => void; onEnded: () => void; onFail: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (front) { v.currentTime = 0; void v.play().catch(() => onFail()); } else v.pause();
  }, [front, onFail]);
  // 割り込みの間は止め、終わったら止めた所から続ける
  useEffect(() => {
    const v = video.current;
    if (!v || !front) return;
    if (paused) v.pause(); else if (v.paused && !v.ended) void v.play().catch(() => undefined);
  }, [paused, front]);
  const bg = layer.kind === 'image' ? layer.url : layer.thumb;
  return (
    <div className={`signage-layer${front ? ' front' : ''}`}>
      {bg && <div className="signage-bg" style={{ backgroundImage: `url(${bg})` }} />}
      {layer.kind === 'image' && <img className="signage-media" src={layer.url} alt="" onLoad={onReady} onError={onFail} />}
      {layer.kind === 'video' && <video ref={video} className="signage-media" src={layer.url} muted playsInline preload="auto" onCanPlay={onReady} onEnded={onEnded} onError={onFail} />}
      {layer.kind === 'html' && layer.html !== null && <HtmlFrame html={layer.html} onLoad={onReady} />}
    </div>
  );
}
