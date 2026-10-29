/**
 * @file 体験用の会社に入れる見本の会社のデータ（仕様書 第23.3.2節「中身」）と、それを入れる処理。
 *
 * 見本の中身はこのファイルで持つ。実在の会社や人の名前を使わず、会社名には「見本」を入れ、アドレスは `.example` のドメインにする。
 * 予定・メール・タスク・チャットは見本の接続口（ADR-0003）が出すので、ここでは入れない。
 * 入れるのは、会社情報・社内規程・名刺（会社で共有）・在庫の品目・見積と受注。各業務のいつもの口を通して入れる（表に直接は書かない）。
 */

import type { CompanyInfo, InventorySettings, SalesDocsSettings, SalesItem, TenantOnboarding } from '@m2office/shared';

/** 見本の会社名（体験用の会社の名前。画面の左上とログインの画面に出る）。 */
export const DEMO_COMPANY_NAME = '見本精工株式会社';

/** 会社情報。 */
export const DEMO_COMPANY: Partial<CompanyInfo> = {
  legalName: DEMO_COMPANY_NAME,
  shortName: '見本精工',
  postalCode: '100-0000',
  address: '東京都千代田区見本町 1-2-3 見本ビル 4 階',
  phone: '03-0000-0000',
  paymentTerms: '月末締め翌月末払い',
  website: 'https://mihon-seiko.example',
};

/** 社内規程（題名と本文）。 */
export const DEMO_RULES: readonly { title: string; body: string }[] = [
  {
    title: '就業規則（抜粋）',
    body: [
      '# 就業規則（抜粋）',
      '## 第1条 勤務時間',
      '始業は午前9時、終業は午後6時とする。休憩は正午から午後1時までの1時間とする。',
      '## 第2条 休日',
      '土曜日・日曜日・国民の祝日・年末年始（12月29日から1月3日まで）を休日とする。',
      '## 第3条 年次有給休暇',
      '入社から6か月を経過し、所定の労働日の8割以上出勤した者に10日を与える。取得する日の3日前までに上長に申し出る。',
      '## 第4条 在宅勤務',
      '上長が認めた場合、週に2日まで在宅で勤務できる。在宅勤務の日は、始業と終業を勤怠の記録に残す。',
    ].join('\n'),
  },
  {
    title: '経費精算規程',
    body: [
      '# 経費精算規程',
      '## 第1条 対象',
      '業務のために立て替えた交通費・宿泊費・会議費・消耗品費を対象とする。',
      '## 第2条 精算の期限',
      '立て替えた月の翌月10日までに、領収書を添えて申請する。',
      '## 第3条 上限',
      '会議費は1人あたり5,000円、宿泊費は1泊あたり12,000円を上限とする。上限を超えるときは、事前に部長の承認を得る。',
      '## 第4条 交通費',
      '公共の交通機関の最も経済的な経路の運賃とする。タクシーは、深夜（午後10時以降）または荷物の多いときに限る。',
    ].join('\n'),
  },
  {
    title: '情報セキュリティ規程（抜粋）',
    body: [
      '# 情報セキュリティ規程（抜粋）',
      '## 第1条 持ち出し',
      '顧客の情報を含む資料を社外へ持ち出すときは、上長の許可を得る。紙の資料は鍵のかかるかばんに入れる。',
      '## 第2条 パスワード',
      'パスワードは12文字以上とし、ほかのサービスと同じものを使わない。',
      '## 第3条 不審なメール',
      '心当たりのない添付ファイルやリンクは開かず、情報システム担当に知らせる。',
    ].join('\n'),
  },
];

/** 名刺（表の形。1 行目が見出し）。会社で共有で入れる。 */
export const DEMO_CARDS: readonly (readonly string[])[] = [
  ['氏名', '会社名', '部署', '役職', '電話番号', 'メールアドレス', '住所'],
  ['佐藤 一郎', '株式会社見本商事', '購買部', '課長', '03-0000-1111', 'sato@customer.example.jp', '東京都港区見本台 2-3-4'],
  ['田中 美咲', '株式会社見本商事', '購買部', '主任', '03-0000-1112', 'tanaka@customer.example.jp', '東京都港区見本台 2-3-4'],
  ['伊藤 健太', '見本電機株式会社', '生産管理部', '部長', '045-000-2222', 'ito@denki.example', '神奈川県横浜市見本区 5-6'],
  ['渡辺 由美', '有限会社見本物流', '営業所', '所長', '048-000-3333', 'watanabe@butsuryu.example', '埼玉県さいたま市見本区 7-8'],
  ['中村 翔', '見本テック合同会社', '代表', '代表社員', '06-0000-4444', 'nakamura@tech.example', '大阪府大阪市見本区 9-10'],
];

