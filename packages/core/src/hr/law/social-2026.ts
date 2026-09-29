/**
 * @file 法令の表: 社会保険（協会けんぽ 令和8年度・厚生年金・子ども・子育て支援金・標準報酬月額の等級表。仕様書 第30.10.2節）。
 *
 * AI が公式の発表（協会けんぽの保険料額表の Excel 47 都道府県分・日本年金機構・こども家庭庁）から 2026-09-30 に取り込んだ。
 * 協会けんぽの Excel の全額と折半額 8,554 セルが「標準報酬月額 × 料率」と一致することを確かめてある。
 * **監修前**（税理士の監修が済んだら review を verified にする。第30.27節）。
 *
 * 取り込みのときの注記:
 * - 健康保険料率47都道府県は、協会けんぽ『令和8年度都道府県単位保険料率』ページの本文と、公式Excel（r8ippan3.xlsx、47シート）の料率セルの両方で一致を確認した。
 * - Excel全47シートで、等級表（50等級・報酬月額の範囲・厚生年金の対応等級）が同一であること、全額・折半額（健康保険・介護込み・子ども子育て支援金・厚生年金）が 標準報酬×料率 と一致すること（8,554セル）を確認した。
 * - 介護保険料率1.62%は、Excelの『介護保険第2号被保険者に該当する場合』の率（例：東京 11.47%）から健康保険料率を引いた値が全47シートで1.62%になることでも確認した。
 * - 子ども・子育て支援金率0.23%は令和8年4月分（5月納付分）から。健康保険料率・介護保険料率は令和8年3月分（4月納付分）から。任意継続・日雇特例は4月分から変更（本データは一般の被保険者のみ）。
 * - 子ども・子育て支援金の標準賞与額上限は、健康保険・介護保険と同じ年間573万円（協会けんぽ保険料額表の注記）。子ども・子育て拠出金（事業主のみ負担）は0.36%、上限は厚生年金と同じ月間150万円（同注記）。拠出金率は本JSONの対象外。
 * - 厚生年金の標準報酬月額は1等級88,000円〜32等級650,000円の32等級（日本年金機構ページで確認）。2026年9月30日時点で公式の等級表の変更は確認されなかった（上限引き上げの将来予定は本調査の範囲では公式資料を確認していない）。
 * - 厚生年金基金加入員は免除保険料率（2.4%〜5.0%）を控除した率となる（本JSONは一般の率のみ）。
 * - 協会けんぽの任意継続被保険者の標準報酬月額の上限は令和8年度320,000円（保険料額表の注記。本JSONの等級表には反映していない）。
 * - 照合（東京都・公式PDF R8_13tokyo.pdf）: 東京都 等級20(17) 標準報酬 260,000: 全額 25,610.0 折半 12,805.00（公式表 全額 25610.0 折半 12805.0）— 一致
 * - 照合（東京都・公式PDF）: 東京都 等級19(16) 健康保険 標準報酬 240,000: 全額 23,640.0 折半 11,820.00（公式表 全額 23640.0 折半 11820.0）— 一致
 * - 照合（東京都・公式PDF）: 東京都 等級30(27) 介護込み11.47% 標準報酬 500,000: 全額 57,350.0 折半 28,675.00（公式表 全額 57350.0 折半 28675.0）— 一致
 * - 照合（東京都・公式PDF）: 東京都 等級20(17) 厚生年金18.3% 標準報酬 260,000: 全額 47,580.0 折半 23,790.00（公式表 全額 47580.0 折半 23790.0）— 一致
 * - 照合（東京都・公式PDF）: 東京都 等級20 子ども・子育て支援金0.23% 標準報酬 260,000: 全額 598.0 折半 299.00（公式表 全額 598.0 折半 299.0）— 一致
 * - 照合（北海道・公式Excel）: 北海道 等級1 健康保険10.28% 標準報酬 58,000: 全額 5,962.4 折半 2,981.20（公式表 全額 5962.4 折半 2981.2）— 一致
 */

import type { GradeTable, HealthRates, RateTable } from './types.js';

