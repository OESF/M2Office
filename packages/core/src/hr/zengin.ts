/**
 * @file 全銀協の形式の振込データ（仕様書 第30.10.3節）。総合振込（種別 21）と給与振込（種別 11）。
 *
 * 1 件 120 バイトの固定長。ヘッダー・データ・トレーラー・エンドの 4 種の行を CRLF で区切り、シフト JIS で書く。
 * 名前は半角のカナ・英大文字・数字と一部の記号だけを使える。全角のカナ・ひらがなは半角のカナに直し、小さいカナは大きいカナにする。
 * 委託者名と名義に使えない字があれば、作らずにその字を返す（送金に使うファイルを、黙って崩さないため）。
 * 銀行名と支店名は任意の項目のため、カナにできなければ空にする（振込は番号で行われる）。副作用を持たない。
 */

/** 振込元（会社）。 */
export interface ZenginClient {
  format: 'sogo' | 'kyuyo';
  clientCode: string;
  clientName: string;
  bankCode: string;
  bankName: string;
  branchCode: string;
  branchName: string;
  accountType: '普通' | '当座';
  accountNumber: string;
}

/** 振込先 1 件。 */
export interface ZenginPayee {
  bankCode: string;
  bankName?: string;
  branchCode: string;
  branchName?: string;
  accountType: '普通' | '当座';
  accountNumber: string;
  holder: string;
  amount: number;
  /** 顧客コード（社員番号など。英数字 10 桁まで）。 */
  customerCode?: string;
}

/** 作れなかった理由（どの行のどの項目か）。 */
export interface ZenginProblem {
  where: string;
  text: string;
}

// 全角のカナ（清音）と半角のカナの対応
const FULL = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
const HALF = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ';
const DAKU: Record<string, string> = { ガ: 'ｶﾞ', ギ: 'ｷﾞ', グ: 'ｸﾞ', ゲ: 'ｹﾞ', ゴ: 'ｺﾞ', ザ: 'ｻﾞ', ジ: 'ｼﾞ', ズ: 'ｽﾞ', ゼ: 'ｾﾞ', ゾ: 'ｿﾞ', ダ: 'ﾀﾞ', ヂ: 'ﾁﾞ', ヅ: 'ﾂﾞ', デ: 'ﾃﾞ', ド: 'ﾄﾞ', バ: 'ﾊﾞ', ビ: 'ﾋﾞ', ブ: 'ﾌﾞ', ベ: 'ﾍﾞ', ボ: 'ﾎﾞ', パ: 'ﾊﾟ', ピ: 'ﾋﾟ', プ: 'ﾌﾟ', ペ: 'ﾍﾟ', ポ: 'ﾎﾟ', ヴ: 'ｳﾞ' };
// 小さいカナは大きいカナにする（全銀の形式は小さいカナを使えない）
const SMALL: Record<string, string> = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ッ: 'ツ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ', ヰ: 'イ', ヱ: 'エ' };
/** 使える半角の記号。 */
const MARKS = ' ()-./,\\';

/**
 * 名前を全銀の形式で使える字（半角のカナ・英大文字・数字・記号）に直す。
 *
 * @returns 直した文字列と、直せなかった字
 */
export function toZenginKana(text: string): { value: string; bad: string[] } {
  // 半角のカナは NFKC で全角に戻るため、先に全角にそろえてから半角にする
  const src = text.normalize('NFKC').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/　/g, ' ');
  let out = '';
  const bad: string[] = [];
  for (const raw of src) {
    const ch = SMALL[raw] ?? raw;
    if (DAKU[ch]) out += DAKU[ch];
    else if (FULL.includes(ch)) out += HALF[FULL.indexOf(ch)];
    else if (ch === 'ー' || ch === '－' || ch === '‐') out += '-';
    else if (/[0-9A-Z]/.test(ch)) out += ch;
    else if (/[a-z]/.test(ch)) out += ch.toUpperCase();
    else if (MARKS.includes(ch)) out += ch;
    else if (ch === '・') out += '.';
    else if (ch === '\u3099' || ch === '\u309a') out += ch === '\u3099' ? 'ﾞ' : 'ﾟ';
    else if (!bad.includes(ch)) bad.push(ch);
  }
  return { value: out.replace(/ +/g, ' ').trim(), bad };
}

/** 半角の字を 1 バイトのシフト JIS にする（半角のカナは 0xA1〜0xDF）。 */
function sjisByte(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0xff61 && c <= 0xff9f) return c - 0xfec0;
  if (c < 0x80) return c;
  throw new Error(`全銀の形式で使えない字です: ${ch}`);
}

