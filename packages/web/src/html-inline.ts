/**
 * @file 会社の HTML の中の参照（画像・CSS・スクリプト・字体）を、文書の中に入れる（仕様書 第31.6.3節）。人にさせない（ADR-0028）。
 *
 * HTML と一緒に落とされたファイル（か、それらをまとめた ZIP）から、`src`・`href`・`url()` の参照をファイルの名前で当て、
 * `data:` の URL に置き換える。CSS の中の `url()` も入れる。当てられなかった参照は名前を返す。スクリプトの中で組み立てる参照は入れられない。
 * 外（`http:`・`https:`・`//`）への参照は置き換えず、そのまま残す（サーバーが断る）。
 */

import { readBytes, readDirectory } from './zip.js';

/** 中に入れる材料（名前と中身）。 */
interface Resource { path: string; blob: Blob }

const EXTERNAL = /^\s*(?:https?:|\/\/|data:|#|javascript:|mailto:)/i;
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  css: 'text/css', js: 'text/javascript', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
const ext = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();

async function dataUrl(blob: Blob, path: string): Promise<string> {
  const type = MIME[ext(path)] ?? (blob.type || 'application/octet-stream');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** 参照（`img/a.png`・`./a.png`・`../a.png`）を、材料の中から名前で当てる（道が合わなければ、ファイルの名前だけで当てる）。 */
function findResource(ref: string, resources: Resource[]): Resource | undefined {
  const clean = decodeURIComponent(ref.split(/[?#]/)[0]!).replace(/^\.\//, '').replace(/^(\.\.\/)+/, '').toLowerCase();
  const base = clean.split('/').pop()!;
  return resources.find((r) => r.path.toLowerCase() === clean || r.path.toLowerCase().endsWith(`/${clean}`))
    ?? resources.find((r) => r.path.toLowerCase().split('/').pop() === base);
}

/** CSS の中の `url()` を入れる。 */
async function inlineCss(css: string, resources: Resource[], missing: Set<string>): Promise<string> {
  const out: string[] = [];
  let last = 0;
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    out.push(css.slice(last, m.index));
    const ref = m[2]!;
    const r = EXTERNAL.test(ref) ? undefined : findResource(ref, resources);
    if (r) out.push(`url("${await dataUrl(r.blob, r.path)}")`);
    else { if (!EXTERNAL.test(ref)) missing.add(ref); out.push(m[0]); }
    last = m.index! + m[0].length;
  }
  out.push(css.slice(last));
  return out.join('');
}

/**
 * HTML の中に材料を入れる。
 *
 * @param html HTML の文書
 * @param files 一緒に落とされたファイル（ZIP なら中を開く）
 * @returns 入れた後の文書と、当てられなかった参照の名前
 */
export async function inlineHtml(html: string, files: File[]): Promise<{ html: string; missing: string[] }> {
  const resources: Resource[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const buf = await f.arrayBuffer();
      for (const e of readDirectory(buf)) {
        if (e.name.endsWith('/') || /\.html?$/i.test(e.name)) continue;
        const bytes = await readBytes(buf, e).catch(() => null);
        if (bytes) resources.push({ path: e.name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
      }
    } else resources.push({ path: f.name, blob: f });
  }
  const missing = new Set<string>();
  // 外の CSS（<link rel="stylesheet" href>）は、中身を <style> にして入れる
  let doc = html;
  for (const m of [...doc.matchAll(/<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi)]) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href || EXTERNAL.test(href)) continue;
    const r = findResource(href, resources);
    if (!r) { missing.add(href); continue; }
    doc = doc.replace(m[0], `<style>${await inlineCss(await r.blob.text(), resources, missing)}</style>`);
  }
  // 外のスクリプト（<script src>）は、中身を <script> に入れる
  for (const m of [...doc.matchAll(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi)]) {
    const src = m[2]!;
    if (EXTERNAL.test(src)) continue;
    const r = findResource(src, resources);
    if (!r) { missing.add(src); continue; }
    doc = doc.replace(m[0], `<script${m[1]}${m[3]}>${(await r.blob.text()).replace(/<\/script/gi, '<\\/script')}</script>`);
  }
  // 画像などの src・href・poster・srcset
  const parts: string[] = [];
  let last = 0;
  for (const m of doc.matchAll(/\b(src|href|poster|srcset)\s*=\s*(["'])([^"']*)\2/gi)) {
    parts.push(doc.slice(last, m.index));
    const [, attr, q, value] = m;
    let replaced = m[0];
    if (attr!.toLowerCase() === 'srcset') {
      const items = await Promise.all(value!.split(',').map(async (part) => {
        const [u, ...rest] = part.trim().split(/\s+/);
        const r = u && !EXTERNAL.test(u) ? findResource(u, resources) : undefined;
        if (u && !r && !EXTERNAL.test(u)) missing.add(u);
        return r ? [await dataUrl(r.blob, r.path), ...rest].join(' ') : part.trim();
      }));
      replaced = `${attr}=${q}${items.join(', ')}${q}`;
    } else if (value && !EXTERNAL.test(value) && !(attr!.toLowerCase() === 'href' && !/\.(css|png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i.test(value.split(/[?#]/)[0]!))) {
      const r = findResource(value, resources);
      if (r) replaced = `${attr}=${q}${await dataUrl(r.blob, r.path)}${q}`;
      else missing.add(value);
    }
    parts.push(replaced);
    last = m.index! + m[0].length;
  }
  parts.push(doc.slice(last));
  doc = parts.join('');
  // <style> の中と style 属性の url()
  doc = await replaceAsync(doc, /<style\b[^>]*>([\s\S]*?)<\/style>/gi, async (whole, css) => whole.replace(css, await inlineCss(css, resources, missing)));
  doc = await replaceAsync(doc, /\bstyle\s*=\s*(["'])([^"']*url\([^"']*)\1/gi, async (whole, _q, css) => whole.replace(css, await inlineCss(css, resources, missing)));
  return { html: doc, missing: [...missing] };
}

async function replaceAsync(s: string, re: RegExp, fn: (...m: string[]) => Promise<string>): Promise<string> {
  const out: string[] = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    out.push(s.slice(last, m.index), await fn(...(m as unknown as string[])));
    last = m.index! + m[0].length;
  }
  out.push(s.slice(last));
  return out.join('');
}

/** HTML の中の最初の画像（縮小画像を作るため）。 */
export function firstImage(html: string): string | null {
  return /<img\b[^>]*\bsrc\s*=\s*["'](data:image\/[^"']+)["']/i.exec(html)?.[1] ?? /url\(\s*["']?(data:image\/[^"')]+)/i.exec(html)?.[1] ?? null;
}
