/**
 * @file プロダクト概要のスライド（PowerPoint）を生成する。
 *
 * 使い方は `tools/deck/README.md` を参照。
 */

import pptxgen from 'pptxgenjs';

/** 配色。深い緑青を主役に、数字だけ暖色で引き立てる。 */
const C = {
  dark:   '0A3D3B',   // 暗い面（表紙・区切り・結び）
  teal:   '0F766E',   // 主色
  tealLt: 'E8F1F0',   // 淡い面（カード）
  amber:  'C2410C',   // 数字の強調
  ink:    '1A1A1A',
  muted:  '64748B',
  white:  'FFFFFF',
  line:   'D6E2E0',
};
const F = 'Yu Gothic';
const W = 13.33, H = 7.5, M = 0.7;

const p = new pptxgen();
p.layout = 'LAYOUT_WIDE';
p.author = '株式会社M2ホールディングス';
p.title = 'M2Office プロダクト概要';

/** 暗い面のスライド。 */
function darkSlide() {
  const s = p.addSlide();
  s.background = { color: C.dark };
  return s;
}
/** 明るい面のスライド。見出しつき。 */
function lightSlide(title, lead) {
  const s = p.addSlide();
  s.background = { color: C.white };
  s.addText(title, {
    x: M, y: 0.5, w: W - M * 2, h: 0.7, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 30, bold: true, color: C.ink, align: 'left',
  });
  if (lead) {
    s.addText(lead, {
      x: M, y: 1.18, w: W - M * 2, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.muted, align: 'left',
    });
  }
  return s;
}
/** 番号入りの丸。全編で繰り返す目印。 */
function numberCircle(s, n, x, y, d = 0.52, fill = C.teal) {
  s.addShape(p.ShapeType.ellipse, {
    x, y, w: d, h: d, fill: { color: fill },
  });
  s.addText(String(n), {
    x, y, w: d, h: d, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.white,
    align: 'center', valign: 'middle',
  });
}
/** 薄い面のカード。 */
function card(s, x, y, w, h, fill = C.tealLt) {
  s.addShape(p.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08, fill: { color: fill }, line: { color: fill },
  });
}

/* 1. 表紙 */
{
  const s = darkSlide();
  s.addText('M2Office', {
    x: M, y: 2.5, w: 9, h: 1.1, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 60, bold: true, color: C.white,
  });
  s.addText('中小企業のための AI エージェントシステム', {
    x: M, y: 3.65, w: 10, h: 0.5, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 20, color: 'A7C4C1',
  });
  s.addText('人が判断し、エージェントが作業する。使うほど、会社の資産になる。', {
    x: M, y: 4.3, w: 10, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, color: '7FA5A2',
  });
  s.addText('株式会社M2ホールディングス', {
    x: M, y: 6.5, w: 6, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, color: '7FA5A2',
  });
  s.addNotes('M2Office の全体像と特徴を説明します。');
}

/* 2. 市場の現状 */
{
  const s = lightSlide('日本の中小企業で、AI はまだ組織の仕組みになっていない', '2026 年の各種調査より');
  const stats = [
    { n: '20.4%', t: 'AI を導入している\n中小企業', c: C.teal },
    { n: '4.1%',  t: '全社的に導入している\n企業', c: C.amber },
    { n: '63.4%', t: '「活用する業務が\nイメージできない」', c: C.teal },
  ];
  stats.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 2.0, 3.7, 2.6);
    s.addText(v.n, {
      x, y: 2.25, w: 3.7, h: 1.0, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 52, bold: true, color: v.c, align: 'center',
    });
    s.addText(v.t, {
      x: x + 0.3, y: 3.35, w: 3.1, h: 1.0, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.ink, align: 'center',
    });
  });
  s.addText('出典: 中小企業基盤整備機構、商工中金、帝国データバンク、中小企業白書（2026 年）', {
    x: M, y: 5.0, w: W - M * 2, h: 0.3, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11, color: C.muted,
  });
  s.addNotes('導入率は 2〜3 割。ただし全社導入は 4.1% にすぎない。');
}

