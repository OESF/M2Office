/**
 * @file アプリの一覧に並べる Google のサービスのリンク（仕様書 第6.1.1.2節）。
 *
 * 上の帯の格子のボタンから、連携している Google のサービスを新しいタブで開く。**M2Office のデータを URL に載せない。**
 */

import type { IconName } from './nav.js';

/** リンク 1 つ。 */
export interface GoogleLink {
  /** サービスの ID（`GOOGLE_APP_IDS` のどれか）。本人が出さないと選んだものを見分ける。 */
  id: string;
  label: string;
  icon: IconName;
  href: string;
  /** マウスを重ねたときに出す説明。 */
  description: string;
}

/** 並べるサービス 1 つと、そのトップページ。 */
interface Service { id: string; label: string; icon: IconName; base: string; description: string }

/**
 * 並べるサービス。
 *
 * @remarks 仕様書 第6.1.1.2節「並べるもの」の順。M2Office がいま使う 4 つを先に置く。
 */
const SERVICES: readonly Service[] = [
  { id: 'gmail', label: 'Gmail', icon: 'mail', base: 'https://mail.google.com/mail/', description: 'Gmail を新しいタブで開きます' },
  { id: 'calendar', label: 'カレンダー', icon: 'calendar', base: 'https://calendar.google.com/calendar/', description: 'Google カレンダーを新しいタブで開きます' },
  { id: 'tasks', label: 'ToDo', icon: 'tasks', base: 'https://tasks.google.com/', description: 'Google ToDo リストを新しいタブで開きます' },
  { id: 'chat', label: 'Chat', icon: 'chat', base: 'https://chat.google.com/', description: 'Google Chat を新しいタブで開きます' },
  { id: 'drive', label: 'ドライブ', icon: 'drive', base: 'https://drive.google.com/', description: 'Google ドライブを新しいタブで開きます' },
  { id: 'docs', label: 'ドキュメント', icon: 'doc', base: 'https://docs.google.com/document/', description: 'Google ドキュメントを新しいタブで開きます' },
  { id: 'sheets', label: 'スプレッドシート', icon: 'sheet', base: 'https://docs.google.com/spreadsheets/', description: 'Google スプレッドシートを新しいタブで開きます' },
  { id: 'slides', label: 'スライド', icon: 'slides', base: 'https://docs.google.com/presentation/', description: 'Google スライドを新しいタブで開きます' },
  { id: 'meet', label: 'Meet', icon: 'video', base: 'https://meet.google.com/', description: 'Google Meet を新しいタブで開きます' },
  { id: 'forms', label: 'フォーム', icon: 'form', base: 'https://docs.google.com/forms/', description: 'Google フォームを新しいタブで開きます' },
];

/** 管理者にだけ並べる管理コンソール。 */
const ADMIN_CONSOLE: Service = {
  id: 'admin-console', label: '管理コンソール', icon: 'console', base: 'https://admin.google.com/',
  description: 'Google の管理コンソールを新しいタブで開きます（管理者向け）',
};

/**
 * 本人のアカウントで開くリンクを作る。
 *
 * @param email 本人の Google アカウント（ログインに使ったメールアドレス）。**アカウントの指定にだけ使う**
 * @param options.admin 管理者なら `true`。末尾に管理コンソールを足す
 * @returns 並べる順のリンク
 *
 * @remarks
 * ブラウザで複数の Google アカウントを使っていても仕事のアカウントで開くよう、`authuser` にメールアドレスを渡す。
 * それ以外の値（業務の中身・ID）は載せない（仕様書 第6.1.1.2節「送るもの」）。
 */
export function googleLinks(email: string, options: { admin?: boolean } = {}): GoogleLink[] {
  const q = email ? `?authuser=${encodeURIComponent(email)}` : '';
  const list = options.admin ? [...SERVICES, ADMIN_CONSOLE] : SERVICES;
  return list.map((s) => ({ id: s.id, label: s.label, icon: s.icon, href: `${s.base}${q}`, description: s.description }));
}
