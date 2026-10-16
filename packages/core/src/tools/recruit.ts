/**
 * @file 採用支援（AG-16）のツール（仕様書 第9.6.6節、ADR-0103）。
 *
 * 求人原稿・応募書類の要約・面接の質問の案を、決まった言葉の点検で確かめる（推論の行儀に頼らない）。
 * 求人原稿は、性別・年齢を限る書き方と、職業安定法の労働条件の明示事項の抜けを見る。
 * 要約と質問は、公正な採用選考の考え方で使ってはならない事柄（本人に責任の無いこと・思想信条など）が入っていないかを見る。
 * 当たるかどうかの判断は会社（専門家）が行う。ここでは「確かめたい点」として示す。
 */

import type { Tool } from './registry.js';

/** 性別を限る・決めつける書き方（男女雇用機会均等法。職種名の「〜マン」など）。 */
const GENDER = /(男性|女性|男子|女子)(のみ|限定|歓迎|募集|向け|活躍中)|ウェイトレス|ウェイター|看護婦|保母|営業マン|セールスマン|ビジネスマン|OL/g;
/** 年齢を限る書き方（労働施策総合推進法。例外に当たるなら理由の明示が要る）。 */
const AGE = /\d{2}\s*歳(以下|まで|未満|位まで|くらいまで|前後)|若手|若い方|若年|フレッシュな方|中高年不可/g;
/** 公正な採用選考で使ってはならない事柄（本人に責任の無いこと・思想信条にかかわること）。 */
const PROTECTED = /本籍|出生地|出身地|家族|両親|父親|母親|兄弟|姉妹|配偶者|結婚|婚姻|既婚|未婚|独身|子ども|子供|妊娠|出産予定|宗教|信仰|支持政党|政党|思想|信条|尊敬する人物|愛読書|購読新聞|労働組合|学生運動|健康状態|病歴|持病|障害|国籍|生年月日|\d{2}\s*歳|年齢|性別|男性|女性|容姿|身長|体重|血液型/g;

/** 求人の労働条件の明示事項（職業安定法施行規則。2024 年 4 月の改正の「変更の範囲」「更新の上限」を含む）。 */
const POSTING_ITEMS: { item: string; re: RegExp }[] = [
  { item: '業務の内容', re: /仕事内容|業務内容|職務内容|業務の内容/ },
  { item: '業務の内容の変更の範囲', re: /変更の範囲/ },
  { item: '契約期間（有期なら更新の有無と上限）', re: /契約期間|期間の定め|無期|有期|正社員/ },
  { item: '試用期間', re: /試用期間/ },
  { item: '就業の場所', re: /勤務地|就業場所|勤務場所|就業の場所/ },
  { item: '始業・終業の時刻', re: /就業時間|勤務時間|始業|終業|\d{1,2}:\d{2}\s*[〜~-]/ },
  { item: '休憩', re: /休憩/ },
  { item: '休日', re: /休日|週休/ },
  { item: '時間外労働', re: /時間外|残業/ },
  { item: '賃金', re: /給与|賃金|月給|時給|年収|日給|年俸/ },
  { item: '加入する保険', re: /社会保険|雇用保険|健康保険|厚生年金|労災/ },
  { item: '受動喫煙を防ぐ措置', re: /喫煙|禁煙/ },
];

/** 見つかった言葉（重ねない）。 */
const hits = (text: string, re: RegExp) => [...new Set([...text.normalize('NFKC').matchAll(re)].map((m) => m[0]))];

/**
 * 採用の文を点検する。
 *
 * @returns 確かめたい点（言葉と理由）と、求人原稿なら抜けている明示事項
 */
export function checkRecruitText(kind: 'posting' | 'summary' | 'questions', text: string, companyName = ''): { problems: { word: string; why: string }[]; missing: string[] } {
  const problems: { word: string; why: string }[] = [];
  if (kind === 'posting') {
    for (const w of hits(text, GENDER)) problems.push({ word: w, why: '性別を限る・決めつける書き方です（男女雇用機会均等法）。性別を問わない書き方にしてください' });
    for (const w of hits(text, AGE)) problems.push({ word: w, why: '年齢を限る書き方です（労働施策総合推進法）。例外に当たるなら、その理由を書く必要があります' });
  } else {
    for (const w of hits(text, PROTECTED)) {
      problems.push({ word: w, why: kind === 'summary'
        ? '公正な採用選考では、本人に責任の無いことや思想信条にかかわることを、評価や比較に使いません。要約から外してください'
        : '公正な採用選考では、本人に責任の無いことや思想信条にかかわることを、面接で尋ねません。質問から外してください' });
    }
  }
  const missing = kind === 'posting'
    ? [...POSTING_ITEMS.filter((x) => !x.re.test(text)).map((x) => x.item), ...(companyName && !text.includes(companyName) ? ['募集する会社の名前'] : [])]
    : [];
  return { problems, missing };
}

/**
 * 採用の文の点検（ツール）。
 *
 * @remarks 危険度 `read`（読むだけ・何も書かない）
 */
export const recruitCheckText: Tool = {
  name: 'recruit.check_text',
  risk: 'read',
  activityLabel: '採用の文を点検しています',
  helpText: '求人原稿・応募書類の要約・面接の質問に、使ってはならない言葉や抜けている明示事項がないかを確かめます',
  description: '採用の文を点検する。kind は posting（求人原稿）・summary（応募書類の要約と比較）・questions（面接の質問）。problems と missing が空になるまで直してから保存する',
  args: {
    properties: {
      kind: { type: 'string', description: 'posting・summary・questions のどれか' },
      text: { type: 'string', description: '点検する文' },
    },
    required: ['kind', 'text'],
  },
  async invoke(args, ctx) {
    const kind = args['kind'] === 'summary' || args['kind'] === 'questions' ? args['kind'] : 'posting';
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    if (!text.trim()) return { checked: false, reason: '点検する文がありません' };
    const company = (await ctx.repo.getTenantSettings(ctx.tenantId)).company.legalName;
    const r = checkRecruitText(kind, text, company);
    return { checked: true, kind, ok: r.problems.length === 0 && r.missing.length === 0, ...r };
  },
};

export const RECRUIT_TOOLS: Tool[] = [recruitCheckText];
