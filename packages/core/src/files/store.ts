/**
 * @file ファイルの中身の置き場。テナントごとに保存先を分ける。
 *
 * 開発ではローカルのディレクトリ、本番ではオブジェクトストレージに差し替える。
 *
 * @see 仕様書 第20.4.2節 本番環境
 */

import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
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
  /**
   * 手元の一時ファイルを、そのまま中身として置く（大きな動画を記憶に載せないため。仕様書 第31.6.1節）。一時ファイルは無くなる。
   * 対応しない置き場では `undefined`。
   */
  putFile?(tenantId: string, key: string, path: string): Promise<void>;
  /**
   * 中身の一部を流して読む（`Range` に応じるため。仕様書 第31.6.1節）。無ければ `null`。
   *
   * @param range 読む範囲（`end` を含む）。省略時は全体
   */
  openRead?(tenantId: string, key: string, range?: { start: number; end: number }): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null>;
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

  async putFile(tenantId: string, key: string, path: string): Promise<void> {
    await mkdir(this.dirOf(tenantId), { recursive: true });
    const to = this.pathOf(tenantId, key);
    try {
      await rename(path, to);
    } catch (err) {
      // 置き場が別の記憶装置なら、写してから消す
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await copyFile(path, to);
      await rm(path, { force: true });
    }
  }

  async openRead(tenantId: string, key: string, range?: { start: number; end: number }): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
    const path = this.pathOf(tenantId, key);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const node = createReadStream(path, range ? { start: range.start, end: range.end } : {});
    return { stream: Readable.toWeb(node) as ReadableStream<Uint8Array>, size };
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
  // 名前の決まりは置き場と同じにする（テストで、置き場が断る名前に気づけるように）
  async put(tenantId: string, key: string, bytes: Uint8Array) { this.data.set(`${tenantId}/${safe(key)}`, bytes); }
  async get(tenantId: string, key: string) { return this.data.get(`${tenantId}/${key}`) ?? null; }
  async remove(tenantId: string, key: string) { this.data.delete(`${tenantId}/${key}`); }
}

/** パスの区切りや `..` を含む名前を拒否する。ディレクトリの外へ出させない。 */
function safe(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`使えない名前です: ${name}`);
  return name;
}

/**
 * 手元のファイルの必要な所だけを読む関数を作る（MP4 の記録を読むため。仕様書 第31.6.1節）。
 *
 * @returns 読む関数と、閉じる関数
 */
export async function fileReader(path: string): Promise<{ read: (offset: number, length: number) => Promise<Uint8Array>; size: number; close: () => Promise<void> }> {
  const handle = await open(path, 'r');
  const size = (await handle.stat()).size;
  return {
    size,
    read: async (offset, length) => {
      const n = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(n);
      if (n > 0) await handle.read(buf, 0, n, offset);
      return buf;
    },
    close: () => handle.close(),
  };
}