/** 協会けんぽの健康保険料率（%。令和8年3月分から）。 */
export const HEALTH_R8: HealthRates = {
  version: '協会けんぽ 健康保険料率 令和8年度',
  effectiveFrom: "2026-03",
  source: "https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08/index.html",
  checkedOn: "2026-09-30",
  review: { status: 'unverified' },
  prefectures: {
    "北海道": 10.28,
    "青森県": 9.85,
    "岩手県": 9.51,
    "宮城県": 10.1,
    "秋田県": 10.01,
    "山形県": 9.75,
    "福島県": 9.5,
    "茨城県": 9.52,
    "栃木県": 9.82,
    "群馬県": 9.68,
    "埼玉県": 9.67,
    "千葉県": 9.73,
    "東京都": 9.85,
    "神奈川県": 9.92,
    "新潟県": 9.21,
    "富山県": 9.59,
    "石川県": 9.7,
    "福井県": 9.71,
    "山梨県": 9.55,
    "長野県": 9.63,
    "岐阜県": 9.8,
    "静岡県": 9.61,
    "愛知県": 9.93,
    "三重県": 9.77,
    "滋賀県": 9.88,
    "京都府": 9.89,
    "大阪府": 10.13,
    "兵庫県": 10.12,
    "奈良県": 9.91,
    "和歌山県": 10.06,
    "鳥取県": 9.86,
    "島根県": 9.94,
    "岡山県": 10.05,
    "広島県": 9.78,
    "山口県": 10.15,
    "徳島県": 10.24,
    "香川県": 10.02,
    "愛媛県": 9.98,
    "高知県": 10.05,
    "福岡県": 10.11,
    "佐賀県": 10.55,
    "長崎県": 10.06,
    "熊本県": 10.08,
    "大分県": 10.08,
    "宮崎県": 9.77,
    "鹿児島県": 10.13,
    "沖縄県": 9.44,
  },
};

/** 介護保険料率（%。協会けんぽ 令和8年3月分から）。 */
export const CARE_R8: RateTable = {
  version: '協会けんぽ 介護保険料率 令和8年度', effectiveFrom: "2026-03", rate: 1.62,
  source: "https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08/index.html", checkedOn: '2026-09-30', review: { status: 'unverified' },
};

/** 子ども・子育て支援金率（%。令和8年4月分の保険料から）。 */
export const CHILD_SUPPORT_R8: RateTable = {
  version: '子ども・子育て支援金率 令和8年度', effectiveFrom: "2026-04", rate: 0.23,
  source: "https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08/index.html", checkedOn: '2026-09-30', review: { status: 'unverified' },
};

/** 厚生年金保険料率（%。平成29年9月分から固定）。 */
export const PENSION: RateTable = {
  version: '厚生年金保険料率（平成29年9月分から）', effectiveFrom: "2017-09", rate: 18.3,
  source: "https://www.nenkin.go.jp/service/kounen/hokenryo/hoshu/20150515-01.html", checkedOn: '2026-09-30', review: { status: 'unverified' },
};

