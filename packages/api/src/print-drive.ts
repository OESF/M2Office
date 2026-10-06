/**
 * @file 販促物の作成の「ドライブから」（仕様書 第41.19.2節）。本人が Google のファイルを選ぶ画面（Google Picker）で選んだ写真を使う。
 *
 * 権限は `drive.file` のまま（選んだファイルだけが見える）。選ぶ画面に渡すアクセス トークンは、`drive.file` だけに絞って取り直したもの。
 * メールや予定の権限を持つトークンを画面に渡さない。見本の会社では、見本のドライブの写真を一覧で選ぶ。
 */

import { ConnectorUnavailableError, refreshGoogleAccessToken, type PrintDrive } from '@m2office/core';
import type { AppDeps } from './context.js';

/** 選ぶ画面に渡すトークンの範囲。 */
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** 見本のドライブで写真とみなす名前。 */
const IMAGE_NAME = /\.(png|jpe?g)$/i;

/**
 * 「ドライブから」のつなぎを作る。
 *
 * @remarks Picker の API キーは会社の Google 接続の設定（`google_oauth` の `pickerApiKey`）。プロジェクトの番号はクライアント ID の頭から取る
 */
export function printDriveFor(deps: Pick<AppDeps, 'repo' | 'box' | 'connector'>): PrintDrive {
  const settings = async (tenantId: string, userId: string) => {
    const [cred, conn] = await Promise.all([deps.repo.getTenantCredential(tenantId, 'google_oauth'), deps.repo.getGoogleConnection(tenantId, userId)]);
    const clientId = typeof cred?.meta['clientId'] === 'string' ? cred.meta['clientId'] : '';
    const apiKey = typeof cred?.meta['pickerApiKey'] === 'string' ? cred.meta['pickerApiKey'] : '';
    return { cred, conn, clientId, apiKey, ready: !!cred?.secretEnc && !!clientId && !!apiKey && !!conn && conn.scopes.includes('drive.file') };
  };
  return {
    async available(who) {
      if (deps.connector.sourceFor(who.tenantId) === 'mock') return true;
      return (await settings(who.tenantId, who.userId)).ready;
    },
    async picker(who) {
      if (deps.connector.sourceFor(who.tenantId) === 'mock') {
        const files = await deps.connector.drive.search(who, { query: '', limit: 100 });
        return { kind: 'mock', items: files.filter((f) => IMAGE_NAME.test(f.name)).map((f) => ({ id: f.id, name: f.name })) };
      }
      const s = await settings(who.tenantId, who.userId);
      if (!s.ready || !s.cred?.secretEnc || !s.conn) return { error: 'ドライブの写真は使えません（会社の Google 接続の設定か、本人の Google の接続がありません）' };
      try {
        const t = await refreshGoogleAccessToken({
          clientId: s.clientId, clientSecret: deps.box.decrypt(s.cred.secretEnc), refreshToken: deps.box.decrypt(s.conn.refreshTokenEnc), scope: DRIVE_FILE_SCOPE,
        });
        return { kind: 'google', apiKey: s.apiKey, appId: s.clientId.split('-')[0]!, accessToken: t.accessToken };
      } catch {
        return { error: 'Google に確かめられませんでした。個人設定の「Google 連携」で接続し直してください' };
      }
    },
    async download(who, fileId) {
      try {
        const f = await deps.connector.drive.download(who, fileId);
        if (!f) return { error: 'ファイルが見つからないか、見られません' };
        if ('tooLarge' in f) return { error: '写真が大きすぎます（25 MB まで）' };
        return { bytes: f.bytes, mimeType: f.mimeType };
      } catch (err) {
        return { error: err instanceof ConnectorUnavailableError ? err.message : 'ドライブから読めませんでした' };
      }
    },
  };
}
