/**
 * @file 開発の見本の会社で読む、見本の Web サイト（競合の分析。外には何も読みに行かない）。
 *
 * 自社（www.alpha.example.jp）と、近くの競合 2 社（shop-a・shop-b）。shop-b は robots.txt で `/private/` を断っている。
 */

import type { MockSite } from './fetcher.js';

const page = (title: string, body: string, links: [string, string][] = []) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title}"></head><body>`
  + `<nav>${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join(' ')}</nav>${body}</body></html>`;

/** 見本のサイト。 */
export const MOCK_SITES: MockSite = {
  'https://www.alpha.example.jp/': { body: page('アルファ商事 | オフィスの事務用品', '<h1>オフィスの事務用品をすぐにお届け</h1><p>法人向けに文具とコピー用紙を販売しています。営業時間 9:00〜18:00。</p>', [['/products', '商品と料金'], ['/news', 'お知らせ'], ['/contact', 'お問い合わせ']]) },
  'https://www.alpha.example.jp/products': { body: page('商品と料金', '<h2>コピー用紙</h2><p>A4 コピー用紙 500 枚 480円</p><h2>当日配送</h2><p>都内は当日配送 550円</p>') },
  'https://www.alpha.example.jp/news': { body: page('お知らせ', '<h2>年末年始の営業のお知らせ</h2>') },
  'https://shop-a.example.jp/': { body: page('ショップ A | 事務用品の専門店', '<h1>事務用品の専門店</h1><p>営業時間 10:00〜19:00。法人のまとめ買いに対応。</p>', [['/menu', '料金'], ['/campaign', 'キャンペーン'], ['/login', 'ログイン']]) },
  'https://shop-a.example.jp/menu': { body: page('料金', '<h2>コピー用紙</h2><p>A4 コピー用紙 500 枚 450円</p><p>翌日配送 無料</p>') },
  'https://shop-a.example.jp/campaign': { body: page('キャンペーン', '<h2>10 月のキャンペーン 初回 20% 引き</h2>') },
  'https://shop-b.example.jp/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /private/\n' },
  'https://shop-b.example.jp/': { body: page('ショップ B | 文具とオフィス家具', '<h1>文具とオフィス家具</h1><p>受付時間 9:00〜17:00</p>', [['/service', 'サービス'], ['/private/price', '会員の料金']]) },
  'https://shop-b.example.jp/service': { body: page('サービス', '<h2>オフィス家具の設置</h2><p>デスクの設置 1 台 3,000円</p>') },
  'https://shop-b.example.jp/private/price': { body: page('会員の料金', '<p>会員だけの料金 100円</p>') },
};
