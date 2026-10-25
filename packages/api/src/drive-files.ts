/**
 * @file 秘書に Google ドライブのファイルを渡す（仕様書 第10.10.8節）。本人が Google のファイル選び（Google Picker）で選んだファイルを、
 * 手元から渡したファイルと同じ置き場に入れる。
 *
 * 権限は `drive.file` のまま（選んだファイルだけが見える。ドライブ全体を読む権限は求めない）。選ぶ画面に渡すトークンは、
 * `drive.file` だけに絞って取り直したもの（販促物の作成の「ドライブから」と同じ。第41.19.2節）。ドライブのファイルは書き換えない・共有を変えない。
 */

import { ConnectorUnavailableError, detectKind, isAudioName, MAX_AUDIO_BYTES, MAX_FILE_BYTES, refreshGoogleAccessToken, saveFile, type ConnectorPrincipal } from '@m2office/core';
import type { StoredFile } from '@m2office/shared';
import type { AppDeps } from './context.js';
import { recordingRefusal } from './recording-check.js';

/** 選ぶ画面に渡すトークンの範囲。 */
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** 書き出した形の拡張子（Google の形式を書き出したもの・名前に拡張子が無いもの）。 */
const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  // 録音（第9.4.5節）
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
};

/** ファイル選びの材料。見本の会社は見本のドライブの一覧。 */
export type DriveFilePicker =
  | { kind: 'google'; apiKey: string; appId: string; accessToken: string }
  | { kind: 'mock'; items: { id: string; name: string }[] }
  | { error: string };

/** 秘書にドライブのファイルを渡すつなぎ。 */
export interface DriveFiles {
  /** 本人がドライブから渡せるか（会社のファイル選びの API キーと、本人の Google の接続）。 */
  available(who: ConnectorPrincipal): Promise<boolean>;
  picker(who: ConnectorPrincipal): Promise<DriveFilePicker>;
  /**
   * 選んだファイルを受け取り、置き場に入れる。
   *
   * @remarks 危険度: 読むだけ（本人が選んだファイルだけ）。形式と大きさは手元から渡したファイルと同じ確かめ
   */
  receive(who: ConnectorPrincipal, driveFileId: string): Promise<{ file: StoredFile } | { error: string; status: 400 | 404 | 413 | 415 | 422 | 503 }>;
}

/**
 * 秘書にドライブのファイルを渡すつなぎを作る。
 *
 * @remarks Picker の API キーは会社の Google 接続の設定（`google_oauth` の `pickerApiKey`）。プロジェクトの番号はクライアント ID の頭から取る
 */
export function driveFilesFor(deps: Pick<AppDeps, 'repo' | 'box' | 'connector' | 'files' | 'ai'>): DriveFiles {
  const settings = async (tenantId: string, userId: string) => {
    const [cred, conn] = await Promise.all([deps.repo.getTenantCredential(tenantId, 'google_oauth'), deps.repo.getGoogleConnection(tenantId, userId)]);
    const clientId = typeof cred?.meta['clientId'] === 'string' ? cred.meta['clientId'] : '';
    const apiKey = typeof cred?.meta['pickerApiKey'] === 'string' ? cred.meta['pickerApiKey'] : '';
    return { cred, conn, clientId, apiKey, ready: !!cred?.secretEnc && !!clientId && !!apiKey && !!conn && conn.scopes.includes('drive.file') };
  };
  const mock = (tenantId: string) => deps.connector.sourceFor(tenantId) === 'mock';
  return {
    async available(who) {
      if (mock(who.tenantId)) return true;
      return (await settings(who.tenantId, who.userId)).ready;
    },
    async picker(who) {
      if (mock(who.tenantId)) {
        const files = await deps.connector.drive.search(who, { query: '', limit: 100 });
        return { kind: 'mock', items: files.filter((f) => f.kind !== 'folder').map((f) => ({ id: f.id, name: f.name })) };
      }
      const s = await settings(who.tenantId, who.userId);
      // 足りないものを、誰が何をすればよいかの形で返す（会社の設定は管理者、本人の接続は本人）
      if (!s.cred?.secretEnc || !s.clientId) return { error: 'ドライブから選べません。会社の Google 接続が設定されていません（管理者ページ「接続」の Google）' };
      if (!s.apiKey) return { error: 'ドライブから選べません。管理者ページ「接続」の Google に「Picker の API キー」が登録されていません（管理者に登録を頼んでください）' };
      if (!s.conn || !s.conn.scopes.includes('drive.file')) return { error: 'ドライブから選べません。個人設定の「Google 連携」で Google と接続し直してください' };
      try {
        const t = await refreshGoogleAccessToken({
          clientId: s.clientId, clientSecret: deps.box.decrypt(s.cred.secretEnc), refreshToken: deps.box.decrypt(s.conn.refreshTokenEnc), scope: DRIVE_FILE_SCOPE,
        });
        return { kind: 'google', apiKey: s.apiKey, appId: s.clientId.split('-')[0]!, accessToken: t.accessToken };
      } catch {
        return { error: 'Google に確かめられませんでした。個人設定の「Google 連携」で接続し直してください' };
      }
    },
    async receive(who, driveFileId) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(driveFileId)) return { error: 'ファイルの ID が違います', status: 400 };
      let got;
      try {
        got = await deps.connector.drive.download(who, driveFileId);
      } catch (err) {
        return { error: err instanceof ConnectorUnavailableError ? err.message : 'ドライブから読めませんでした', status: 503 };
      }
      if (!got) return { error: 'ファイルが見つからないか、見られません', status: 404 };
      if ('tooLarge' in got) return { error: 'ファイルが大きすぎます（録音は 200 MB まで、そのほかは 10 MB まで）', status: 413 };
      const audio = got.mimeType.startsWith('audio/') || isAudioName(got.file.name);
      if (got.bytes.length > (audio ? MAX_AUDIO_BYTES : MAX_FILE_BYTES)) return { error: audio ? '録音が大きすぎます（200 MB まで）' : 'ファイルが大きすぎます（10 MB まで）', status: 413 };
      // Google の形式を書き出したもの・拡張子の無い名前には、中身の形の拡張子を付ける（形式を名前と中身の両方で確かめるため）
      const ext = EXT[got.mimeType];
      const has = ext === 'jpg' ? /\.jpe?g$/i.test(got.file.name) : !!ext && got.file.name.toLowerCase().endsWith(`.${ext}`);
      const name = ext && !has ? `${got.file.name}.${ext}` : got.file.name;
      const kind = detectKind(name, got.bytes);
      if (!kind) return { error: '受け付けない形式です（PDF・Word・Excel・CSV・画像・録音（MP3・M4A・WAV）、Google のドキュメント・スプレッドシート・スライド）', status: 415 };
      const refusal = await recordingRefusal(deps, who.tenantId, kind, got.bytes);
      if (refusal) return { error: refusal, status: 422 };
      const file = await saveFile(deps.repo, deps.files, {
        tenantId: who.tenantId, ownerUserId: who.userId, name, kind, bytes: got.bytes, origin: 'upload', runId: null,
      });
      await deps.repo.appendAudit({
        id: crypto.randomUUID(), tenantId: who.tenantId, actorType: 'user', actorId: who.userId,
        action: 'file.from_drive', targetType: 'file', targetId: file.id,
        detail: { kind, size: file.size, sha256: file.sha256 }, occurredAt: new Date().toISOString(),
      });
      return { file };
    },
  };
}