/* 3. 何が起きているか */
{
  const s = lightSlide('AI は「個人の道具」にとどまっている', '組織の仕組みになっていないことが、伸び悩みの原因');
  const cols = [
    { h: 'いま起きていること', items: ['個人がチャットで文章を書く', '社内システムとつながらない', 'ノウハウが個人に残り、会社に残らない'], bg: 'F3F4F6', hc: C.muted },
    { h: '必要なこと', items: ['組織として導入する', '業務データに接続する', '会社の資産として蓄積する'], bg: C.tealLt, hc: C.teal },
  ];
  cols.forEach((col, i) => {
    const x = M + i * 6.2;
    card(s, x, 2.0, 5.7, 3.0, col.bg);
    s.addText(col.h, {
      x: x + 0.4, y: 2.3, w: 4.9, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 18, bold: true, color: col.hc,
    });
    s.addText(col.items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < col.items.length - 1 } })), {
      x: x + 0.4, y: 2.9, w: 4.9, h: 1.9, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, color: C.ink, paraSpaceAfter: 10,
    });
  });
  s.addNotes('個人利用から組織利用への移行が、そのまま市場の空白になっている。');
}

/* 4. 空白（暗い面） */
{
  const s = darkSlide();
  s.addText('4.1%', {
    x: M, y: 2.2, w: 6, h: 1.6, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 110, bold: true, color: C.white,
  });
  s.addText('全社的に AI を導入している中小企業の割合', {
    x: M, y: 3.9, w: 8, h: 0.5, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 20, color: 'A7C4C1',
  });
  card(s, 7.6, 2.2, 5.0, 2.6, '13514E');
  s.addText('技術は成立した。\n届く形になっていないだけ。', {
    x: 8.0, y: 2.6, w: 4.2, h: 1.0, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 20, bold: true, color: C.white,
  });
  s.addText('スキルの追加も外部連携も可能になったが、\n中小企業が自力で組み立てることはできない。', {
    x: 8.0, y: 3.7, w: 4.2, h: 0.9, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: 'A7C4C1',
  });
  s.addNotes('ここが M2Office の狙う空白。');
}

/* 5. M2Office とは */
{
  const s = lightSlide('M2Office とは', '中小企業のオフィス業務を、AI エージェントが承認つきで代行する Web サービス');
  const pillars = [
    { n: 1, h: '専属の秘書', t: '従業員ひとりに 1 人。\n話しかければ業務に到達する。' },
    { n: 2, h: '業務エージェント', t: '議事録・請求書・経費など、\n承認を経て作業を代行する。' },
    { n: 3, h: '組織知識', t: '議事録も規程も蓄積され、\n全員が出典つきで引ける。' },
  ];
  pillars.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 2.1, 3.7, 2.9);
    numberCircle(s, v.n, x + 0.4, 2.45);
    s.addText(v.h, {
      x: x + 1.05, y: 2.5, w: 2.5, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 19, bold: true, color: C.teal,
    });
    s.addText(v.t, {
      x: x + 0.4, y: 3.3, w: 2.95, h: 1.3, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.ink,
    });
  });
  s.addText('ブラウザだけで使える。専門知識も IT 担当者も要らない。', {
    x: M, y: 5.35, w: W - M * 2, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink,
  });
  s.addNotes('3 つの柱で説明する。');
}

