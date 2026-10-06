/**
 * @file Google のファイルを選ぶ画面（Google Picker）を開き、本人が選んだ画像を 1 枚返す（仕様書 第41.19.2節）。
 *
 * 渡すアクセス トークンは、サーバーが `drive.file` だけに絞って取り直したもの。選んだファイルだけが M2Office から見えるようになる。
 * Google の画面の部品（`https://apis.google.com/js/api.js`）は、選ぶときに初めて読み込む。
 */

/** Google Picker の、ここで使う所だけの型。 */
interface DocsView { setMimeTypes(m: string): DocsView; setIncludeFolders(b: boolean): DocsView }
interface PickerData { action: string; docs?: { id: string; name: string }[] }
interface PickerBuilder {
  addView(v: DocsView): PickerBuilder; setOAuthToken(t: string): PickerBuilder; setDeveloperKey(k: string): PickerBuilder;
  setAppId(a: string): PickerBuilder; setLocale(l: string): PickerBuilder; setCallback(cb: (d: PickerData) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
interface PickerNamespace {
  DocsView: new (viewId: string) => DocsView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS_IMAGES: string };
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
