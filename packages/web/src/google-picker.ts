/**
 * @file Google のファイルを選ぶ画面（Google Picker）を開き、本人が選んだ画像を 1 枚返す（仕様書 第41.19.2節）。
 *
 * 渡すアクセス トークンは、サーバーが `drive.file` だけに絞って取り直したもの。選んだファイルだけが M2Office から見えるようになる。
 * Google の画面の部品（`https://apis.google.com/js/api.js`）は、選ぶときに初めて読み込む。
 */

/** Google Picker の、ここで使う所だけの型。 */
interface DocsView { setMimeTypes(m: string): DocsView; setIncludeFolders(b: boolean): DocsView; setFileIds?(ids: string): DocsView }
interface PickerData { action: string; docs?: { id: string; name: string }[] }
interface PickerBuilder {
  addView(v: DocsView): PickerBuilder; setOAuthToken(t: string): PickerBuilder; setDeveloperKey(k: string): PickerBuilder;
  setAppId(a: string): PickerBuilder; setLocale(l: string): PickerBuilder; setCallback(cb: (d: PickerData) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
interface PickerNamespace {
  DocsView: new (viewId: string) => DocsView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS_IMAGES: string; DOCS: string };
  Action: { PICKED: string; CANCEL: string };
}

const SCRIPT = 'https://apis.google.com/js/api.js';
let loading: Promise<void> | null = null;

/** Google の画面の部品を読み込み、Picker を使えるようにする（1 回だけ）。 */
function loadPicker(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => {
      const gapi = (window as unknown as { gapi?: { load(name: string, cb: () => void): void } }).gapi;
      if (!gapi) { reject(new Error('Google の画面の部品を読み込めませんでした')); return; }
      gapi.load('picker', () => resolve());
    };
    s.onerror = () => { loading = null; reject(new Error('Google の画面の部品を読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * 画像を 1 枚選ぶ。
 *
 * @returns 選んだファイルの ID と名前。やめたら `null`
 */
export async function pickDriveImage(p: { apiKey: string; appId: string; accessToken: string }): Promise<{ id: string; name: string } | null> {
  await loadPicker();
  const picker = (window as unknown as { google: { picker: PickerNamespace } }).google.picker;
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS_IMAGES).setMimeTypes('image/png,image/jpeg').setIncludeFolders(true);
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(p.accessToken)
      .setDeveloperKey(p.apiKey)
      .setAppId(p.appId)
      .setLocale('ja')
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED && data.docs?.[0]) resolve({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}

/** 秘書に渡せるドライブのファイルの種類（PDF・Word・Excel・CSV・画像と、Google のドキュメント・スプレッドシート・スライド。第10.10.8節）。 */
const SECRETARY_MIMES = [
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'image/png', 'image/jpeg',
  'application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.presentation',
].join(',');

/**
 * 秘書に渡すファイルを 1 つ選ぶ（仕様書 第10.10.8節）。
 *
 * @param p.fileId 貼られたリンクのファイル。あれば、そのファイルを選んだ状態で開く（押すだけで渡せる）
 * @returns 選んだファイルの ID と名前。やめたら `null`
 */
export async function pickDriveFile(p: { apiKey: string; appId: string; accessToken: string; fileId?: string }): Promise<{ id: string; name: string } | null> {
  await loadPicker();
  const picker = (window as unknown as { google: { picker: PickerNamespace } }).google.picker;
  return new Promise((resolve) => {
    let view = new picker.DocsView(picker.ViewId.DOCS).setMimeTypes(SECRETARY_MIMES).setIncludeFolders(true);
    if (p.fileId && view.setFileIds) view = view.setFileIds(p.fileId);
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(p.accessToken)
      .setDeveloperKey(p.apiKey)
      .setAppId(p.appId)
      .setLocale('ja')
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED && data.docs?.[0]) resolve({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}

/** ドライブ・ドキュメント・スプレッドシート・スライドのリンクから、ファイルの ID を取り出す（無ければ `null`）。 */
export function driveFileIdOf(text: string): string | null {
  const m = /https:\/\/(?:drive|docs)\.google\.com\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,})/.exec(text)
    ?? /https:\/\/drive\.google\.com\/open\?id=([A-Za-z0-9_-]{10,})/.exec(text);
  return m ? m[1]! : null;
}