/* 5b. 共通基盤と拡張 */
{
  const s = lightSlide('共通の土台に、必要なものだけを積む', '会社ごとの事情に、フルスクラッチではなく積み上げで応える');
  const layers = [
    { h: '拡張', t: '業種特化・個社固有の業務', sub: '必要なものだけ足す', bg: C.tealLt, hc: C.teal, who: '運営・第三者・顧客自身' },
    { h: 'M2Office 基盤', t: '秘書・承認・権限・記録・知識', sub: 'どの会社も同じ', bg: 'F7F8F8', hc: C.ink, who: '運営が提供' },
    { h: 'Google Workspace', t: 'メール・予定・文書・会議', sub: 'どの会社も同じ', bg: 'F7F8F8', hc: C.ink, who: '顧客が既に持っている' },
  ];
  layers.forEach((v, i) => {
    const y = 2.05 + i * 1.12;
    s.addShape(p.ShapeType.roundRect, {
      x: M, y, w: 9.0, h: 0.95, rectRadius: 0.07,
      fill: { color: v.bg }, line: { color: v.bg },
    });
    s.addText(v.h, {
      x: M + 0.4, y: y + 0.13, w: 3.0, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, bold: true, color: v.hc,
    });
    s.addText(v.t, {
      x: M + 0.4, y: y + 0.5, w: 5.2, h: 0.33, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.muted,
    });
    s.addText(v.sub, {
      x: M + 5.9, y: y + 0.13, w: 2.7, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: v.hc, align: 'right',
    });
    s.addText(v.who, {
      x: M + 9.3, y: y + 0.28, w: 2.6, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.muted, valign: 'middle',
    });
  });
  s.addText('違いは一番上の層だけに現れる。土台は作り直さない。', {
    x: M, y: 5.55, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.teal,
  });
  s.addNotes('受託開発では高すぎ、汎用パッケージでは届かない。その間を埋める形。');
}

/* 6. 特徴1 秘書 */
{
  const s = lightSlide('特徴 1 ｜ 専属の秘書が「いつものあれ」で通じる', '過去のやり取りを踏まえて、省略した指示を解決する');
  const talks = [
    ['「いつものレポート出して」', '繰り返し作っている報告書を特定する'],
    ['「あの件、どうなった」', '直近の会話と実行履歴から対象を推定する'],
    ['「前と同じ形式で」', '過去の成果物の書式を再利用する'],
  ];
  talks.forEach((t, i) => {
    const y = 2.05 + i * 0.95;
    card(s, M, y, 11.9, 0.78);
    s.addText(t[0], {
      x: M + 0.35, y: y + 0.13, w: 4.4, h: 0.5, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, bold: true, color: C.ink,
    });
    s.addText('→', {
      x: M + 4.9, y: y + 0.15, w: 0.5, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, color: C.teal, align: 'center',
    });
    s.addText(t[1], {
      x: M + 5.5, y: y + 0.17, w: 6.2, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, color: C.muted,
    });
  });
  s.addText('定型の照会は AI を通さずに即答する。3 秒待たせない。', {
    x: M, y: 5.1, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.teal,
  });
  s.addText('「今日の予定は」「承認待ちある？」といった照会はデータから直接返すため、誤りが混入しない。', {
    x: M, y: 5.5, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted,
  });
  s.addNotes('秘書は入口。実務は業務エージェントが担う。');
}

/* 7. 特徴2 承認 */
{
  const s = lightSlide('特徴 2 ｜ 人が判断し、エージェントが作業する', '操作の影響度に応じて、承認の要否を仕組みとして決めている');
  const rows = [
    ['読み取り・検索', '承認は不要', C.muted],
    ['下書きの作成', '承認は不要', C.muted],
    ['社内への書き込み', '既定で承認が必要', C.teal],
    ['対外送信（メール・チャット）', '必ず承認が必要', C.amber],
    ['金銭に関わる確定', '必ず承認が必要', C.amber],
  ];
  rows.forEach((r, i) => {
    const y = 2.05 + i * 0.62;
    s.addShape(p.ShapeType.roundRect, {
      x: M, y, w: 11.9, h: 0.5, rectRadius: 0.06,
      fill: { color: i >= 3 ? 'FDF0E8' : (i === 2 ? C.tealLt : 'F7F8F8') },
      line: { color: i >= 3 ? 'FDF0E8' : (i === 2 ? C.tealLt : 'F7F8F8') },
    });
    s.addText(r[0], {
      x: M + 0.35, y: y + 0.08, w: 6.5, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, color: C.ink,
    });
    s.addText(r[1], {
      x: M + 7.2, y: y + 0.08, w: 4.3, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, bold: i >= 2, color: r[2],
    });
  });
  s.addText('メールの送信と会計の確定は、管理者の設定でも承認を省略できない。', {
    x: M, y: 5.35, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink,
  });
  s.addText('誰がいつ承認したかは、すべて記録に残る。', {
    x: M, y: 5.75, w: 11.9, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted,
  });
  s.addNotes('安全側に倒す設計。基盤が強制し、定義側から緩められない。');
}

