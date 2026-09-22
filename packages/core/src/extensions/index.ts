/**
 * @file 拡張機能の部品の公開窓口。
 *
 * @see 仕様書 第12.9節 拡張機能の読み込みと導入
 */

export {
  loadExtensions, loadExtension,
  type ExtensionManifest, type ExtensionPackage, type LoadResult,
} from './loader.js';
