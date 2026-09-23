/**
 * @file ファイルの中身の置き場。テナントごとに保存先を分ける。
 *
 * 開発ではローカルのディレクトリ、本番ではオブジェクトストレージに差し替える。
 *
 * @see 仕様書 第20.4.2節 本番環境
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * ファイルの中身を置く場所。
 *
 * メタデータ（名前・形式・所有者）はデータベースに、中身はここに置く。
 *
 * @remarks
 * テナント境界: 置き場所をテナントごとに分ける（仕様書 第20.4.2節「ストレージ」）。
 * 本番ではオブジェクトストレージに差し替える。開発ではローカルのディレクトリを使う。
 */
export interface FileStore {
  put(tenantId: string, key: string, bytes: Uint8Array): Promise<void>;
  /** 中身を返す。無ければ `null`。 */
  get(tenantId: string, key: string): Promise<Uint8Array | null>;
  /** 中身を消す。無くても例外にしない（何度呼んでも同じ結果になる）。 */
  remove(tenantId: string, key: string): Promise<void>;
}

/** 開発用。`<root>/<tenantId>/<key>` に保存する。 */
export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  async put(tenantId: string, key: string, bytes: Uint8Array): Promise<void> {
    const dir = this.dirOf(tenantId);
    await mkdir(dir, { recursive: true });
    await writeFile(this.pathOf(tenantId, key), bytes);
  }

  async get(tenantId: string, key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathOf(tenantId, key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async remove(tenantId: string, key: string): Promise<void> {
    await rm(this.pathOf(tenantId, key), { force: true });
  }

  private dirOf(tenantId: string): string {
    return join(resolve(this.root), safe(tenantId));
  }

  private pathOf(tenantId: string, key: string): string {
    return join(this.dirOf(tenantId), safe(key));
  }
}

/** 記憶上に置く。単体テスト用。 */
export class MemoryFileStore implements FileStore {
  private readonly data = new Map<string, Uint8Array>();
  async put(tenantId: string, key: string, bytes: Uint8Array) { this.data.set(`${tenantId}/${key}`, bytes); }
  async get(tenantId: string, key: string) { return this.data.get(`${tenantId}/${key}`) ?? null; }
  async remove(tenantId: string, key: string) { this.data.delete(`${tenantId}/${key}`); }
}

/** パスの区切りや `..` を含む名前を拒否する。ディレクトリの外へ出させない。 */
function safe(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`使えない名前です: ${name}`);
  return name;
}
