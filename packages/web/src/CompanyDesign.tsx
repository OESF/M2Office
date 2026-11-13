/**
 * @file 管理者ページの「会社情報 › 会社の見た目」（仕様書 第46章）。見本・作る・直す・取り込む・書き出す・前の版に戻す・サイトに貼る CSS。
 *
 * 説明文は常に出さない（原則 u11）。見た目は見本の画像で見せる。
 */

import { useCallback, useEffect, useState } from 'react';
import { COMPANY_DESIGN_SOURCE_LABELS, type CompanyDesignView } from '@m2office/shared';
import { api, describeError } from './api.js';

type SiteCss = Awaited<ReturnType<typeof api.companyDesign.siteCss>>;

/** 会社の見た目の画面。 */
export function CompanyDesignSettings() {
  const [current, setCurrent] = useState<CompanyDesignView | null>(null);
  const [history, setHistory] = useState<CompanyDesignView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [request, setRequest] = useState('');
  const [url, setUrl] = useState('');
  const [compare, setCompare] = useState<number | null>(null);
  const [css, setCss] = useState<SiteCss | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    api.companyDesign.get()
      .then((r) => { setCurrent(r.current); setHistory(r.history); setLoaded(true); })
      .catch((e) => { setError(describeError(e, '読み込めませんでした')); setLoaded(true); });
  }, []);
  useEffect(load, [load]);

  /** 直して、前の版と並べて見せる。 */
  const run = async (key: string, fn: () => Promise<{ design: CompanyDesignView; notes: string[] }>) => {
    setBusy(key);
    setError(null);
    setNotes([]);
    setCss(null);
    try {
      const before = current?.version ?? null;
      const r = await fn();
      setNotes(r.notes);
      setCompare(before);
      setRequest('');
      setUrl('');
      load();
    } catch (e) {
      setError(describeError(e, 'できませんでした'));
    } finally {
      setBusy(null);
    }
  };

  const importFile = (file: File) => void run('import', async () => {
    if (file.size > 200_000) throw new Error('ファイルが大きすぎます');
    return api.companyDesign.importText(await file.text(), file.name, request.trim());
  });

  const showCss = async () => {
    setBusy('css');
    setError(null);
    try {
      setCss(await api.companyDesign.siteCss());
    } catch (e) {
      setError(describeError(e, 'CSS を作れませんでした'));
    } finally {
      setBusy(null);
    }
  };

  const copyCss = async () => {
    if (!css) return;
    try {
      await navigator.clipboard.writeText(css.css);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('コピーできませんでした。CSS を選んでコピーしてください');
    }
  };

  if (!loaded) return <p className="muted">読み込み中…</p>;
  return (
    <div className="company-design">
      {current ? (
        <>
          <img className="company-design-preview" src={api.companyDesign.previewUrl(current.version, compare ?? undefined)} alt="会社の見た目の見本" />
          <p className="small muted">
            第 {current.version} 版・{COMPANY_DESIGN_SOURCE_LABELS[current.source]}{current.sourceName ? `（${current.sourceName}）` : ''}・{new Date(current.createdAt).toLocaleString('ja-JP')}
          </p>
          {current.summary && <p>{current.summary}</p>}
        </>
      ) : (
        <div className="row">
          <button className="btn" disabled={!!busy} onClick={() => void run('generate', () => api.companyDesign.generate())}>
            {busy === 'generate' ? '作っています…' : 'ロゴとサイトから作る'}
          </button>
        </div>
      )}
      {notes.length > 0 && <ul className="small">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {error && <p className="error">{error}</p>}

      <div className="field">
        <label>直したいこと</label>
        <div className="row">
          <input value={request} placeholder="もっと落ち着いた青に・見出しを明朝に" onChange={(e) => setRequest(e.target.value)} />
          <button className="btn small" disabled={!!busy || !request.trim()} onClick={() => void run('edit', () => api.companyDesign.edit(request.trim()))}>
            {busy === 'edit' ? '直しています…' : '直す'}
          </button>
          {current && (
            <button className="btn small ghost" disabled={!!busy} onClick={() => void run('generate', () => api.companyDesign.generate(request.trim()))}>
              {busy === 'generate' ? '作っています…' : '作り直す'}
            </button>
          )}
        </div>
      </div>

      <div className="field">
        <label>DESIGN.md を取り込む</label>
        <div className="row">
          <input value={url} placeholder="https://…/DESIGN.md" onChange={(e) => setUrl(e.target.value)} />
          <button className="btn small" disabled={!!busy || !url.trim()} onClick={() => void run('import', () => api.companyDesign.importUrl(url.trim(), request.trim()))}>
            {busy === 'import' ? '取り込んでいます…' : '取り込む'}
          </button>
          <label className="btn small ghost">
            ファイルから
            <input type="file" accept=".md,text/markdown,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }} />
          </label>
        </div>
      </div>

      {current && (
        <div className="row">
          <button className="btn small ghost" disabled={!!busy} onClick={() => void api.companyDesign.download().catch((e) => setError(describeError(e, '書き出せませんでした')))}>DESIGN.md を書き出す</button>
          <button className="btn small ghost" disabled={!!busy} onClick={() => void showCss()}>{busy === 'css' ? '作っています…' : 'サイトに貼る CSS'}</button>
          {history.length > 1 && (
            <select value="" disabled={!!busy} onChange={(e) => { const v = Number(e.target.value); if (v) void run('restore', () => api.companyDesign.restore(v)); }}>
              <option value="">前の版に戻す…</option>
              {history.slice(1).map((v) => (
                <option key={v.version} value={v.version}>第 {v.version} 版（{COMPANY_DESIGN_SOURCE_LABELS[v.source]}・{new Date(v.createdAt).toLocaleDateString('ja-JP')}）</option>
              ))}
            </select>
          )}
        </div>
      )}

      {css && (
        <div className="company-design-css">
          <ol className="small">{css.steps.map((s, i) => <li key={i}>{s.replace(/\*\*/g, '')}</li>)}</ol>
          <pre><code>{css.css}</code></pre>
          <div className="row">
            <button className="btn small" onClick={() => void copyCss()}>{copied ? 'コピーしました' : 'CSS をコピー'}</button>
          </div>
          {css.notes.length > 0 && <ul className="small muted">{css.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
