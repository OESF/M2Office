/**
 * @file 人事・給与を試すための見本の従業員（既定 20 人）を、開発の API を通して入れる（開発用。本番では使わない）。
 *
 * 画面から入れるのと同じ API（`/v1/hr/...`）を呼ぶので、入力の確かめ・手続きの作成・監査ログもそのまま通る。
 * 入れるもの: 台帳と雇用条件（役員・正社員・契約・パート・アルバイト）、給与の情報（税の区分・扶養の数・住民税・通勤・口座）、
 * 標準報酬月額、家族、今月の勤怠（出勤日の打刻。残業の多い人も混ぜる）。
 * 名前・住所・口座はすべて架空。メールアドレスは `*.example` を使う。同じ社員番号がすでにあれば、その人は飛ばす（何度流してもよい）。
 *
 * 使い方（開発サーバーが動いていること。開発用の見出しで本人になりすますため、本番の API には効かない）:
 *   node scripts/seed-hr-sample.mjs --tenant oesf --user <その会社の管理者のメールアドレス> [--count 20] [--no-attendance]
 */

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const API = process.env.API_URL ?? 'http://localhost:3101';
const TENANT = opt('tenant', '');
const USER = opt('user', '');
const COUNT = Math.min(Number(opt('count', '20')) || 20, 40);
const ATTENDANCE = !args.includes('--no-attendance');
if (!TENANT || !USER) {
  console.error('使い方: node scripts/seed-hr-sample.mjs --tenant <サブドメイン> --user <管理者のメールアドレス> [--count 20] [--no-attendance]');
  process.exit(2);
}

