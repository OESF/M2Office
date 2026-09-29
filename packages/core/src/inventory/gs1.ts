/**
 * @file バーコードの値を解く（仕様書 第29.8節・第29.11節）。JAN・UPC と、GS1 データバー・GS1-128 の商品コード・使用期限・ロット。
 *
 * 読み取りの部品や USB のリーダーが返す文字列を受け取り、品目に照らすための形にする。
 * GS1 は、区切りの文字（GS、0x1D）で区切った形と、人が読む括弧の形（`(01)…(17)…(10)…`）の両方を受け付ける。
 */

/** 解いた結果。 */
export interface ParsedCode {
  /** 品目に照らす値。GTIN なら 13 桁の JAN に直せるものは直す（先頭の 0 を落とす）。それ以外は読んだ値そのまま。 */
  code: string;
  /** GS1 の商品コード（14 桁）。GS1 でなければ `null`。 */
  gtin: string | null;
  /** 使用期限（`YYYY-MM-DD`）。GS1 の (17)。無ければ `null`。 */
  expiresOn: string | null;
  /** ロット。GS1 の (10)。無ければ `null`。 */
  lot: string | null;
  /** 読んだ種類。 */
  kind: 'gs1' | 'ean' | 'other';
}

/** GS1 の区切りの文字。 */
const GS = '\u001d';

/** 桁数が決まっている AI（Application Identifier）と、その桁数。 */
const FIXED: Record<string, number> = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };

/** 桁数が変わる AI（区切りまで読む）。 */
const VARIABLE = new Set(['10', '21', '22', '30', '37', '240', '241', '250', '251', '400', '401', '402', '403', '420', '421']);

/** 読み取りの部品が付ける符号の印（`]C1`・`]e0`・`]d2` など）を落とす。 */
function stripSymbology(raw: string): string {
  return raw.replace(/^\][A-Za-z]\d/, '');
}

/** YYMMDD を `YYYY-MM-DD` にする。日が 00 ならその月の末日（GS1 の決まり）。年は 2000 年代とする。 */
export function gs1Date(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const y = 2000 + Number(yymmdd.slice(0, 2));
  const m = Number(yymmdd.slice(2, 4));
  let d = Number(yymmdd.slice(4, 6));
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d === 0) d = last;
  if (d > last) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** GTIN（8〜14 桁）の検査数字が正しいか。 */
export function validGtin(digits: string): boolean {
  if (!/^\d{8,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const n = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** GTIN-14 を、品目に照らす値にする（先頭が 0 なら 13 桁の JAN）。 */
function fromGtin14(gtin: string): string {
  return gtin.startsWith('0') ? gtin.slice(1) : gtin;
}

/** 括弧の形（`(01)…(17)…`）を解く。 */
function parseBracketed(s: string): Map<string, string> | null {
  const re = /\((\d{2,4})\)([^()]*)/g;
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s)) !== null) {
    out.set(m[1]!, m[2]!.trim());
    consumed += m[0].length;
  }
  return out.size > 0 && consumed === s.replace(/\s+$/, '').length ? out : null;
}

/** 区切りの文字の形（生の GS1 の文字列）を解く。 */
function parseRaw(s: string): Map<string, string> | null {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) { i++; continue; }
    const two = s.slice(i, i + 2);
    const three = s.slice(i, i + 3);
    if (FIXED[two] !== undefined) {
      const len = FIXED[two]!;
      const v = s.slice(i + 2, i + 2 + len);
      if (v.length !== len) return null;
      out.set(two, v);
      i += 2 + len;
      continue;
    }
    const ai = VARIABLE.has(three) ? three : VARIABLE.has(two) ? two : null;
    if (!ai) return null;
    const start = i + ai.length;
    const end = s.indexOf(GS, start);
    const v = s.slice(start, end === -1 ? undefined : end).slice(0, 30);
    out.set(ai, v);
    i = end === -1 ? s.length : end + 1;
  }
  return out.size > 0 ? out : null;
}

/**
 * 読み取った値を解く。
 *
 * @param raw 読み取りの部品や USB のリーダーが返した文字列
 * @remarks
 * GS1 として解けなければ、JAN・UPC（8・12・13 桁で検査数字が正しいもの）として扱う。それ以外は読んだ値のまま返す。
 * 推測で値を作らない（読めなかったロットや期限は `null`）。
 */
export function parseCode(raw: string): ParsedCode {
  const s = stripSymbology(raw.trim());
  const hasGs1Mark = s.includes(GS) || s.startsWith('(') || /^\]C1|^\]e0/.test(raw.trim());
  const fields = s.startsWith('(') ? parseBracketed(s) : (hasGs1Mark || /^01\d{14}/.test(s)) ? parseRaw(s) : null;
  if (fields && (fields.has('01') || fields.has('02'))) {
    const gtin = fields.get('01') ?? fields.get('02')!;
    return {
      code: fromGtin14(gtin), gtin,
      expiresOn: fields.has('17') ? gs1Date(fields.get('17')!) : null,
      lot: fields.get('10') || null,
      kind: 'gs1',
    };
  }
  const digits = s.replace(/\s/g, '');
  if (/^\d+$/.test(digits) && [8, 12, 13, 14].includes(digits.length) && validGtin(digits)) {
    // 12 桁の UPC-A は、先頭に 0 を付けた 13 桁として照らす（JAN と同じ桁にそろえる）
    const code = digits.length === 12 ? `0${digits}` : digits.length === 14 ? fromGtin14(digits) : digits;
    return { code, gtin: digits.length === 14 ? digits : null, expiresOn: null, lot: null, kind: 'ean' };
  }
  return { code: s, gtin: null, expiresOn: null, lot: null, kind: 'other' };
}