/** 在庫の品目（販売品と消耗品）と、はじめの数。 */
export const DEMO_ITEMS: readonly { name: string; sku: string; category: string; unit: string; price: number | null; purchasePrice: number | null; qty: number; low: number }[] = [
  { name: '精密ベアリング A-100', sku: 'BRG-A100', category: '部品', unit: '個', price: 1200, purchasePrice: 700, qty: 240, low: 50 },
  { name: '精密ベアリング A-200', sku: 'BRG-A200', category: '部品', unit: '個', price: 1800, purchasePrice: 1050, qty: 35, low: 40 },
  { name: 'ステンレスシャフト S-30', sku: 'SFT-S30', category: '部品', unit: '本', price: 3500, purchasePrice: 2100, qty: 80, low: 20 },
  { name: '耐熱グリス 500g', sku: 'GRS-500', category: '消耗品', unit: '缶', price: null, purchasePrice: 900, qty: 6, low: 5 },
  { name: '梱包用段ボール（中）', sku: 'BOX-M', category: '消耗品', unit: '枚', price: null, purchasePrice: 80, qty: 150, low: 50 },
];

/** 見積（宛先と品目）。1 つ目は受注にする。 */
export const DEMO_QUOTES: readonly { to: string; items: SalesItem[]; order: boolean }[] = [
  {
    to: '株式会社見本商事 佐藤 一郎様', order: true,
    items: [
      { name: '精密ベアリング A-100', code: 'BRG-A100', quantity: 100, unit: '個', unitPrice: 1200, taxRate: 10 },
      { name: 'ステンレスシャフト S-30', code: 'SFT-S30', quantity: 20, unit: '本', unitPrice: 3500, taxRate: 10 },
    ],
  },
  {
    to: '見本電機株式会社 伊藤 健太様', order: false,
    items: [
      { name: '精密ベアリング A-200', code: 'BRG-A200', quantity: 50, unit: '個', unitPrice: 1800, taxRate: 10 },
    ],
  },
];

/** 見本のデータを入れるのに要るもの（各業務のいつもの口）。 */
export interface DemoSeedDeps {
  /** 会社の設定の 1 区分を保存する。 */
  saveSettings(tenantId: string, section: 'company', value: CompanyInfo, by: string): Promise<void>;
  saveSettings(tenantId: string, section: 'inventory', value: InventorySettings, by: string): Promise<void>;
  saveSettings(tenantId: string, section: 'salesDocs', value: SalesDocsSettings, by: string): Promise<void>;
  saveSettings(tenantId: string, section: 'onboarding', value: TenantOnboarding, by: string): Promise<void>;
  /** いまの設定（既定と合わせたもの）。 */
  settings(tenantId: string): Promise<{ company: CompanyInfo; inventory: InventorySettings; salesDocs: SalesDocsSettings; onboarding: TenantOnboarding }>;
  /** 社内規程を登録する。 */
  saveRule(tenantId: string, userId: string, rule: { title: string; body: string }): Promise<void>;
  /** 名刺を表から取り込む（会社で共有）。 */
  importCards(tenantId: string, userId: string, rows: string[][]): Promise<void>;
  /** 在庫の品目を作る。 */
  createItem(tenantId: string, userId: string, item: (typeof DEMO_ITEMS)[number]): Promise<void>;
  /** 見積を作る。受注にするなら、見積から受注を作る。 */
  createQuote(tenantId: string, userId: string, quote: (typeof DEMO_QUOTES)[number]): Promise<void>;
}

/**
 * 見本の会社のデータを入れる。
 *
 * @remarks 1 つの業務で失敗しても、ほかの業務は入れる（体験を始められないよりよい）。失敗した業務の名前を返す
 */
export async function seedDemoCompany(deps: DemoSeedDeps, tenantId: string, userId: string): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch { failed.push(name); }
  };
  const now = new Date().toISOString();
  const s = await deps.settings(tenantId);
  await step('company', () => deps.saveSettings(tenantId, 'company', { ...s.company, ...DEMO_COMPANY }, userId));
  // はじめの案内（業務の見直し・従業員への案内）は済んだことにする。招待はできないため
  await step('onboarding', () => deps.saveSettings(tenantId, 'onboarding', { ...s.onboarding, agentsReviewedAt: now, employeesNotifiedAt: now }, userId));
  await step('inventory', () => deps.saveSettings(tenantId, 'inventory', { ...s.inventory, enabled: true }, userId));
  await step('salesDocs', () => deps.saveSettings(tenantId, 'salesDocs', { ...s.salesDocs, enabled: true }, userId));
  for (const r of DEMO_RULES) await step('rules', () => deps.saveRule(tenantId, userId, r));
  await step('cards', () => deps.importCards(tenantId, userId, DEMO_CARDS.map((r) => [...r])));
  for (const i of DEMO_ITEMS) await step('inventory-items', () => deps.createItem(tenantId, userId, i));
  for (const q of DEMO_QUOTES) await step('quotes', () => deps.createQuote(tenantId, userId, q));
  return { failed: [...new Set(failed)] };
}
