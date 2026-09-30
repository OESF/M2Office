/**
 * @file 店頭サイネージの管理の画面（パソコン。仕様書 第31.9.4節の段 1）。画面の一覧と状態・画面の登録と取り外し・流れ・素材。
 *
 * 素材はブラウザで確かめ、画像は長い辺 1,920 に縮めて位置などの情報を捨て、縮小画像を作ってから送る（第31.6.1節）。
 * PowerPoint のファイルは送らず、そのファイルに合わせて動画にする操作を示す（第31.6.4節）。説明文は常に出さない（原則 u11）。
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { SIGNAGE_LIMITS, type SignageEntry, type SignageScreen } from '@m2office/shared';
import { api, describeError, type SignageAssetView, type SignageOverview } from './api.js';
import { inspectPptx } from './pptx.js';

const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${n === 0 ? 0 : Math.max(1, Math.round(n / 1024))} KB`);
const fmtDuration = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ago = (iso: string | null) => {
  if (!iso) return '通信なし';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'たった今' : m < 60 ? `${m} 分前` : m < 1440 ? `${Math.round(m / 60)} 時間前` : `${Math.round(m / 1440)} 日前`;
};

/** 縮小画像（長い辺 320 の JPEG。100 KB まで）を作る。 */
async function thumbnailOf(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const s = Math.min(1, 320 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d')!.drawImage(source, 0, 0, c.width, c.height);
  for (const q of [0.8, 0.6, 0.4]) {
    const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
    if (b && b.size <= SIGNAGE_LIMITS.thumbnailBytes) return b;
  }
  throw new Error('縮小画像を作れませんでした');
}

/** 送る前に確かめて整えた素材。 */
type Prepared = { file: Blob; name: string; thumb: Blob; size?: { width: number; height: number } } | { error: string } | { guide: string };

/** ファイルを確かめて整える（第31.6.1節）。PowerPoint は送らずに操作を示す（第31.6.4節）。 */
async function prepare(file: File): Promise<Prepared> {
  const name = file.name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  if (/\.(pptx|ppsx)$/i.test(file.name)) {
    const info = await inspectPptx(file).catch(() => null);
    if (!info) return { error: `${file.name}: PowerPoint のファイルとして読めませんでした` };
    const parts = [`スライドが ${info.slides} 枚${info.animations ? 'あり、アニメーションがあります' : 'あります'}`];
    parts.push('PowerPoint の「ファイル → エクスポート → ビデオの作成」で「フル HD（1080p）」を選んで保存し、できた MP4 を入れてください');
    if (info.orientation === 'portrait') parts.push('スライドは縦です。縦の画面なら画面いっぱいに出ます');
    return { guide: `${file.name}: ${parts.join('。')}` };
  }
  if (/\.ppt$/i.test(file.name)) return { guide: `${file.name}: PowerPoint で開き、「ファイル → エクスポート → ビデオの作成」で MP4 にして入れてください` };
  if (file.type === 'image/jpeg' || file.type === 'image/png') {
    if (file.size > 20 * 1024 * 1024) return { error: `${file.name}: 画像が大きすぎます（20 MB まで）` };
    let bmp: ImageBitmap;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return { error: `${file.name}: 画像を読めませんでした` }; }
    if (bmp.width * bmp.height > 50_000_000) { bmp.close(); return { error: `${file.name}: 画像の画素が多すぎます` }; }
    // 長い辺を 1,920 に縮め、描き直して位置などの付帯情報を捨てる（第31.6.1節）
    const s = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, file.type, 0.9));
    const thumb = await thumbnailOf(bmp, bmp.width, bmp.height);
    bmp.close();
    if (!out) return { error: `${file.name}: 画像を縮められませんでした` };
    if (out.size > SIGNAGE_LIMITS.imageBytes) return { error: `${file.name}: 縮めた後も 5 MB を超えます` };
    return { file: out, name, thumb };
  }
  if (file.type === 'video/mp4' || /\.mp4$/i.test(file.name)) {
    if (file.size > SIGNAGE_LIMITS.videoBytes) return { error: `${file.name}: 動画が大きすぎます（200 MB まで）` };
    const url = URL.createObjectURL(file);
    try {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.src = url;
      await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('video')); });
      if (!v.videoWidth || !v.videoHeight) return { error: `${file.name}: 動画を読めませんでした（H.264 の MP4 にしてください）` };
      if (v.duration > SIGNAGE_LIMITS.videoMs / 1000) return { error: `${file.name}: 動画は 10 分までにしてください` };
      // 1 秒目（1 秒より短ければ最初）の絵から縮小画像を作る
      v.currentTime = Math.min(1, v.duration / 2);
      await new Promise<void>((res) => { v.onseeked = () => res(); });
      const thumb = await thumbnailOf(v, v.videoWidth, v.videoHeight);
      return { file: file.slice(0, file.size, 'video/mp4'), name, thumb, size: { width: v.videoWidth, height: v.videoHeight } };
    } catch {
      return { error: `${file.name}: 動画を読めませんでした（H.264 の MP4 にしてください）` };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { error: `${file.name}: 画像（JPEG・PNG）か動画（MP4）を選んでください` };
}

