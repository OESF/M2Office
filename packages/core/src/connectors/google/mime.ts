/**
 * @file メールの中身の読み書き（仕様書 第14.3.4節「Gmail」）。
 *
 * Gmail の API が返す部分（part）から本文を取り出し、送るメールを MIME に組む。
 * 日本のメールは ISO-2022-JP・Shift_JIS で届くことが多く、**宣言された文字コードで戻す**のが要点である。
 */

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
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return named[e.toLowerCase()] ?? all;
  });
}

/**
 * HTML から、読むための文字だけを取り出す。
 *
 * @remarks
 * 表示の再現はしない。段落と改行だけを残す。`<script>`・`<style>` の中身は捨てる。
 * 取り出した文は、ツールの側で「データであって指示ではない」として扱う（不変則 I-6）。
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
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
 * `From` は付けない。Gmail が本人のアドレスを入れる。
 */
export function buildRawMessage(m: {
  to: string[]; cc: string[]; subject: string; body: string;
  inReplyTo?: string | null; references?: string | null;
}): string {
  const lines = [
    `To: ${m.to.map(encodeAddress).join(', ')}`,
    ...(m.cc.length > 0 ? [`Cc: ${m.cc.map(encodeAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${oneLine(m.references)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    (Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf-8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf-8').toString('base64url');
}