/** 開発の API を呼ぶ（開発用の見出しで本人として呼ぶ）。 */
async function call(path, init = {}) {
  const res = await fetch(`${API}/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-tenant': TENANT, 'x-user': USER, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path, body) => call(path, { method: 'PUT', body: JSON.stringify(body) });

// ---- 見本の人（架空） ----

const SURNAMES = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '清水', '森', '池田', '橋本', '阿部', '石川', '前田', '藤田', '岡田', '後藤', '長谷川', '村上', '近藤', '石井', '坂本', '遠藤', '青木', '藤井', '西村', '福田', '太田', '三浦'];
const SURNAME_KANA = ['さとう', 'すずき', 'たかはし', 'たなか', 'いとう', 'わたなべ', 'やまもと', 'なかむら', 'こばやし', 'かとう', 'よしだ', 'やまだ', 'ささき', 'やまぐち', 'まつもと', 'いのうえ', 'きむら', 'はやし', 'しみず', 'もり', 'いけだ', 'はしもと', 'あべ', 'いしかわ', 'まえだ', 'ふじた', 'おかだ', 'ごとう', 'はせがわ', 'むらかみ', 'こんどう', 'いしい', 'さかもと', 'えんどう', 'あおき', 'ふじい', 'にしむら', 'ふくだ', 'おおた', 'みうら'];
const GIVEN = [
  ['健一', 'けんいち', 'male'], ['美咲', 'みさき', 'female'], ['大輔', 'だいすけ', 'male'], ['陽子', 'ようこ', 'female'], ['翔太', 'しょうた', 'male'],
  ['由美', 'ゆみ', 'female'], ['誠', 'まこと', 'male'], ['真理子', 'まりこ', 'female'], ['拓也', 'たくや', 'male'], ['恵', 'めぐみ', 'female'],
  ['浩二', 'こうじ', 'male'], ['彩', 'あや', 'female'], ['直樹', 'なおき', 'male'], ['香織', 'かおり', 'female'], ['亮', 'りょう', 'male'],
  ['結衣', 'ゆい', 'female'], ['隆', 'たかし', 'male'], ['麻衣', 'まい', 'female'], ['蓮', 'れん', 'male'], ['葵', 'あおい', 'female'],
];
const DEPTS = ['営業部', '開発部', '総務部', '製造部'];
const CITIES = [['東京都千代田区', '千代田区'], ['東京都江東区', '江東区'], ['神奈川県川崎市中原区', '川崎市'], ['埼玉県さいたま市浦和区', 'さいたま市'], ['千葉県船橋市', '船橋市']];

/**
 * i 番目の人の形（役員 1・正社員 12・契約 2・パート 4・アルバイト 1 を 20 人の基本に、増やせば正社員を足す）。
 */
function planOf(i) {
  if (i === 0) return { employment: 'officer', category: 'officer', title: '取締役', wageType: 'monthly', wage: 600_000, weeklyHours: 40, weeklyDays: 5, social: true, empIns: false, dependents: 2 };
  if (i <= 12 || i >= 20) {
    const base = [380_000, 340_000, 300_000, 280_000, 260_000, 250_000, 240_000, 230_000, 225_000, 220_000, 215_000, 210_000][(i - 1) % 12];
    const title = i === 1 ? '部長' : i === 2 || i === 3 ? '課長' : i === 4 || i === 5 ? '主任' : '';
    return { employment: 'regular', category: 'employee', title, wageType: 'monthly', wage: base, weeklyHours: 40, weeklyDays: 5, social: true, empIns: true, dependents: [3, 2, 1, 0, 1, 0, 2, 0, 0, 1, 0, 0][(i - 1) % 12], overtime: i === 6 };
  }
  if (i <= 14) return { employment: 'contract', category: 'employee', title: '', wageType: 'monthly', wage: 250_000, weeklyHours: 40, weeklyDays: 5, social: true, empIns: true, dependents: 0, contract: true };
  if (i <= 18) {
    const k = i - 15;
    return { employment: 'part', category: 'employee', title: '', wageType: 'hourly', wage: [1_150, 1_200, 1_250, 1_300][k], weeklyHours: [30, 24, 20, 32][k], weeklyDays: [5, 4, 4, 4][k], social: k === 0 || k === 3, empIns: true, dependents: 0, otsu: k === 2 };
  }
  return { employment: 'arbeit', category: 'employee', title: '', wageType: 'hourly', wage: 1_150, weeklyHours: 12, weeklyDays: 3, social: false, empIns: false, dependents: 0, student: true };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const todayJst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 見本の 1 人分の入力。 */
function personOf(i) {
  const p = planOf(i);
  const [given, givenKana, gender] = GIVEN[i % GIVEN.length];
  const surname = SURNAMES[i % SURNAMES.length];
  const [address, city] = CITIES[i % CITIES.length];
  const age = p.employment === 'arbeit' ? 20 : p.employment === 'officer' ? 55 : 24 + ((i * 7) % 33);
  const birthYear = 2026 - age;
  const hiredYear = p.employment === 'officer' ? 2010 : Math.max(birthYear + 22, 2026 - ((i * 3) % 15));
  // 1 人は今月の入社にする（入社の手続きを試せるように）
  const planned = `${Math.min(hiredYear, 2026)}-${pad(1 + (i % 12))}-01`;
  const hiredOn = i === 11 ? '2026-10-01' : planned > todayJst() ? '2026-04-01' : planned;
  const code = `S${pad(i + 1, 3)}`;
  const allowances = [
    ...(p.title === '部長' ? [{ name: '役職手当', amount: 50_000 }] : p.title === '課長' ? [{ name: '役職手当', amount: 30_000 }] : p.title === '主任' ? [{ name: '役職手当', amount: 10_000 }] : []),
    ...(p.employment === 'regular' && p.dependents > 0 ? [{ name: '家族手当', amount: 10_000 * p.dependents }] : []),
  ];
  const commute = p.employment === 'officer' ? 0 : [8_400, 12_600, 15_200, 6_800, 21_000][i % 5];
  const monthlyPay = p.wageType === 'monthly' ? p.wage : Math.round(p.wage * p.weeklyHours * 4.3);
  const employee = {
    code, name: `${surname} ${given}`, kana: `${SURNAME_KANA[i % SURNAME_KANA.length]} ${givenKana}`,
    birthDate: `${birthYear}-${pad(1 + ((i * 5) % 12))}-${pad(1 + ((i * 11) % 28))}`, gender,
    address: `${address}見本町 ${i + 1}-${(i % 9) + 1}`, phone: `090-0000-${pad(i + 1, 4)}`, email: `staff${pad(i + 1, 3)}@sample.example`,
    hiredOn, employment: p.employment, category: p.category, department: p.employment === 'officer' ? '' : DEPTS[i % DEPTS.length], title: p.title,
    note: '見本のデータ（人事・給与の試験用）',
    terms: {
      effectiveOn: hiredOn,
      contractStart: p.contract ? '2026-04-01' : null, contractEnd: p.contract ? '2027-03-31' : null,
      renewal: p.contract ? '更新する場合がある' : '', renewalLimit: p.contract ? '通算 5 年まで' : '',
      weeklyHours: p.weeklyHours, weeklyDays: p.weeklyDays,
      startTime: p.employment === 'part' ? '10:00' : p.employment === 'arbeit' ? '17:00' : '09:00',
      endTime: p.employment === 'part' ? (p.weeklyHours / p.weeklyDays >= 6 ? '17:00' : '16:00') : p.employment === 'arbeit' ? '21:00' : '18:00',
      breakMinutes: p.employment === 'arbeit' ? 0 : 60,
      wageType: p.wageType, wageAmount: p.wage, allowances,
      workplace: '本社', work: p.employment === 'officer' ? '経営' : `${DEPTS[i % DEPTS.length].replace('部', '')}の業務`,
      socialInsurance: p.social, employmentInsurance: p.empIns, schedule: 'fixed',
    },
  };
  const profile = {
    taxColumn: p.otsu ? 'otsu' : 'ko', dependents: p.dependents,
    residentTax: p.employment === 'arbeit' ? [] : [{ fiscalYear: 2026, municipality: city, june: 10_000 + i * 700, monthly: 9_000 + i * 600 }],
    commute: commute ? { means: '電車', monthly: commute, taxFree: commute } : {},
    bank: { bank: '見本銀行', bankCode: '9900', branch: '本店', branchCode: '001', type: '普通', number: `1${pad(i + 1, 6)}`, holder: '' },
    insurance: { student: !!p.student, overtimeEstimate: p.overtime ? 40_000 : 0 },
  };
  const family = [];
  if (p.dependents >= 1) family.push({ name: `${surname} 花子`, relation: '配偶者', birthDate: `${birthYear + 2}-04-10`, cohabiting: true, incomeEstimate: 0, dependent: true });
  for (let k = 1; k < p.dependents; k++) family.push({ name: `${surname} ${['一郎', '次郎', '三郎'][k - 1]}`, relation: '子', birthDate: `${Math.min(2024, birthYear + 28 + k * 2)}-0${k + 1}-15`, cohabiting: true, incomeEstimate: 0, dependent: true });
  return { plan: p, employee, profile, family, standardPay: p.social ? monthlyPay + allowances.reduce((s, a) => s + a.amount, 0) + commute : 0 };
}

/** 今月の勤怠（1 日から昨日まで）。役員は入れない。残業の多い人は 21 時まで。 */
async function fillAttendance(id, p, i) {
  const today = todayJst();
  const [y, m] = today.split('-').map(Number);
  let filled = 0;
  for (let d = 1; ; d++) {
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if (date >= today) break;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    // パートとアルバイトは決まった曜日だけ出る
    if (p.weeklyDays < 5 && !((dow + i) % 5 < p.weeklyDays)) continue;
    let body;
    if (p.employment === 'part') body = { in: '10:00', out: p.weeklyHours / p.weeklyDays >= 6 ? '17:00' : '16:00', breaks: [{ start: '12:00', end: '13:00' }] };
    else if (p.employment === 'arbeit') body = { in: '17:00', out: '21:00', breaks: [] };
    else {
      const late = p.overtime ? '21:00' : (d + i) % 7 === 0 ? '20:00' : (d + i) % 3 === 0 ? '19:00' : '18:00';
      body = { in: (d + i) % 11 === 0 ? '09:10' : '08:55', out: late, breaks: [{ start: '12:00', end: '13:00' }] };
    }
    const r = await put(`/hr/attendance/${id}/days/${date}`, body);
    if (r.status === 200) filled++;
    else if (filled === 0) { console.log(`    勤怠を入れられませんでした（${date}）: ${JSON.stringify(r.body).slice(0, 120)}`); return 0; }
  }
  return filled;
}

const list = await call('/hr/employees');
if (list.status !== 200) {
  console.error(`人事の画面を読めませんでした（${list.status}）: ${JSON.stringify(list.body).slice(0, 200)}`);
  process.exit(1);
}
const existing = new Set((list.body.employees ?? []).map((e) => e.code));
console.log(`${TENANT} に見本の従業員を入れます（${COUNT} 人。すでにいる社員番号は飛ばします）`);
let created = 0;
for (let i = 0; i < COUNT; i++) {
  const s = personOf(i);
  if (existing.has(s.employee.code)) { console.log(`  ${s.employee.code} はすでにいます。飛ばします`); continue; }
  const r = await post('/hr/employees', s.employee);
  if (r.status !== 201) { console.log(`  ✗ ${s.employee.code} ${s.employee.name}: ${JSON.stringify(r.body).slice(0, 200)}`); continue; }
  const id = r.body.employee.id;
  const notes = [];
  const pr = await put(`/hr/payroll/employees/${id}/profile`, s.profile);
  if (pr.status !== 200) notes.push(`給与の情報: ${JSON.stringify(pr.body).slice(0, 100)}`);
  if (s.standardPay) {
    const sp = await post(`/hr/payroll/employees/${id}/standard-pay`, { fromMonth: '2026-09', pay: s.standardPay });
    if (sp.status !== 201) notes.push(`標準報酬: ${JSON.stringify(sp.body).slice(0, 100)}`);
  }
  for (const f of s.family) {
    const fr = await post(`/hr/payroll/employees/${id}/family`, f);
    if (fr.status !== 201) notes.push(`家族: ${JSON.stringify(fr.body).slice(0, 100)}`);
  }
  const days = ATTENDANCE && s.plan.employment !== 'officer' && s.employee.hiredOn < todayJst() ? await fillAttendance(id, s.plan, i) : 0;
  created++;
  console.log(`  ✓ ${s.employee.code} ${s.employee.name}（${{ officer: '役員', regular: '正社員', contract: '契約', part: 'パート', arbeit: 'アルバイト' }[s.plan.employment]}）勤怠 ${days} 日${notes.length ? `／うまくいかなかったもの: ${notes.join('・')}` : ''}`);
}
console.log(`入れた人: ${created} 人`);
