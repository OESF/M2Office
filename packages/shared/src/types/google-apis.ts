/**
 * @file M2Office が使う Google の API の一覧と、Google Cloud でまとめて有効にする画面の URL（仕様書 第6.6.2節「必要な API をまとめて有効にする」、Q-269）。
 *
 * 管理者ページの「必要な API をまとめて有効にする」と「有効になっていない API」（その API を有効にする画面）が使う。
 */

/** Google の API 1 つ（サービスの名前と、画面に出す名前）。 */
export interface GoogleApi {
  service: string;
  label: string;
}

/** M2Office が使う Google の API（使わない機能の API が有効でも、費用も害も無い）。 */
export const GOOGLE_APIS: readonly GoogleApi[] = [
  { service: 'gmail.googleapis.com', label: 'Gmail API' },
  { service: 'calendar-json.googleapis.com', label: 'Google Calendar API' },
  { service: 'tasks.googleapis.com', label: 'Google Tasks API' },
  { service: 'chat.googleapis.com', label: 'Google Chat API' },
  { service: 'drive.googleapis.com', label: 'Google Drive API' },
  { service: 'docs.googleapis.com', label: 'Google Docs API' },
  { service: 'sheets.googleapis.com', label: 'Google Sheets API' },
  { service: 'slides.googleapis.com', label: 'Google Slides API' },
  { service: 'people.googleapis.com', label: 'People API' },
  { service: 'meet.googleapis.com', label: 'Google Meet REST API' },
  { service: 'picker.googleapis.com', label: 'Google Picker API' },
  { service: 'admin.googleapis.com', label: 'Admin SDK API' },
];

/** サービスの名前から、画面に出す名前（一覧に無ければサービスの名前のまま）。 */
export function googleApiLabel(service: string): string {
  return GOOGLE_APIS.find((a) => a.service === service)?.label ?? service;
}

/**
 * OAuth クライアント ID の頭の、Google Cloud のプロジェクトの番号（`123456789-abc.apps.googleusercontent.com` の `123456789`）。取れなければ `null`。
 */
export function googleProjectNumber(clientId: string): string | null {
  const m = /^(\d{6,})-/.exec(clientId.trim());
  return m ? m[1]! : null;
}

/**
 * Google Cloud の「API をまとめて有効にする」画面の URL。プロジェクトの番号があれば、そのプロジェクトで開く（無ければプロジェクトを選ぶ画面から）。
 *
 * @param services 有効にする API（サービスの名前）
 */
export function googleEnableApiUrl(services: readonly string[], projectNumber: string | null): string {
  const q = new URLSearchParams({ apiid: services.join(',') });
  if (projectNumber) q.set('project', projectNumber);
  return `https://console.cloud.google.com/flows/enableapi?${q.toString().replace(/%2C/g, ',')}`;
}
