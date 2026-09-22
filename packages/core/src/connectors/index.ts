/**
 * @file 業務システムへの接続口を、設定（`mock` / `google`）に応じて組み立てる。
 *
 * @see ADR-0003 外部接続の手前に接続口を設ける
 */

import type { WorkspaceConnector } from './types.js';
import { MockWorkspaceConnector } from './mock.js';

/**
 * 設定に応じて接続口を組み立てる。
 *
 * @param mode `mock` または `google`
 * @returns 接続口
 * @throws {Error} `google` を指定した場合。B-2（OAuth クライアント）の完了後に実装する
 *
 * @remarks
 * ダミーのまま本番へ出ることを防ぐため、`google` を指定して未実装なら
 * 黙ってダミーに切り替えず、起動を止める。
 */
export function buildConnector(mode: string): WorkspaceConnector {
  switch (mode) {
    case 'mock':
      return new MockWorkspaceConnector();
    case 'google':
      throw new Error(
        'CONNECTOR_MODE=google はまだ実装されていません。' +
          'OAuth クライアント（docs/google-setup.md の B-2）の用意後に実装します。',
      );
    default:
      throw new Error(`CONNECTOR_MODE の値が不正です: ${mode}（mock か google）`);
  }
}

export type * from './types.js';
export { MockWorkspaceConnector, ymd, jst, addDays } from './mock.js';