/** 縮小画像を読み込んでおく（画面を閉じるまで）。 */
function useThumbs() {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const want = useCallback((id: string) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    void api.signage.thumbnail(id).then((b) => { if (b) setUrls((u) => ({ ...u, [id]: URL.createObjectURL(b) })); });
  }, []);
  useEffect(() => () => { for (const u of Object.values(urls)) URL.revokeObjectURL(u); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { urls, want };
}

/**
 * 店頭サイネージの管理の画面。
 */
export function Signage() {
  const [data, setData] = useState<SignageOverview | null>(null);
  const [assets, setAssets] = useState<SignageAssetView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const thumbs = useThumbs();

  const load = useCallback(() => {
    api.signage.overview().then((d) => {
      setData(d);
      setSelected((s) => (s && d.screens.some((x) => x.id === s) ? s : d.screens[0]?.id ?? null));
    }).catch((e) => setError(describeError(e, '読み込めませんでした')));
    api.signage.assets().then((r) => setAssets(r.assets)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  // 画面の状態（つながっているか・いま出しているもの）を 30 秒ごとに読み直す
  useEffect(() => { const t = window.setInterval(() => api.signage.overview().then(setData).catch(() => undefined), 30_000); return () => clearInterval(t); }, []);

  /** ファイルを素材にする。画面を選んでいれば、その流れの最後に足す。 */
  const addFiles = async (files: File[], toScreen: string | null) => {
    setError(null);
    const out: string[] = [];
    const added: string[] = [];
    for (const f of files) {
      setUploading(f.name);
      const p = await prepare(f);
      if ('guide' in p) { out.push(p.guide); continue; }
      if ('error' in p) { out.push(p.error); continue; }
      try {
        const r = await api.signage.upload(p.file, p.name, p.size);
        if (!r.existing) await api.signage.setThumbnail(r.asset.id, p.thumb).catch(() => undefined);
        added.push(r.asset.id);
      } catch (e) {
        out.push(`${f.name}: ${describeError(e, '入れられませんでした')}`);
      }
    }
    setUploading(null);
    setNotes(out);
    if (toScreen && added.length) {
      const flow = await api.signage.flow(toScreen);
      await api.signage.saveFlow(toScreen, flow.version, [...flow.entries, ...added.map((assetId) => ({ assetId, seconds: null }))]).catch((e) => setError(describeError(e, '流れに足せませんでした')));
    }
    load();
  };

  const claim = () => {
    api.admin.claimSignageScreen(code).then((r) => { setCode(''); setSelected(r.screen.id); load(); }).catch((e) => setError(describeError(e, '登録できませんでした')));
  };

  if (!data) return <p className="muted">{error ?? '読み込んでいます…'}</p>;
  const screen = data.screens.find((s) => s.id === selected) ?? null;
  return (
    <div className="signage">
      {error && <p className="error">{error}</p>}
      <div className="signage-screens">
        {data.screens.map((s) => (
          <ScreenCard key={s.id} s={s} active={s.id === selected} admin={data.admin} thumb={s.lastReport?.current ? thumbs.urls[s.lastReport.current] : undefined}
            wantThumb={thumbs.want} onSelect={() => setSelected(s.id)} onChanged={load} onError={setError} />
        ))}
        {data.admin && data.screens.length < data.maxScreens && (
          <div className="card signage-add">
            <input className="signage-code-input" inputMode="numeric" maxLength={7} placeholder="画面の番号" value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) claim(); }} aria-label="画面に出ている番号" />
            <button className="btn small" disabled={!/^\d{3}\s?\d{3}$/.test(code.trim())} onClick={claim}>画面を足す</button>
          </div>
        )}
      </div>
      {screen && <FlowEditor key={screen.id} screen={screen} screens={data.screens} assets={assets} thumbs={thumbs} onFiles={(fs) => void addFiles(fs, screen.id)} onError={setError} onChanged={load} />}
      {uploading && <p className="muted small">{uploading} を入れています…</p>}
      {notes.length > 0 && (
        <div className="card signage-notes">
          {notes.map((n) => <p key={n} className="small">{n}</p>)}
          <button className="btn ghost small" onClick={() => setNotes([])}>閉じる</button>
        </div>
      )}
      <AssetList assets={assets} screens={data.screens} usage={data.usage} thumbs={thumbs} onFiles={(fs) => void addFiles(fs, null)} onChanged={load} onError={setError} />
    </div>
  );
}

/** 画面 1 台（名前・向き・回し方・つながっているか・いま出しているもの）。 */
function ScreenCard({ s, active, admin, thumb, wantThumb, onSelect, onChanged, onError }: {
  s: SignageScreen; active: boolean; admin: boolean; thumb?: string; wantThumb: (id: string) => void; onSelect: () => void; onChanged: () => void; onError: (m: string) => void;
}) {
  useEffect(() => { if (s.lastReport?.current) wantThumb(s.lastReport.current); }, [s.lastReport?.current, wantThumb]);
  const patch = (p: { name?: string; orientation?: 'landscape' | 'portrait'; rotation?: number }) =>
    void api.signage.updateScreen(s.id, p).then(onChanged).catch((e) => onError(describeError(e, '直せませんでした')));
  const uncached = s.lastReport?.uncached.length ?? 0;
  return (
    <div className={`card signage-screen${active ? ' active' : ''}`} onClick={onSelect}>
      <div className={`signage-preview ${s.orientation}`}>{thumb ? <img src={thumb} alt="" /> : null}</div>
      <div className="signage-screen-body">
        <input className="signage-name" defaultValue={s.name} maxLength={20} aria-label="画面の名前" onClick={(e) => e.stopPropagation()}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) patch({ name: v }); }} />
        <div className="row small">
          <span className={`badge ${s.online ? 'ok' : 'warn'}`}>{s.online ? 'つながっている' : 'つながっていない'}</span>
          <span className="muted">{ago(s.lastSeenAt)}</span>
          {uncached > 0 && <span className="badge warn">取り置けていない {uncached}</span>}
        </div>
        <div className="row small" onClick={(e) => e.stopPropagation()}>
          <select value={s.orientation} onChange={(e) => patch({ orientation: e.target.value as 'landscape' | 'portrait' })} aria-label="向き">
            <option value="landscape">横</option><option value="portrait">縦</option>
          </select>
          <select value={s.rotation} onChange={(e) => patch({ rotation: Number(e.target.value) })} aria-label="回し方">
            {[0, 90, 180, 270].map((r) => <option key={r} value={r}>{r} 度</option>)}
          </select>
          {admin && <button className="btn ghost small" onClick={() => void api.admin.removeSignageScreen(s.id).then(onChanged).catch((e) => onError(describeError(e, '外せませんでした')))}>外す</button>}
        </div>
      </div>
    </div>
  );
}

