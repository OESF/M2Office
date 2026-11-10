/**
 * @file メールの中身の読み書き（仕様書 第14.3.4節「Gmail」）。
 *
 * Gmail の API が返す部分（part）から本文を取り出し、送るメールを MIME に組む。
 * 日本のメールは ISO-2022-JP・Shift_JIS で届くことが多く、**宣言された文字コードで戻す**のが要点である。
 */

import { randomBytes } from 'node:crypto';

/** 本文をこの字数で切る。推論の量を抑える（仕様書 第14.3.4節）。 */
export const MAX_BODY_CHARS = 20_000;

/** Gmail の API の部分（必要なところだけ）。 */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

/** base64url を、元のバイト列に戻す。 */
export function fromBase64Url(data: string): Uint8Array {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** 部分の見出しの値を引く（名前の大小は区別しない）。 */
export function header(part: { headers?: { name: string; value: string }[] }, name: string): string {
  const h = part.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/**
 * 差出人のドメインの認証が通ったかを、Gmail が付けた認証の結果（`Authentication-Results`）から見る（仕様書 第27.6.1節）。
 *
 * @param headers メールの見出し
 * @param fromAddress 差出人のメールアドレス
 * @returns DMARC が通っているか、差出人のドメイン（かその上のドメイン）の DKIM が通っていれば `true`
 * @remarks 差出人のアドレスは偽れるため、Gmail（`mx.google.com`）が付けた結果だけを見る。途中の中継が付けた結果は信じない
 */
export function senderAuthenticated(headers: { name: string; value: string }[] | undefined, fromAddress: string): boolean {
  const domain = fromAddress.split('@')[1]?.trim().toLowerCase();
  if (!domain) return false;
  const aligned = (d: string) => { const x = d.toLowerCase().replace(/^@/, ''); return domain === x || domain.endsWith(`.${x}`); };
  for (const h of headers ?? []) {
    if (h.name.toLowerCase() !== 'authentication-results') continue;
    const value = h.value.replace(/\s+/g, ' ');
    if (!/^\s*mx\.google\.com\s*;/i.test(value)) continue;
    for (const clause of value.split(';').slice(1)) {
      const c = clause.trim();
      const dmarc = /^dmarc=pass\b.*header\.from=([^\s;]+)/i.exec(c);
      if (dmarc && aligned(dmarc[1]!)) return true;
      const dkim = /^dkim=pass\b.*header\.(?:i|d)=([^\s;]+)/i.exec(c);
      if (dkim && aligned(dkim[1]!.includes('@') ? dkim[1]!.split('@')[1]! : dkim[1]!)) return true;
    }
  }
  return false;
}

/** `Content-Type` から文字コードを取り出す。無ければ `utf-8`。 */
export function charsetOf(part: GmailPart): string {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(header(part, 'Content-Type'));
  return (m?.[1] ?? 'utf-8').toLowerCase();
}

/**
 * バイト列を、宣言された文字コードで文字にする。
 *
 * @remarks
 * 宣言どおりに戻して化けた（置き換えの字 U+FFFD が出た）ときだけ、UTF-8 として読み直す。
 * 宣言と中身が食い違うメールは珍しくない。**どちらでも化けるなら、宣言どおりの結果を返す**（黙って字を捨てない）。
 * 知らない文字コードの名前なら UTF-8 で読む。
 */
export function decodeText(bytes: Uint8Array, charset: string): string {
  const name = charset === 'x-sjis' || charset === 'sjis' || charset === 'cp932' || charset === 'windows-31j' ? 'shift_jis' : charset;
  let text: string;
  try {
    text = new TextDecoder(name).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
  if (!text.includes('�') || name === 'utf-8') return text;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

/**
 * 見出しの符号化された語（RFC 2047。`=?ISO-2022-JP?B?…?=`）を戻す。符号化されていなければそのまま返す。
 *
 * @remarks Gmail の API は見出しを戻して返すことが多いが、戻さずに返す場合にも備える。
 */
export function decodeHeaderWords(value: string): string {
  // 符号化された語どうしの間の空白は捨てる（RFC 2047 第6.2節）
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_all, cs: string, enc: string, data: string) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64')
      : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return decodeText(bytes, cs.toLowerCase());
  });
}

/** 文字の参照（`&amp;`・`&#39;`・`&#x3042;`）を戻す。Gmail の抜粋にも使う。 */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
    // 宣伝のメールによく出るもの（プレビューの文を詰める zwnj など、見えない文字は消す。第 0.546.0 版）
    zwnj: '', zwj: '', shy: '', lrm: '', rlm: '', ensp: ' ', emsp: ' ', thinsp: ' ',
    yen: '¥', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', bull: '•', middot: '·', times: '×', divide: '÷',
    laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', rarr: '→', larr: '←', uarr: '↑', darr: '↓',
    deg: '°', plusmn: '±', sect: '§', para: '¶', euro: '€', pound: '£', cent: '¢',
  };
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return named[e.toLowerCase()] ?? all;
  });
}