/** 左に寄せて空白で埋める（長ければ切る）。 */
const text = (v: string, n: number) => (v.length > n ? v.slice(0, n) : v + ' '.repeat(n - v.length));
/** 右に寄せてゼロで埋める。 */
const num = (v: string | number, n: number) => String(v).padStart(n, '0').slice(-n);
const kind = (t: '普通' | '当座') => (t === '当座' ? '2' : '1');

/**
 * 振込データを作る。
 *
 * @param client 振込元（会社の設定）
 * @param payDate 振込指定日（YYYY-MM-DD）
 * @param payees 振込先
 * @returns ファイルの中身（シフト JIS）。作れなければ理由
 */
export function buildZenginFile(client: ZenginClient, payDate: string, payees: ZenginPayee[]): { bytes: Uint8Array; count: number; total: number } | { problems: ZenginProblem[] } {
  const problems: ZenginProblem[] = [];
  const need = (ok: boolean, where: string, t: string) => { if (!ok) problems.push({ where, text: t }); };
  need(/^\d{10}$/.test(client.clientCode), '振込元', '委託者コードは 10 桁の数字です');
  need(/^\d{4}$/.test(client.bankCode), '振込元', '銀行コードは 4 桁の数字です');
  need(/^\d{3}$/.test(client.branchCode), '振込元', '支店コードは 3 桁の数字です');
  need(/^\d{1,7}$/.test(client.accountNumber), '振込元', '口座番号は 7 桁までの数字です');
  /** 欠かせない名前（委託者名・名義）。使えない字があれば作らない。 */
  const kana = (v: string, where: string, label: string) => {
    const k = toZenginKana(v);
    if (k.bad.length) problems.push({ where, text: `${label}に使えない字があります（${k.bad.join('')}）` });
    if (!k.value) problems.push({ where, text: `${label}がありません` });
    return k.value;
  };
  /** 任意の名前（銀行名・支店名）。カナにできなければ空にする（番号で振り込まれる。漢字で入れた名前で止めない）。 */
  const optional = (v: string) => {
    const k = toZenginKana(v);
    return k.bad.length ? '' : k.value;
  };
  const clientName = kana(client.clientName, '振込元', '委託者名');
  const bankName = optional(client.bankName);
  const branchName = optional(client.branchName);
  const rows = payees.map((p) => {
    const where = p.holder || '振込先';
    need(/^\d{4}$/.test(p.bankCode), where, '銀行コードは 4 桁の数字です');
    need(/^\d{3}$/.test(p.branchCode), where, '支店コードは 3 桁の数字です');
    need(/^\d{1,7}$/.test(p.accountNumber), where, '口座番号は 7 桁までの数字です');
    need(Number.isInteger(p.amount) && p.amount > 0 && p.amount < 10_000_000_000, where, '振込の額が正しくありません');
    return {
      p, holder: kana(p.holder, where, '名義'), bank: optional(p.bankName ?? ''), branch: optional(p.branchName ?? ''),
      code: (p.customerCode ?? '').normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10),
    };
  });
  if (payees.length === 0) problems.push({ where: '振込先', text: '振り込む人がいません' });
  if (problems.length) return { problems };

  const mmdd = payDate.slice(5, 7) + payDate.slice(8, 10);
  const lines: string[] = [];
  lines.push('1' + (client.format === 'kyuyo' ? '11' : '21') + '0' + num(client.clientCode, 10) + text(clientName, 40) + mmdd
    + num(client.bankCode, 4) + text(bankName, 15) + num(client.branchCode, 3) + text(branchName, 15) + kind(client.accountType) + num(client.accountNumber, 7) + text('', 17));
  let total = 0;
  for (const r of rows) {
    total += r.p.amount;
    lines.push('2' + num(r.p.bankCode, 4) + text(r.bank, 15) + num(r.p.branchCode, 3) + text(r.branch, 15) + text('', 4) + kind(r.p.accountType) + num(r.p.accountNumber, 7)
      + text(r.holder, 30) + num(r.p.amount, 10) + '0' + text(r.code, 10) + text('', 10) + ' ' + ' ' + text('', 7));
  }
  lines.push('8' + num(rows.length, 6) + num(total, 12) + text('', 101));
  lines.push('9' + text('', 119));
  for (const l of lines) if (l.length !== 120) throw new Error(`全銀の形式の行の長さが 120 ではありません（${l.length}）`);
  const body = lines.join('\r\n') + '\r\n';
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) bytes[i] = sjisByte(body[i]!);
  return { bytes, count: rows.length, total };
}