/** 画面の流れ（並べ替え・秒数・外す・素材を足す・ほかの画面から写す）。直したらすぐ保存する。 */
function FlowEditor({ screen, screens, assets, thumbs, onFiles, onError, onChanged }: {
  screen: SignageScreen; screens: SignageScreen[]; assets: SignageAssetView[]; thumbs: ReturnType<typeof useThumbs>;
  onFiles: (files: File[]) => void; onError: (m: string) => void; onChanged: () => void;
}) {
  const [flow, setFlow] = useState<{ version: number; entries: SignageEntry[] } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => { api.signage.flow(screen.id).then(setFlow).catch((e) => onError(describeError(e, '流れを読めませんでした'))); }, [screen.id, onError]);
  useEffect(reload, [reload, screen.flowVersion]);
  const byId = new Map(assets.map((a) => [a.id, a]));
  useEffect(() => { for (const e of flow?.entries ?? []) thumbs.want(e.assetId); }, [flow, thumbs]);

  const save = (entries: SignageEntry[]) => {
    if (!flow) return;
    setFlow({ ...flow, entries });
    api.signage.saveFlow(screen.id, flow.version, entries).then((r) => { setFlow({ version: r.version, entries }); onChanged(); })
      .catch((e) => { onError(describeError(e, '流れを直せませんでした')); reload(); });
  };
  const move = (from: number, to: number) => {
    if (!flow || from === to) return;
    const list = [...flow.entries];
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x!);
    save(list);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(files);
  };

  if (!flow) return null;
  return (
    <div className="card signage-flow" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="row"><strong className="grow">{screen.name} の流れ</strong>
        <select value="" onChange={(e) => {
          const from = e.target.value;
          if (from) void api.signage.flow(from).then((f) => save(f.entries));
        }} aria-label="ほかの画面の流れを写す">
          <option value="">ほかの画面から写す</option>
          {screens.filter((s) => s.id !== screen.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <ol className="signage-entries">
        {flow.entries.map((e, i) => {
          const a = byId.get(e.assetId);
          return (
            <li key={`${e.assetId}-${i}`} draggable onDragStart={() => setDrag(i)} onDragOver={(ev) => ev.preventDefault()}
              onDrop={(ev) => { ev.preventDefault(); ev.stopPropagation(); if (drag !== null) move(drag, i); setDrag(null); }}>
              <span className="signage-thumb">{thumbs.urls[e.assetId] ? <img src={thumbs.urls[e.assetId]} alt="" /> : null}</span>
              <span className="grow">{a?.name ?? ''}</span>
              {a?.kind === 'video'
                ? <span className="small muted">{a.durationMs ? fmtDuration(a.durationMs) : ''}</span>
                : <input className="num-input" type="number" min={SIGNAGE_LIMITS.minSeconds} max={SIGNAGE_LIMITS.maxSeconds} placeholder="秒" aria-label="出す秒数"
                  defaultValue={e.seconds ?? ''} onBlur={(ev) => {
                    const v = ev.target.value === '' ? null : Number(ev.target.value);
                    if (v !== e.seconds) save(flow.entries.map((x, j) => (j === i ? { ...x, seconds: v } : x)));
                  }} />}
              <button className="btn ghost small" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="上へ">↑</button>
              <button className="btn ghost small" disabled={i === flow.entries.length - 1} onClick={() => move(i, i + 1)} aria-label="下へ">↓</button>
              <button className="btn ghost small" onClick={() => save(flow.entries.filter((_, j) => j !== i))} aria-label="流れから外す">×</button>
            </li>
          );
        })}
      </ol>
      <div className="row wrap">
        <select value="" onChange={(e) => { if (e.target.value) save([...flow.entries, { assetId: e.target.value, seconds: null }]); }} aria-label="素材を足す">
          <option value="">素材を足す</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="btn ghost small" onClick={() => file.current?.click()}>ファイルを選ぶ</button>
        <input ref={file} type="file" multiple hidden accept="image/jpeg,image/png,video/mp4,.pptx,.ppsx,.ppt"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) onFiles(fs); }} />
      </div>
    </div>
  );
}