/* 8. 特徴3 成長ループ */
{
  const s = lightSlide('特徴 3 ｜ 使うほど、会社の資産になる', '個人の経験が形式知になり、人が辞めても残る');
  const steps = ['秘書に依頼する', '実行し、文脈を覚える', '繰り返しを検知する', '手順化を提案する', '承認して全社へ', '新しい人も最初から使える'];
  steps.forEach((t, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = M + col * 4.1, y = 2.05 + row * 1.55;
    card(s, x, y, 3.7, 1.25);
    numberCircle(s, i + 1, x + 0.35, y + 0.35, 0.46);
    s.addText(t, {
      x: x + 1.0, y: y + 0.4, w: 2.55, h: 0.6, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, bold: true, color: C.ink, valign: 'middle',
    });
  });
  s.addText('議事録も、規程も、過去の見積も、探せる形で会社に貯まっていく。', {
    x: M, y: 5.35, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.teal,
  });
  s.addNotes('蓄積は乗り換えコストとして働く。');
}

/* 9. 特徴4 日本の制度 */
{
  const s = lightSlide('特徴 4 ｜ 日本の制度と商習慣に合わせてある', '海外製のツールをそのまま持ち込めない領域');
  const items = [
    { h: 'インボイス制度', t: '登録番号、税率ごとの区分記載、\n税率ごとに 1 回の端数処理。' },
    { h: '電子帳簿保存法', t: '訂正削除の履歴、取引年月日・\n金額・取引先での検索。' },
    { h: '日本の商習慣', t: '敬語と社外文書の形式、稟議、\n前株・後株、和暦、締め日。' },
  ];
  items.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 2.1, 3.7, 2.7);
    s.addText(v.h, {
      x: x + 0.4, y: 2.45, w: 2.95, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 18, bold: true, color: C.teal,
    });
    s.addText(v.t, {
      x: x + 0.4, y: 3.05, w: 2.95, h: 1.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.ink,
    });
  });
  s.addText('税務相談や手続きの代行は行わない。資料の整理と要件の確認までを担い、専門家の確認を前提とする。', {
    x: M, y: 5.2, w: 11.9, h: 0.5, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted,
  });
  s.addNotes('制度対応が参入障壁として働く。');
}

/* 10. 特徴5 Google */
{
  const s = lightSlide('特徴 5 ｜ Google Workspace で完結する', '今の使い方を変えない。つなぐだけ');
  const svc = ['Gmail', 'ドライブ', 'カレンダー', 'Tasks', 'Chat', 'Meet'];
  svc.forEach((t, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = M + col * 4.1, y = 2.1 + row * 1.35;
    card(s, x, y, 3.7, 1.05);
    s.addText(t, {
      x: x + 0.4, y: y + 0.28, w: 2.95, h: 0.5, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 19, bold: true, color: C.teal, valign: 'middle',
    });
  });
  s.addText('会議をすれば議事録が残り、メールを処理すれば下書きができる。', {
    x: M, y: 5.05, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink,
  });
  s.addText('新しい道具を増やすのではなく、いま使っているものを有機的につなぐ。', {
    x: M, y: 5.45, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted,
  });
  s.addNotes('社内は Google に一本化。社外接点は将来 LINE も。');
}

