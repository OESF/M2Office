/**
 * @file 実行中に読むファイル（ヘルプの記事・マニュアル・フォント・拡張機能・版の番号など）の置き場所の根（仕様書 第20.4.5節）。
 *
 * 開発ではリポジトリの根（このファイルから 3 つ上）。本番の組み立て（`npm run build:release`）では、組み立てた 1 つのファイルに
 * まとめるため、ソースからの相対の道が使えない。環境変数 `M2O_APP_ROOT` で、組み立てたものの根を渡す。
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 置き場所の根。`M2O_APP_ROOT` があればそれ、無ければリポジトリの根。 */
export function appRoot(): string {
  return process.env['M2O_APP_ROOT'] || fileURLToPath(new URL('../../../', import.meta.url));
}

/** 置き場所の根から見た道（例: `appPath('docs', 'help')`）。 */
export function appPath(...segments: string[]): string {
  return join(appRoot(), ...segments);
}