/** 会社の素材の一覧と、使っている容量。 */
function AssetList({ assets, screens, usage, thumbs, onFiles, onChanged, onError }: {
  assets: SignageAssetView[]; screens: SignageScreen[]; usage: { bytes: number; limit: number }; thumbs: ReturnType<typeof useThumbs>;
  onFiles: (files: File[]) => void; onChanged: () => void; onError: (m: string) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { for (const a of assets) thumbs.want(a.id); }, [assets, thumbs]);
  const names = (ids: string[]) => ids.map((id) => screens.find((s) => s.id === id)?.name).filter(Boolean).join('・');
  return (
    <div className="card signage-assets" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const fs = Array.from(e.dataTransfer.files); if (fs.length) onFiles(fs); }}>
      <div className="row"><strong className="grow">素材</strong>
        <span className="small muted">{fmtBytes(usage.bytes)} / {fmtBytes(usage.limit)}</span>
        <button className="btn ghost small" onClick={() => file.current?.click()}>ファイルを選ぶ</button>
        <input ref={file} type="file" multiple hidden accept="image/jpeg,image/png,video/mp4,.pptx,.ppsx,.ppt"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) onFiles(fs); }} />
      </div>
      <div className="signage-asset-grid">
        {assets.map((a) => (
          <div key={a.id} className="signage-asset">
            <span className="signage-thumb large">{thumbs.urls[a.id] ? <img src={thumbs.urls[a.id]} alt="" /> : null}</span>
            <input className="signage-asset-name" defaultValue={a.name} maxLength={60} aria-label="素材の名前"
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a.name) void api.signage.renameAsset(a.id, v).then(onChanged).catch((er) => onError(describeError(er, '直せませんでした'))); }} />
            <span className="small muted">{a.kind === 'video' ? `動画 ${a.durationMs ? fmtDuration(a.durationMs) : ''}` : '画像'}・{fmtBytes(a.bytes)}{a.screens.length ? `・${names(a.screens)}` : ''}</span>
            <button className="btn ghost small" onClick={() => void api.signage.deleteAsset(a.id).then(onChanged).catch((e) => onError(describeError(e, '消せませんでした')))}>消す</button>
          </div>
        ))}
      </div>
    </div>
  );
}