/**
 * 囲みの中身ごと消す（`<script>…</script>`・`<!-- … -->` など）。**頭から一度だけ読み進める**ので、閉じの無い形が長く続いても時間がかからない。
 *
 * @param open 囲みの始まり（`g` を付けた正規表現。1 つ目の組が名前）。`null` ならコメント（`<!--` と `-->`）
 * @param dropUnclosed 閉じが無ければ、そこから後ろをすべて消す（プログラムや見た目の中身を、文として出さないため）。`false` なら始まりの印だけを消す
 */
function removeBlocks(html: string, open: RegExp | null, dropUnclosed: boolean): string {
  const lower = html.toLowerCase();
  // 閉じが一度見つからなかった名前（それより後ろにも無いので、二度と探さない）
  const missing = new Set<string>();
  let out = '';
  let pos = 0;
  for (;;) {
    let start: number;
    let after: number;
    let close: string;
    if (open) {
      open.lastIndex = pos;
      const m = open.exec(html);
      if (!m) break;
      start = m.index;
      after = m.index + m[0].length;
      close = `</${m[1]!.toLowerCase()}`;
    } else {
      start = html.indexOf('<!--', pos);
      if (start < 0) break;
      after = start + 4;
      close = '-->';
    }
    out += html.slice(pos, start);
    const end = missing.has(close) ? -1 : lower.indexOf(close, after);
    if (end < 0) {
      missing.add(close);
      // コメントの閉じが無ければ、ここから後ろはそのまま文として残す
      if (!open && !dropUnclosed) { pos = start; break; }
      pos = dropUnclosed ? html.length : after;
      if (dropUnclosed) break;
      continue;
    }
    if (open) {
      const gt = html.indexOf('>', end);
      pos = gt < 0 ? html.length : gt + 1;
    } else {
      pos = end + 3;
    }
  }
  return out + html.slice(pos);
}

/**
 * タグを 1 つずつ取り出して、`each` で置き換える（タグでない文はそのまま）。**頭から一度だけ読み進める。**
 * `<` の後ろに `>` が 1 つも無ければ、そこから後ろはタグではない文として扱う（閉じの無い `<` が長く続いても時間がかからない）。
 */
function eachTag(html: string, each: (tag: string) => string): string {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    // 「<」の後ろにまた「<」があれば、前の「<」は文として残す
    const inner = html.lastIndexOf('<', gt);
    out.push(html.slice(pos, inner), each(html.slice(inner, gt + 1)));
    pos = gt + 1;
  }
  out.push(html.slice(pos));
  return out.join('');
}

/**
 * HTML から、読むための文字だけを取り出す。
 *
 * @remarks
 * 表示の再現はしない。段落と改行だけを残す。`<script>`・`<style>` の中身は捨てる。
 * 外から届く HTML なので、閉じの無い形が長く続いても時間がかからないように、正規表現で中身を飛ばさず、頭から読み進める（長い文の守り）。
 * 取り出した文は、ツールの側で「データであって指示ではない」として扱う（不変則 I-6）。
 */