/* 11. 特徴6 GUI で拡張 */
{
  const s = lightSlide('特徴 6 ｜ スキルを画面から足せる', '同じ「スキルを足す」でも、その作業が誰にできるかで価値が変わる');
  const rows = [
    ['スキルの実体', 'リポジトリ内のファイル', 'データベース上の定義'],
    ['導入', 'コマンドで取り込む', '画面から選んで有効化'],
    ['設定の変更', 'ファイルを書き換える', '画面から編集する'],
    ['誰に扱えるか', '技術者', '業務担当者'],
    ['権限の割当', '環境の権限に従う', '画面で人ごとに割り当てる'],
  ];
  s.addText('従来の方式', {
    x: M + 4.0, y: 1.95, w: 3.6, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: C.muted, align: 'center',
  });
  s.addText('M2Office', {
    x: M + 7.9, y: 1.95, w: 4.0, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: C.teal, align: 'center',
  });
  rows.forEach((r, i) => {
    const y = 2.4 + i * 0.6;
    s.addText(r[0], {
      x: M + 0.1, y: y + 0.08, w: 3.7, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.ink,
    });
    s.addShape(p.ShapeType.roundRect, {
      x: M + 4.0, y, w: 3.6, h: 0.5, rectRadius: 0.06,
      fill: { color: 'F3F4F6' }, line: { color: 'F3F4F6' },
    });
    s.addText(r[1], {
      x: M + 4.15, y: y + 0.08, w: 3.3, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.muted, align: 'center',
    });
    s.addShape(p.ShapeType.roundRect, {
      x: M + 7.9, y, w: 4.0, h: 0.5, rectRadius: 0.06,
      fill: { color: C.tealLt }, line: { color: C.tealLt },
    });
    s.addText(r[2], {
      x: M + 8.05, y: y + 0.08, w: 3.7, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: C.teal, align: 'center',
    });
  });
  s.addText('ファイルを書ける人しか扱えないなら、拡張の速度はその人数で頭打ちになる。', {
    x: M, y: 5.55, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink,
  });
  s.addNotes('ここが生産性の差。作る人は技術者でも、入れる人は業務担当者でよい。');
}

/* 11b. パートナー制度 */
{
  const s = lightSlide('だから、外部に作ってもらえる', '運営がすべての業種を作ることはできない');
  const roles = [
    { n: 1, h: '作る', w: 'インテグレーター\nSaaS ベンダー\n士業・業界団体', need: '業務知識、または API 開発' },
    { n: 2, h: '届ける', w: 'マーケット\nパートナー', need: '販路' },
    { n: 3, h: '入れる', w: '顧客の管理者', need: '不要。画面の操作だけ' },
    { n: 4, h: '使う', w: '顧客の従業員', need: '不要' },
  ];
  roles.forEach((v, i) => {
    const x = M + i * 3.05;
    const hi = i >= 2;
    card(s, x, 2.05, 2.75, 2.95, hi ? C.tealLt : 'F7F8F8');
    numberCircle(s, v.n, x + 0.3, 2.3, 0.46, hi ? C.teal : '9AA5A3');
    s.addText(v.h, {
      x: x + 0.9, y: 2.33, w: 1.7, h: 0.42, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 18, bold: true, color: hi ? C.teal : C.ink, valign: 'middle',
    });
    s.addText(v.w, {
      x: x + 0.3, y: 3.0, w: 2.15, h: 1.1, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink,
    });
    s.addText(v.need, {
      x: x + 0.3, y: 4.25, w: 2.15, h: 0.6, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, bold: hi, color: hi ? C.amber : C.muted,
    });
  });
  s.addText('「入れる」に技術力が要らないから、作ったものがそのまま顧客に届く。', {
    x: M, y: 5.3, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.ink,
  });
  s.addText('士業と業界団体が鍵になる。業務知識と販路の両方を持ち、手順の定義はプログラミングなしで作れる。', {
    x: M, y: 5.72, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted,
  });
  s.addNotes('提供できる範囲を、運営の開発力から切り離す。');
}

/* 12. 安全性 */
{
  const s = lightSlide('組織で使うための安全性', '懸念の上位は「情報の正確性」「情報漏洩」「責任の所在」');
  const items = [
    { h: '会社ごとに隔てる', t: '他社のデータは、検索の候補にも出ない。' },
    { h: '機微情報を区画で守る', t: '人事や給与は別区画。管理者でも他人の記憶は見られない。' },
    { h: '全操作を記録する', t: '誰が何を根拠に実行し、誰が承認したかが残る。' },
  ];
  items.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 2.1, 3.7, 2.6);
    numberCircle(s, i + 1, x + 0.4, 2.45);
    s.addText(v.h, {
      x: x + 1.05, y: 2.5, w: 2.5, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, bold: true, color: C.teal, valign: 'middle',
    });
    s.addText(v.t, {
      x: x + 0.4, y: 3.25, w: 2.95, h: 1.2, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.ink,
    });
  });
  s.addText('回答には必ず出典を添える。取得できなかった値を推測で埋めない。', {
    x: M, y: 5.1, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink,
  });
  s.addNotes('懸念に対して一つずつ設計で答えている。');
}

