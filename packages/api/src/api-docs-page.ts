/**
 * @file 開発者向けのヘルプで、API の定義（OpenAPI）を Swagger UI で見せるページ（仕様書 第6.10.7.4節）。
 *
 * ページは**切り離した枠**で出す。応答の CSP に `sandbox allow-scripts` を付け、ページの出どころを空（opaque）にするため（枠の属性ではなく CSP で掛ける）、
 * 中のスクリプトはログインの Cookie にも M2Office の API にも届かない（`connect-src 'none'`）。定義はページに埋め込み、外から読み込まない。
 * Swagger UI は CDN から、版を固定し中身のハッシュ（SRI）を確かめて読む（依存のパッケージを足さないため。ADR-0088）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@m2office/core';

/** Swagger UI の版と、中身のハッシュ（版を変えたら、ハッシュも計り直す）。 */
const SWAGGER = {
  version: '5.17.14',
  js: 'sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep',
  css: 'sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn',
} as const;
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER.version}`;

/**
 * ページに付ける CSP。読み込めるのは CDN の Swagger UI と、埋め込んだスクリプトと書式だけ。外へ送る口は無い。
 *
 * @remarks `sandbox` は、枠の中でも直接 URL を開いたときにも効く。枠の `sandbox` の属性は使わない（属性付きの枠を読み込まないブラウザーがあるため）
 */
export const API_DOCS_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net",
  'img-src data: https://cdn.jsdelivr.net',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

/** HTML の文字として書けるようにする。 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Swagger UI のページを作る。
 *
 * @param title ページの題（定義の名前）
 * @param yaml 定義（OpenAPI の YAML か JSON の文字）。Swagger UI が読む
 * @returns HTML。応答には {@link API_DOCS_CSP} を付けること
 */
export function apiDocsPage(title: string, yaml: string): string {
  // スクリプトの中に置くため、`</script>` などで抜け出せないよう < を符号にする
  const spec = JSON.stringify(yaml).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${CDN}/swagger-ui.css" integrity="${SWAGGER.css}" crossorigin="anonymous">
<style>body{margin:0;background:#fff}.swagger-ui .info{margin:24px 0}</style>
</head>
<body>
<div id="swagger"></div>
<noscript>API の定義を出すには、スクリプトとインターネットへの接続が要ります。</noscript>
<script src="${CDN}/swagger-ui-bundle.js" integrity="${SWAGGER.js}" crossorigin="anonymous"></script>
<script>
(function () {
  var box = document.getElementById('swagger');
  if (typeof SwaggerUIBundle !== 'function') { box.textContent = 'API の定義を出す部品を読み込めませんでした（インターネットへの接続を確かめてください）。'; return; }
  var ui = SwaggerUIBundle({
    dom_id: '#swagger', presets: [SwaggerUIBundle.presets.apis], layout: 'BaseLayout',
    // まだ作っていない口もあり、枠から外へは送れないため、画面から要求を送る欄は出さない
    supportedSubmitMethods: [], validatorUrl: null, docExpansion: 'list', defaultModelsExpandDepth: 1
  });
  ui.specActions.updateSpec(${spec});
})();
</script>
</body>
</html>
`;
}

/**
 * API の定義（`<名前>.openapi.yaml`）を読む（仕様書 第6.10.7.4節）。題は `info.title` から取る。
 *
 * @remarks 読めない定義があっても起動は止めず、記録して飛ばす。記事が指す定義があるかは `npm test` で確かめる
 */
export function loadApiDocs(dir: string, log: Pick<Logger, 'warn'>): Map<string, { title: string; text: string }> {
  const docs = new Map<string, { title: string; text: string }>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^[a-z0-9-]+\.openapi\.yaml$/.test(f));
  } catch (err) {
    log.warn('API の定義を読み込めませんでした', { dir, err });
    return docs;
  }
  for (const f of files) {
    try {
      const text = readFileSync(join(dir, f), 'utf8');
      const title = /^info:\n(?:[ \t].*\n)*?[ \t]+title:[ \t]*(.+)$/m.exec(text)?.[1]?.trim() ?? f;
      docs.set(f.replace(/\.openapi\.yaml$/, ''), { title, text });
    } catch (err) {
      log.warn('API の定義を読めませんでした', { file: f, err });
    }
  }
  return docs;
}