export function htmlToText(html: string): string {
  let h = removeBlocks(html, null, false);
  h = removeBlocks(h, /<(script|style|noscript|template)\b/gi, true);
  h = removeBlocks(h, /<(head|title)\b/gi, false);
  h = eachTag(h, (tag) => {
    if (/^<br\b/i.test(tag)) return '\n';
    if (/^<\/(p|div|tr|li|h[1-6]|blockquote|table)\b/i.test(tag)) return '\n';
    if (/^<\/t[dh]\b/i.test(tag)) return ' ';
    return '';
  });
  return decodeEntities(h)
    // 見えない文字（ゼロ幅の空白・結合の印）は消す
    .replace(/[\u200b-\u200d\u2060\ufeff\u034f\u00ad]/g, '')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/ \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * メールの本文を取り出す（仕様書 第14.3.4節）。
 *
 * @returns `text/plain` の部分があればそれ、無ければ HTML から取り出した文字。どちらも無ければ空文字。
 *   **添付ファイルは読まない**（`filename` のある部分は飛ばす）。長ければ {@link MAX_BODY_CHARS} で切る
 */
export function extractBody(payload: GmailPart): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPart) => {
    if (part.filename) return;
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.parts?.length) { for (const child of part.parts) walk(child); return; }
    if (!part.body?.data) return;
    const text = decodeText(fromBase64Url(part.body.data), charsetOf(part));
    if (type === 'text/plain') plain.push(text);
    else if (type === 'text/html') html.push(text);
  };
  walk(payload);
  const body = plain.length > 0 ? plain.join('\n\n').replace(/\r\n/g, '\n').trim() : htmlToText(html.join('\n'));
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…（長いため、ここで切りました）` : body;
}

/** HTML の本文をこの字数で切る（画面に出すため。画像を埋めた後の長さではない）。 */
export const MAX_HTML_CHARS = 2_000_000;

/** メールの中に埋め込まれた画像（`cid:` で参照されるもの）。 */
export interface InlinePart {
  /** `Content-ID` の値（`<` `>` を除き、小文字）。 */
  contentId: string;
  mimeType: string;
  /** 小さい画像は部分の中に入っている（base64url）。 */
  data?: string;
  /** 大きい画像は、別に取りに行く。 */
  attachmentId?: string;
  size: number;
}

/**
 * HTML の本文と、埋め込まれた画像を取り出す（メールの画面で、Gmail と同じ見た目で出すため。仕様書 第9.5.1.1節「1 件を開いたとき」）。
 *
 * @returns HTML の部分が無ければ `html` は空文字
 */
export function extractHtml(payload: GmailPart): { html: string; inline: InlinePart[] } {
  const html: string[] = [];
  const inline: InlinePart[] = [];
  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.parts?.length) { for (const child of part.parts) walk(child); return; }
    const cid = header(part, 'Content-ID').replace(/^\s*<|>\s*$/g, '').trim().toLowerCase();
    if (cid && type.startsWith('image/')) {
      inline.push({ contentId: cid, mimeType: type, size: part.body?.size ?? 0, ...(part.body?.data ? { data: part.body.data } : {}), ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}) });
      return;
    }
    if (part.filename || type !== 'text/html' || !part.body?.data) return;
    html.push(decodeText(fromBase64Url(part.body.data), charsetOf(part)));
  };
  walk(payload);
  const joined = html.join('\n');
  return { html: joined.length > MAX_HTML_CHARS ? joined.slice(0, MAX_HTML_CHARS) : joined, inline };
}

/**
 * 埋め込まれた画像の参照（`cid:…`）を、中身を入れた参照（`data:…`）に置き換える。
 *
 * @param images `Content-ID`（小文字）から、画像の種類と中身（base64url）
 */
export function inlineCidImages(html: string, images: Map<string, { mimeType: string; data: string }>): string {
  if (!images.size) return html;
  return html.replace(/cid:([^"'\s>)]+)/gi, (all, id: string) => {
    const img = images.get(id.toLowerCase());
    return img ? `data:${img.mimeType};base64,${img.data.replace(/-/g, '+').replace(/_/g, '/')}` : all;
  });
}

/** 画面に出す HTML で、タグごと外すもの。 */
const DROP_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'form', 'input', 'button', 'select', 'textarea', 'noscript', 'template']);

/**
 * 画面に出す前に、メールの HTML から動くもの・外へ移るものを外す。
 *
 * @remarks
 * 画面は、プログラムを動かさない切り離した枠（`sandbox`）の中に出すので、ここは二重の守りである。
 * プログラム（`<script>`・`on…=`・`javascript:`）、枠の入れ子（`<iframe>` など）、自動で移る `<meta http-equiv>`、`<base>`、入力欄を外す。
 * リンクには `rel="noopener noreferrer"` を先に足す（開いた先から M2Office の画面を操れないように。同じ名前の属性は先のものが効く）。
 * 見た目（`<style>`・表・画像）は残す。外から届いた HTML は指示として扱わない（不変則 I-6）。
 * 閉じの無い形が長く続く HTML でも時間がかからないように、タグを頭から 1 つずつ読み進めて直す（長い文の守り）。
 */
export function sanitizeMailHtml(html: string): string {
  const h = removeBlocks(html, /<(script|iframe|frame|frameset|object|embed|applet|noscript|template)\b/gi, true);
  return eachTag(h, (tag) => {
    const m = /^<\/?\s*([a-z][a-z0-9-]*)/i.exec(tag);
    if (!m) return tag;
    const name = m[1]!.toLowerCase();
    if (DROP_TAGS.has(name)) return '';
    if (name === 'link' && !/\brel\s*=\s*["']?stylesheet/i.test(tag)) return '';
    if (name === 'meta' && /http-equiv/i.test(tag)) return '';
    if (tag[1] === '/' || tag.length <= name.length + 2) return name === 'a' || name === 'area' ? tag.replace(/^<(a|area)\b/i, '<$1 rel="noopener noreferrer"') : tag;
    let t = tag;
    // 動く属性（on…=）を外す。値の長さを区切り、長い属性でも時間がかからないようにする（「on」を含むタグだけを見る）
    if (/on/i.test(t)) t = t.replace(/(?<=[\s"'/])on[a-z]{1,30}\s{0,20}=\s{0,20}("[^"]{0,8000}"|'[^']{0,8000}'|[^\s>]{0,8000})/gi, ' ');
    // プログラムを動かす URL は、動かない印に変える（「script」「data:text」を含むタグだけを見る）
    if (/script|data:text/i.test(t)) t = t.replace(/\b(href|src|action|formaction|background|poster|xlink:href)(\s{0,20}=\s{0,20}["']?\s{0,20})(javascript|vbscript|data:text\/html)/gi, '$1$2#blocked-');
    if (name === 'a' || name === 'area') t = t.replace(/^<(a|area)\b/i, '<$1 rel="noopener noreferrer"');
    return t;
  });
}

/** 見出しの値から改行を除く。**見出しの差し込み（ヘッダー インジェクション）を防ぐ。** */
function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim();
}

/** 英数字だけでない見出しの値を、RFC 2047 の B 符号化にする。 */
export function encodeHeaderWord(v: string): string {
  const s = oneLine(v);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
}

/** 宛先 1 つ（`名前 <addr>` か `addr`）を、見出しに書ける形にする。名前だけを符号化する。 */
export function encodeAddress(v: string): string {
  const s = oneLine(v);
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (!m) return s;
  const name = m[1]!.replace(/^"|"$/g, '').trim();
  return name ? `${encodeHeaderWord(name)} <${m[2]}>` : `<${m[2]}>`;
}

/**
 * 送る（または下書きにする）メールを、Gmail の `raw` の形に組む。
 *
 * @returns base64url にした MIME のメッセージ
 *
 * @remarks
 * 本文は UTF-8 のプレーンテキストを base64 で送る（日本語を 7 ビットの経路でも崩さないため）。
 * 返信のときは `inReplyTo`（元のメールの `Message-ID`）と `references` を付け、同じスレッドに置く。
 * `From` は、`from` を渡したときだけ付ける（別名から送るとき。問い合わせの窓口のアカウント。第33.18節）。渡さなければ Gmail が本人のアドレスを入れる。
 * `html` を渡すと、文字だけの本文と HTML の両方を付ける（`multipart/alternative`）。`inline` は HTML から `cid:` で指す埋め込みの画像
 * （`multipart/related`。外部のアプリからの配信のロゴ。第13.4.4節）。中身は書き換えない。
 */
export function buildRawMessage(m: {
  to: string[]; cc: string[]; subject: string; body: string;
  /** 差出人（Gmail の「送信元として使うアドレス」に登録した別名だけが使える）。 */
  from?: string | null;
  inReplyTo?: string | null; references?: string | null;
  /**
   * 配信の停止の先（第27.9.1節・第13.4.4節）。`http(s)` の URL なら押すだけで止まる形（RFC 8058）も付け、
   * `mailto:` なら返信で止める形だけを付ける（ローカルの形は院外から開けるページを持てないため）。
   */
  listUnsubscribe?: string | null;
  /** 添えるファイル（`multipart/mixed` にする。第9.5.8節）。 */
  attachments?: { name: string; mime: string; bytes: Uint8Array }[];
  /** HTML の本文（文字だけの本文 `body` と一緒に送る）。 */
  html?: string | null;
  /** HTML に埋め込む画像（`cid` で指す）。 */
  inline?: { cid: string; mime: string; bytes: Uint8Array }[];
  /** 足す見出し（`X-` で始まる名前だけ。外部のアプリからの配信の宛先の ID `X-M2O-Recipient` など）。 */
  headers?: Record<string, string>;
}): string {
  const http = m.listUnsubscribe && /^https?:\/\/\S+$/.test(m.listUnsubscribe) ? oneLine(m.listUnsubscribe) : null;
  const mailto = !http && m.listUnsubscribe && /^mailto:[^\s<>]+$/.test(m.listUnsubscribe) ? oneLine(m.listUnsubscribe) : null;
  const lines: string[] = [
    ...(m.from ? [`From: ${encodeAddress(m.from)}`] : []),
    `To: ${m.to.map(encodeAddress).join(', ')}`,
    ...(m.cc.length > 0 ? [`Cc: ${m.cc.map(encodeAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${oneLine(m.references)}`] : []),
    // 押すだけで止まる配信の停止（RFC 8058）か、返信で止める宛先
    ...(http ? [`List-Unsubscribe: <${http}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
    ...(mailto ? [`List-Unsubscribe: <${mailto}>`] : []),
    ...Object.entries(m.headers ?? {}).filter(([k]) => /^X-[A-Za-z0-9-]{1,60}$/.test(k)).map(([k, v]) => `${k}: ${oneLine(v)}`),
    'MIME-Version: 1.0',
  ];
  const b64 = (bytes: Uint8Array) => (Buffer.from(bytes).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  const text = b64(Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf-8'));
  const boundaryOf = () => `m2o-${randomBytes(12).toString('hex')}`;
  /** 本文の部分（HTML があれば alternative、埋め込みの画像があれば related で包む）。見出しと中身の行を返す。 */
  const bodyPart = (): string[] => {
    if (!m.html) return ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', text];
    const alt = boundaryOf();
    const alternative = [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`,
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', text, `--${alt}`,
      'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(m.html, 'utf-8')), `--${alt}--`];
    if (!m.inline?.length) return alternative;
    const rel = boundaryOf();
    const out = [`Content-Type: multipart/related; boundary="${rel}"`, '', `--${rel}`, ...alternative];
    for (const img of m.inline) {
      const mime = /^image\/(png|jpeg|gif|webp)$/i.test(img.mime) ? img.mime : 'application/octet-stream';
      const cid = oneLine(img.cid).replace(/[<>\s]/g, '');
      out.push(`--${rel}`, `Content-Type: ${mime}`, 'Content-Transfer-Encoding: base64', `Content-ID: <${cid}>`, 'Content-Disposition: inline', '', b64(img.bytes));
    }
    out.push(`--${rel}--`);
    return out;
  };
  if (!m.attachments?.length) {
    lines.push(...bodyPart());
  } else {
    const boundary = boundaryOf();
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...bodyPart());
    for (const a of m.attachments) {
      // 名前は RFC 2231 の形で送る（日本語の名前が化けないように）。種類は決まったものだけ
      const mime = /^[a-z]+\/[a-z0-9.+-]+$/i.test(a.mime) ? a.mime : 'application/octet-stream';
      const name = `UTF-8''${encodeURIComponent(oneLine(a.name))}`;
      lines.push(`--${boundary}`, `Content-Type: ${mime}`, 'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename*=${name}`, '', b64(a.bytes));
    }
    lines.push(`--${boundary}--`);
  }
  return Buffer.from(lines.join('\r\n'), 'utf-8').toString('base64url');
}

/** 配信のメールの印になる見出し（第44.4節）。 */
const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;

/**
 * 配信のメールか（第44.4節。メールの片付けの振り分けでも、推論を呼ばずに「宣伝・お知らせ」にする。第9.5.1.1節）。
 *
 * @param payload 見出しのある部分（`format=metadata` でも足りる）
 */
export function isBulkMail(payload: { headers?: { name: string; value: string }[] }, labelIds: string[]): boolean {
  return !!header(payload, 'List-Unsubscribe') || !!header(payload, 'List-Id') || BULK_PRECEDENCE.test(header(payload, 'Precedence').trim())
    || labelIds.includes('CATEGORY_PROMOTIONS');
}

/**
 * 1 通のメールから、添付の一覧を作る（資料の取り込み。仕様書 第44.4節）。中身は読まない。
 *
 * @param m Gmail のメール（`format=full`）
 * @returns 送り主・件名・受け取った時刻・配信のメールか・添付（本文の HTML から `cid:` で指される画像には `embedded` を付ける）
 *
 * @remarks 何を取り込まないかは資料の側の決まりで決める。ここでは見えた事実だけを返す
 */
export function mailAttachmentListOf(m: { id: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }): {
  id: string; from: string; subject: string; receivedAt: string; bulk: boolean;
  parts: { attachmentId: string; name: string; mime: string; size: number; embedded: boolean }[];
} {
  const payload = m.payload ?? {};
  const cids = new Set<string>();
  const files: GmailPart[] = [];
  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.filename && part.body?.attachmentId) files.push(part);
    else if (type === 'text/html' && part.body?.data) {
      const html = decodeText(fromBase64Url(part.body.data), charsetOf(part));
      for (const hit of html.matchAll(/cid:([^"'\s>)]+)/gi)) cids.add(hit[1]!.toLowerCase());
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const received = m.internalDate ? new Date(Number(m.internalDate)) : new Date(header(payload, 'Date'));
  const bulk = isBulkMail(payload, m.labelIds ?? []);
  return {
    id: m.id,
    from: decodeHeaderWords(header(payload, 'From')),
    subject: decodeHeaderWords(header(payload, 'Subject')),
    receivedAt: Number.isFinite(received.getTime()) ? received.toISOString() : '',
    bulk,
    parts: files.map((part) => {
      const cid = header(part, 'Content-ID').trim().replace(/^<|>$/g, '').toLowerCase();
      return {
        attachmentId: part.body!.attachmentId!,
        name: decodeHeaderWords(part.filename!),
        mime: (part.mimeType ?? 'application/octet-stream').toLowerCase(),
        size: part.body?.size ?? 0,
        embedded: !!cid && cids.has(cid),
      };
    }),
  };
}
