/**
 * @file 会員証（仕様書 第40.5節）。紙のカードの PDF（名刺の大きさ）、QR の SVG、会員証のページと LINE の入口のページ（サーバーが作る HTML）。
 *
 * 会員証の QR には、本人だけの鍵つきの会員証のページの URL を入れる。お客様が読めば自分の会員証が開き、店員が読めば鍵から会員を引く。
 * ページは外部のスクリプトを読まない（LINE の入口だけ、LINE の LIFF の SDK を読む）。お客様の名前などは HTML に入れる前に必ず逃がす。
 */

import QRCode from 'qrcode';
import { PDFDocument, rgb } from 'pdf-lib';
import { MEMBER_RANK_LABELS, memberCardPath } from '@m2office/shared';
import type { CardView } from './service.js';
import { embedJapaneseFonts } from '../files/pdf-render.js';

/** 名刺の大きさ（91 × 55 mm）。 */
const CARD = { width: 258, height: 156 };

/** 会員証のページの URL。 */
export const memberCardUrl = (origin: string, key: string) => `${origin.replace(/\/+$/, '')}${memberCardPath(key)}`;

/** QR の SVG。 */
export async function memberQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

/**
 * 紙の会員証の PDF を作る（1 枚 1 ページ、名刺の大きさ）。
 *
 * @param company 会社の名前（カードの上に出す）
 */
export async function renderMemberCard(card: { number: number; nickname: string; url: string }, company: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('会員証');
  const { font, fit } = await embedJapaneseFonts(pdf, 'bold');
  const page = pdf.addPage([CARD.width, CARD.height]);
  page.drawRectangle({ x: 0.5, y: 0.5, width: CARD.width - 1, height: CARD.height - 1, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 });
  const qr = QRCode.create(card.url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const size = 104;
  const unit = size / n;
  const qx = CARD.width - size - 18;
  const qy = (CARD.height - size) / 2;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) page.drawRectangle({ x: qx + c * unit, y: qy + (n - 1 - r) * unit, width: unit, height: unit, color: rgb(0, 0, 0) });
    }
  }
  const draw = (s: string, y: number, sz: number, gray = 0.1) => {
    let t = fit(s);
    let z = sz;
    while (z > 6 && font.widthOfTextAtSize(t, z) > qx - 30) z -= 0.5;
    if (font.widthOfTextAtSize(t, z) > qx - 30) t = t.slice(0, 12);
    page.drawText(t, { x: 18, y, size: z, font, color: rgb(gray, gray, gray) });
  };
  draw(company || '会員証', CARD.height - 34, 11, 0.25);
  draw('会員証', CARD.height - 56, 9, 0.45);
  draw(`No. ${card.number}`, 52, 16);
  draw(card.nickname, 32, 10, 0.3);
  return pdf.save();
}

/** HTML に入れる文字を逃がす。 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `body{margin:0;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;background:#f4f6f6;color:#1d2a2a}
main{max-width:420px;margin:0 auto;padding:20px 16px 40px}.card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:15px;margin:0 0 4px;color:#555}.no{font-size:22px;font-weight:700;margin:2px 0}.name{color:#555;margin:0 0 12px}
.rank{display:inline-block;margin:0 0 8px;padding:2px 10px;border-radius:999px;background:#f3ead2;color:#7a5a12;font-weight:700;font-size:14px}
.qr svg{width:220px;height:220px;display:block;margin:8px auto}.pts{font-size:40px;font-weight:700;text-align:center;margin:8px 0 0}.pts small{font-size:15px}
ul{list-style:none;padding:0;margin:12px 0 0}li{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #eee}li.off{color:#999}
.note{font-size:12px;color:#777;margin-top:14px}input{font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px;width:100%;box-sizing:border-box}
button{font:inherit;margin-top:10px;width:100%;padding:12px;border:0;border-radius:8px;background:#1f8c84;color:#fff}`;

/** 会員証のページを開いたときのヘッダー（外部を読まず、埋め込みを許さない）。 */
export const CARD_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * 会員証のページ（本人だけが開く鍵つきの URL）。会員番号・呼び名・ランク・いまのポイント・使える特典・有効期限・QR。
 *
 * @param expiryDays 最後に貯めた日から失効までの日数
 */
export function renderCardPage(company: string, v: CardView, qrSvg: string, expiryDays: number): string {
  const m = v.member;
  const until = m.lastEarnedAt
    ? new Date(Date.parse(m.lastEarnedAt) + expiryDays * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '/')
    : null;
  const rewards = v.rewards.map((r) => `<li class="${r.enough ? '' : 'off'}"><span>${esc(r.name)}</span><span>${r.points} ポイント</span></li>`).join('');
  // ランク（第40.19節。一般は出さない）
  const rank = m.rank === 'regular' ? '' : `<p class="rank">${MEMBER_RANK_LABELS[m.rank]}会員</p>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>会員証</title><style>${STYLE}</style></head><body><main><div class="card">
<h1>${esc(company || '会員証')}</h1><p class="no">No. ${m.number}</p><p class="name">${esc(m.nickname)} さん</p>${rank}
<div class="qr">${qrSvg}</div><p class="pts">${m.balance} <small>ポイント</small></p>
${rewards ? `<ul>${rewards}</ul>` : ''}
<p class="note">お店でこの画面の QR を見せてください。${until && m.balance > 0 ? `ポイントの有効期限: ${until}（ポイントを貯めると延びます）。` : ''}この画面は、ご本人だけが開けるページです。ほかの人に教えないでください。</p>
</div></main></body></html>`;
}

/**
 * LINE の入口のページ（LIFF）。LINE の中で開くと ID トークンを受け取り、会員証のページへ移る。初めてなら呼び名を聞いて会員にする。
 *
 * @param nonce スクリプトに付ける使い捨ての値（CSP の nonce）
 */
export function renderLinePage(company: string, liffId: string, nonce: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>会員証</title><style>${STYLE}</style></head><body><main><div class="card">
<h1>${esc(company || '会員証')}</h1><p id="msg">読み込んでいます…</p>
<form id="join" hidden><p>会員になります。呼び名（ニックネームでかまいません）を入れてください。</p><input id="nick" maxlength="30" required><button type="submit">会員になる</button></form>
</div></main>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js" charset="utf-8"></script>
<script nonce="${nonce}">
(async () => {
  const msg = document.getElementById('msg');
  const join = document.getElementById('join');
  const send = async (nickname) => {
    const res = await fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: liff.getIDToken(), nickname }) });
    const body = await res.json().catch(() => ({}));
    if (body.cardUrl) { location.replace(body.cardUrl); return; }
    if (body.needsNickname) { msg.textContent = ''; join.hidden = false; document.getElementById('nick').value = body.suggested || ''; return; }
    msg.textContent = body.error || '開けませんでした';
  };
  try {
    await liff.init({ liffId: ${JSON.stringify(liffId)} });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    join.addEventListener('submit', (e) => { e.preventDefault(); join.hidden = true; msg.textContent = '会員にしています…'; send(document.getElementById('nick').value); });
    await send('');
  } catch (e) { msg.textContent = 'LINE の中で開いてください'; }
})();
</script></body></html>`;
}

/** LINE の入口のページのヘッダー（LINE の SDK と、nonce の付いたスクリプトだけを許す）。 */
export const linePageCsp = (nonce: string) =>
  `default-src 'none'; script-src https://static.line-scdn.net 'nonce-${nonce}'; connect-src 'self' https://api.line.me https://liffsdk.line-scdn.net; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