/** 標準報酬月額の等級表（健康保険 1〜50 等級・厚生年金 1〜32 等級。min 以上 max 未満）。 */
export const GRADES_R8: GradeTable = {
  version: '標準報酬月額の等級表 令和8年3月分から',
  effectiveFrom: "2026-03",
  source: "https://www.kyoukaikenpo.or.jp/assets/r8ippan3.xlsx",
  checkedOn: '2026-09-30',
  review: { status: 'unverified' },
  health: [
      { grade: 1, amount: 58000, min: 0, max: 63000 },
      { grade: 2, amount: 68000, min: 63000, max: 73000 },
      { grade: 3, amount: 78000, min: 73000, max: 83000 },
      { grade: 4, amount: 88000, min: 83000, max: 93000 },
      { grade: 5, amount: 98000, min: 93000, max: 101000 },
      { grade: 6, amount: 104000, min: 101000, max: 107000 },
      { grade: 7, amount: 110000, min: 107000, max: 114000 },
      { grade: 8, amount: 118000, min: 114000, max: 122000 },
      { grade: 9, amount: 126000, min: 122000, max: 130000 },
      { grade: 10, amount: 134000, min: 130000, max: 138000 },
      { grade: 11, amount: 142000, min: 138000, max: 146000 },
      { grade: 12, amount: 150000, min: 146000, max: 155000 },
      { grade: 13, amount: 160000, min: 155000, max: 165000 },
      { grade: 14, amount: 170000, min: 165000, max: 175000 },
      { grade: 15, amount: 180000, min: 175000, max: 185000 },
      { grade: 16, amount: 190000, min: 185000, max: 195000 },
      { grade: 17, amount: 200000, min: 195000, max: 210000 },
      { grade: 18, amount: 220000, min: 210000, max: 230000 },
      { grade: 19, amount: 240000, min: 230000, max: 250000 },
      { grade: 20, amount: 260000, min: 250000, max: 270000 },
      { grade: 21, amount: 280000, min: 270000, max: 290000 },
      { grade: 22, amount: 300000, min: 290000, max: 310000 },
      { grade: 23, amount: 320000, min: 310000, max: 330000 },
      { grade: 24, amount: 340000, min: 330000, max: 350000 },
      { grade: 25, amount: 360000, min: 350000, max: 370000 },
      { grade: 26, amount: 380000, min: 370000, max: 395000 },
      { grade: 27, amount: 410000, min: 395000, max: 425000 },
      { grade: 28, amount: 440000, min: 425000, max: 455000 },
      { grade: 29, amount: 470000, min: 455000, max: 485000 },
      { grade: 30, amount: 500000, min: 485000, max: 515000 },
      { grade: 31, amount: 530000, min: 515000, max: 545000 },
      { grade: 32, amount: 560000, min: 545000, max: 575000 },
      { grade: 33, amount: 590000, min: 575000, max: 605000 },
      { grade: 34, amount: 620000, min: 605000, max: 635000 },
      { grade: 35, amount: 650000, min: 635000, max: 665000 },
      { grade: 36, amount: 680000, min: 665000, max: 695000 },
      { grade: 37, amount: 710000, min: 695000, max: 730000 },
      { grade: 38, amount: 750000, min: 730000, max: 770000 },
      { grade: 39, amount: 790000, min: 770000, max: 810000 },
      { grade: 40, amount: 830000, min: 810000, max: 855000 },
      { grade: 41, amount: 880000, min: 855000, max: 905000 },
      { grade: 42, amount: 930000, min: 905000, max: 955000 },
      { grade: 43, amount: 980000, min: 955000, max: 1005000 },
      { grade: 44, amount: 1030000, min: 1005000, max: 1055000 },
      { grade: 45, amount: 1090000, min: 1055000, max: 1115000 },
      { grade: 46, amount: 1150000, min: 1115000, max: 1175000 },
      { grade: 47, amount: 1210000, min: 1175000, max: 1235000 },
      { grade: 48, amount: 1270000, min: 1235000, max: 1295000 },
      { grade: 49, amount: 1330000, min: 1295000, max: 1355000 },
      { grade: 50, amount: 1390000, min: 1355000, max: null },
  ],
  pension: [
      { grade: 1, amount: 88000, min: 0, max: 93000 },
      { grade: 2, amount: 98000, min: 93000, max: 101000 },
      { grade: 3, amount: 104000, min: 101000, max: 107000 },
      { grade: 4, amount: 110000, min: 107000, max: 114000 },
      { grade: 5, amount: 118000, min: 114000, max: 122000 },
      { grade: 6, amount: 126000, min: 122000, max: 130000 },
      { grade: 7, amount: 134000, min: 130000, max: 138000 },
      { grade: 8, amount: 142000, min: 138000, max: 146000 },
      { grade: 9, amount: 150000, min: 146000, max: 155000 },
      { grade: 10, amount: 160000, min: 155000, max: 165000 },
      { grade: 11, amount: 170000, min: 165000, max: 175000 },
      { grade: 12, amount: 180000, min: 175000, max: 185000 },
      { grade: 13, amount: 190000, min: 185000, max: 195000 },
      { grade: 14, amount: 200000, min: 195000, max: 210000 },
      { grade: 15, amount: 220000, min: 210000, max: 230000 },
      { grade: 16, amount: 240000, min: 230000, max: 250000 },
      { grade: 17, amount: 260000, min: 250000, max: 270000 },
      { grade: 18, amount: 280000, min: 270000, max: 290000 },
      { grade: 19, amount: 300000, min: 290000, max: 310000 },
      { grade: 20, amount: 320000, min: 310000, max: 330000 },
      { grade: 21, amount: 340000, min: 330000, max: 350000 },
      { grade: 22, amount: 360000, min: 350000, max: 370000 },
      { grade: 23, amount: 380000, min: 370000, max: 395000 },
      { grade: 24, amount: 410000, min: 395000, max: 425000 },
      { grade: 25, amount: 440000, min: 425000, max: 455000 },
      { grade: 26, amount: 470000, min: 455000, max: 485000 },
      { grade: 27, amount: 500000, min: 485000, max: 515000 },
      { grade: 28, amount: 530000, min: 515000, max: 545000 },
      { grade: 29, amount: 560000, min: 545000, max: 575000 },
      { grade: 30, amount: 590000, min: 575000, max: 605000 },
      { grade: 31, amount: 620000, min: 605000, max: 635000 },
      { grade: 32, amount: 650000, min: 635000, max: null },
  ],
};

/** 賞与の上限（段 4 以降の賞与で使う）。 */
export const BONUS_CAPS = { healthYearly: 5730000, pensionPerPayment: 1500000, source: "https://www.nenkin.go.jp/section/faq/kounen/hokenryo/shoyokeisan.html" };