/* 13. 画面 */
{
  const s = lightSlide('画面は 3 つの領域と、常駐する秘書', '使う操作は「選ぶ」「埋める」「承認する」の 3 つだけ');
  const panes = [
    { x: M,        w: 2.6, h: '業務メニュー', t: '使える業務が\n並ぶ' },
    { x: M + 2.8,  w: 5.4, h: 'キャンバス',   t: '入力と成果物を\n扱う' },
    { x: M + 8.4,  w: 3.5, h: 'サッシパネル', t: '根拠と実行内容を\n確認する' },
  ];
  panes.forEach((v) => {
    card(s, v.x, 2.1, v.w, 2.5);
    s.addText(v.h, {
      x: v.x + 0.25, y: 2.4, w: v.w - 0.5, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 16, bold: true, color: C.teal,
    });
    s.addText(v.t, {
      x: v.x + 0.25, y: 3.0, w: v.w - 0.5, h: 1.2, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.ink,
    });
  });
  s.addShape(p.ShapeType.roundRect, {
    x: M, y: 4.8, w: 11.9, h: 0.75, rectRadius: 0.1,
    fill: { color: C.dark }, line: { color: C.dark },
  });
  s.addText('秘書｜「何かお手伝いしましょうか」', {
    x: M + 0.35, y: 4.95, w: 8, h: 0.45, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, color: C.white, valign: 'middle',
  });
  s.addText('どの画面からでも呼び出せる', {
    x: M + 8.4, y: 4.98, w: 3.2, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: 'A7C4C1', align: 'right', valign: 'middle',
  });
  s.addText('「なぜこの結果になったか」を、作業を止めずに確認できる。', {
    x: M, y: 5.75, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted,
  });
  s.addNotes('専門用語を画面に出さない。');
}

/* 14. 導入 */
{
  const s = lightSlide('30 分で、最初の実行まで', '推進担当者がいない会社でも始められること');
  const steps = ['登録', '会社情報', 'Google 連携', '業務を選ぶ', '試し実行', '同僚を招待'];
  steps.forEach((t, i) => {
    const x = M + i * 2.0;
    s.addShape(p.ShapeType.ellipse, {
      x: x + 0.5, y: 2.4, w: 0.72, h: 0.72, fill: { color: C.teal },
    });
    s.addText(String(i + 1), {
      x: x + 0.5, y: 2.4, w: 0.72, h: 0.72, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 19, bold: true, color: C.white, align: 'center', valign: 'middle',
    });
    s.addText(t, {
      x, y: 3.3, w: 1.75, h: 0.5, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: C.ink, align: 'center',
    });
    if (i < steps.length - 1) {
      s.addShape(p.ShapeType.line, {
        x: x + 1.3, y: 2.76, w: 0.65, h: 0, line: { color: C.line, width: 2 },
      });
    }
  });
  card(s, M, 4.3, 11.9, 1.3);
  s.addText('最大の障壁は「何に使えるか分からない」こと。', {
    x: M + 0.45, y: 4.55, w: 11.0, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 17, bold: true, color: C.ink,
  });
  s.addText('だから空の入力欄から始めない。業務名の付いたカードが並び、秘書が待っている状態から始める。', {
    x: M + 0.45, y: 4.98, w: 11.0, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, color: C.muted,
  });
  s.addNotes('導入の入口を設計の要件にしている。');
}

/* 15. 料金 */
{
  const s = lightSlide('料金の考え方', '請求が読める形であることを優先する');
  card(s, M, 2.1, 5.7, 2.4);
  s.addText('基本料金 ＋ 単価 × シート数', {
    x: M + 0.45, y: 2.5, w: 4.9, h: 0.55, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 22, bold: true, color: C.teal,
  });
  s.addText('月額はシンプルに。AI の利用量は内部で計測し、管理者が上限と限度額を決める。', {
    x: M + 0.45, y: 3.15, w: 4.9, h: 1.0, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, color: C.ink,
  });
  card(s, M + 6.2, 2.1, 5.7, 2.4, 'F7F8F8');
  s.addText('上限に達したら', {
    x: M + 6.65, y: 2.4, w: 4.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.ink,
  });
  const lim = ['近づいたら管理者へ警告する', '自動課金なら継続、無ければ停止する', '限度額は自動課金より優先する'];
  s.addText(lim.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < lim.length - 1 } })), {
    x: M + 6.65, y: 2.95, w: 4.9, h: 1.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, color: C.ink, paraSpaceAfter: 8,
  });
  s.addText('「自動で課金するが、この額まで」と言えなければ、中小企業は自動課金を選べない。', {
    x: M, y: 4.85, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink,
  });
  s.addText('導入費用の助成を求める声は 77.9%。補助金の対象ツールとしての登録も進める。', {
    x: M, y: 5.3, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted,
  });
  s.addNotes('価格は Phase 1 の実測後に決める。');
}

/* 16. ロードマップ */
{
  const s = lightSlide('段階的に広げる', 'まず自社で使い、事例にしてから外へ出す');
  const ph = [
    { n: 'Phase 1', h: '自社導入', t: '基盤と秘書、\n業務 5 種類' },
    { n: 'Phase 2', h: '関連会社', t: '経理・販売事務、\n拡張機構、API 公開' },
    { n: 'Phase 3', h: '限定外販', t: 'マーケット公開、\n人事領域' },
    { n: 'Phase 4', h: '一般提供', t: 'パートナー展開、\nエコシステム' },
  ];
  ph.forEach((v, i) => {
    const x = M + i * 3.05;
    card(s, x, 2.2, 2.75, 2.7, i === 0 ? C.tealLt : 'F7F8F8');
    s.addText(v.n, {
      x: x + 0.3, y: 2.5, w: 2.15, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: i === 0 ? C.teal : C.muted,
    });
    s.addText(v.h, {
      x: x + 0.3, y: 2.9, w: 2.15, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 18, bold: true, color: C.ink,
    });
    s.addText(v.t, {
      x: x + 0.3, y: 3.5, w: 2.15, h: 1.2, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink,
    });
  });
  s.addText('成功事例の不足を挙げる声は 83.3%。自社導入をそのまま最初の事例にする。', {
    x: M, y: 5.25, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, color: C.muted,
  });
  s.addNotes('Phase 1 は自社のバックオフィスで実運用する。');
}

/* 17. まとめ */
{
  const s = darkSlide();
  s.addText('M2Office が目指すもの', {
    x: M, y: 1.3, w: 10, h: 0.8, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 34, bold: true, color: C.white,
  });
  const pts = [
    ['組織として導入できる形にした', '権限・承認・記録を最初から備える'],
    ['共通の土台に、必要な分だけ積む', '画面から足せるから、外部にも作ってもらえる'],
    ['日本の制度に合わせてある', 'インボイス、電帳法、日本の商習慣'],
    ['使うほど会社の資産になる', '個人の経験が形式知として残る'],
  ];
  pts.forEach((v, i) => {
    const y = 2.45 + i * 0.95;
    numberCircle(s, i + 1, M, y, 0.55, '13514E');
    s.addText(v[0], {
      x: M + 0.85, y: y - 0.02, w: 9.5, h: 0.42, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 20, bold: true, color: C.white,
    });
    s.addText(v[1], {
      x: M + 0.85, y: y + 0.42, w: 9.5, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: 'A7C4C1',
    });
  });
  s.addText('株式会社M2ホールディングス　　もっと自由で楽しい世界を実現したい', {
    x: M, y: 6.5, w: 11, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, color: '7FA5A2',
  });
  s.addNotes('まとめ。');
}

await p.writeFile({ fileName: 'M2Office_プロダクト概要.pptx' });
console.log('生成しました');
