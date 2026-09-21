import pptxgen from 'pptxgenjs';

/**
 * 開発メンバー向けのキックオフ資料。
 * プロダクト概要（build.mjs）とは読み手が違う。
 * 「何が技術的に面白いか」と「もう動いている」ことを中心に据える。
 */
const C = {
  dark: '0A3D3B', teal: '0F766E', tealLt: 'E8F1F0', amber: 'C2410C',
  ink: '1A1A1A', muted: '64748B', white: 'FFFFFF', line: 'D6E2E0',
  code: '13514E',
};
const F = 'Yu Gothic';
const MONO = 'Consolas';
const W = 13.33, H = 7.5, M = 0.7;

const p = new pptxgen();
p.layout = 'LAYOUT_WIDE';
p.author = '株式会社M2ホールディングス';
p.title = 'M2Office 開発キックオフ';

function darkSlide() { const s = p.addSlide(); s.background = { color: C.dark }; return s; }
function lightSlide(title, lead) {
  const s = p.addSlide(); s.background = { color: C.white };
  s.addText(title, { x: M, y: 0.5, w: W - M * 2, h: 0.7, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 30, bold: true, color: C.ink });
  if (lead) s.addText(lead, { x: M, y: 1.18, w: W - M * 2, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, color: C.muted });
  return s;
}
/** 章の区切り。暗い面に番号と見出しだけを置く。 */
function sectionSlide(no, title, lead) {
  const s = darkSlide();
  s.addText(no, { x: M, y: 2.3, w: 2.2, h: 1.2, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 80, bold: true, color: '2E6B67' });
  s.addText(title, { x: M, y: 3.5, w: 10, h: 0.8, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 36, bold: true, color: C.white });
  if (lead) s.addText(lead, { x: M, y: 4.4, w: 10, h: 0.5, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, color: 'A7C4C1' });
  return s;
}
function card(s, x, y, w, h, fill = C.tealLt) {
  s.addShape(p.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08,
    fill: { color: fill }, line: { color: fill } });
}
function numberCircle(s, n, x, y, d = 0.5, fill = C.teal) {
  s.addShape(p.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: fill } });
  s.addText(String(n), { x, y, w: d, h: d, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.white, align: 'center', valign: 'middle' });
}

/* 1. 表紙 */
{
  const s = darkSlide();
  s.addText('M2Office', { x: M, y: 2.3, w: 9, h: 1.1, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 58, bold: true, color: C.white });
  s.addText('開発キックオフ', { x: M, y: 3.45, w: 9, h: 0.6, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 24, color: 'A7C4C1' });
  s.addText('中小企業のための AI エージェントプラットフォームを、一緒に作りませんか', {
    x: M, y: 4.25, w: 11, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, color: '7FA5A2' });
  s.addText('株式会社M2ホールディングス', { x: M, y: 6.5, w: 6, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, color: '7FA5A2' });
  s.addNotes('これから作るものと、なぜ面白いかを共有します。');
}

/* 2. 一言で */
{
  const s = lightSlide('一言でいうと', '');
  card(s, M, 1.9, 11.9, 1.5, C.tealLt);
  s.addText('従業員ひとりに AI 秘書が付き、業務エージェントが承認つきで作業を代行する。\nそして、会社ごとの業務は「スキル」として画面から足していける。', {
    x: M + 0.5, y: 2.2, w: 11.0, h: 1.0, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 19, bold: true, color: C.ink, lineSpacing: 30 });
  const three = [
    { n: 1, h: '組織で使える', t: '権限・承認・監査を\n最初から備える' },
    { n: 2, h: '日本の制度に合う', t: 'インボイス、電帳法、\n商習慣' },
    { n: 3, h: '画面から拡張できる', t: '作る人は技術者でも、\n入れる人は業務担当者' },
  ];
  three.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 3.7, 3.7, 2.0, 'F7F8F8');
    numberCircle(s, v.n, x + 0.35, 3.95, 0.45);
    s.addText(v.h, { x: x + 0.95, y: 3.98, w: 2.6, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 16, bold: true, color: C.teal, valign: 'middle' });
    s.addText(v.t, { x: x + 0.35, y: 4.6, w: 3.0, h: 0.9, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink });
  });
  s.addNotes('3 つの軸で差別化する。');
}

/* 3. 章: なぜ作るのか */
sectionSlide('01', 'なぜ作るのか', '需要側と供給側の、両方が行き詰まっている');

/* 4. 需要側 */
{
  const s = lightSlide('需要側 ｜ AI は個人の道具にとどまっている', '2026 年の各種調査より');
  const stats = [
    { n: '20.4%', t: 'AI を導入している\n中小企業', c: C.teal },
    { n: '4.1%', t: '全社的に導入して\nいる企業', c: C.amber },
    { n: '63.4%', t: '「活用する業務が\nイメージできない」', c: C.teal },
  ];
  stats.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 2.0, 3.7, 2.5);
    s.addText(v.n, { x, y: 2.25, w: 3.7, h: 0.95, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 50, bold: true, color: v.c, align: 'center' });
    s.addText(v.t, { x: x + 0.3, y: 3.3, w: 3.1, h: 0.9, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink, align: 'center' });
  });
  s.addText('全社導入は 4.1%。技術は成立したのに、届く形になっていない。', {
    x: M, y: 4.8, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.ink });
  s.addText('出典: 中小企業基盤整備機構、商工中金、帝国データバンク、中小企業白書（2026 年）', {
    x: M, y: 5.3, w: 11.9, h: 0.3, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 11, color: C.muted });
  s.addNotes('市場の 6 割以上が未着手。');
}

/* 5. 供給側 */
{
  const s = lightSlide('供給側 ｜ 毎回ゼロから作る慣行が続いてきた', 'ここが今回の出発点');
  const cols = [
    { h: '受託開発', items: ['すべてが人月の見積もりになる', '費用と期間が中小企業の手に負えない', '作った分しか増えない'], bg: 'F3F4F6', hc: C.muted },
    { h: '汎用パッケージ', items: ['業務に合わない部分が残る', '既存システムとの連携が埋まらない', '結局その部分を作り込む'], bg: 'F3F4F6', hc: C.muted },
  ];
  cols.forEach((col, i) => {
    const x = M + i * 6.2;
    card(s, x, 1.95, 5.7, 2.3, col.bg);
    s.addText(col.h, { x: x + 0.4, y: 2.2, w: 4.9, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, bold: true, color: col.hc });
    s.addText(col.items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < col.items.length - 1 } })), {
      x: x + 0.4, y: 2.7, w: 4.9, h: 1.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink, paraSpaceAfter: 6 });
  });
  card(s, M, 4.5, 11.9, 1.5);
  s.addText('AI に担わせるのは 2 つだけ', { x: M + 0.45, y: 4.7, w: 5, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.teal });
  s.addText('① 既存システムどうしをつなぐ　　② 土台に影響を与えずに、個社固有の業務を差し込む', {
    x: M + 0.45, y: 5.15, w: 11.0, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink });
  s.addText('これが成り立てば、個社対応は「作り直し」ではなく「差分を足す」作業になる。', {
    x: M + 0.45, y: 5.55, w: 11.0, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted });
  s.addNotes('ソフトウェア業界にいた頃からの問題意識。');
}

/* 6. 解き方 */
{
  const s = lightSlide('解き方 ｜ 共通の土台に、必要な分だけ積む', '違いは一番上の層だけに現れる');
  const layers = [
    { h: '拡張', t: '業種特化・個社固有の業務', who: '運営・第三者・顧客自身', bg: C.tealLt, hc: C.teal },
    { h: 'M2Office 基盤', t: '秘書・承認・権限・記録・知識', who: '運営が提供', bg: 'F7F8F8', hc: C.ink },
    { h: 'Google Workspace', t: 'メール・予定・文書・会議', who: '顧客が既に持っている', bg: 'F7F8F8', hc: C.ink },
  ];
  layers.forEach((v, i) => {
    const y = 2.0 + i * 1.12;
    s.addShape(p.ShapeType.roundRect, { x: M, y, w: 9.0, h: 0.95, rectRadius: 0.07,
      fill: { color: v.bg }, line: { color: v.bg } });
    s.addText(v.h, { x: M + 0.4, y: y + 0.13, w: 3.4, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, bold: true, color: v.hc });
    s.addText(v.t, { x: M + 0.4, y: y + 0.5, w: 5.4, h: 0.33, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.muted });
    s.addText(v.who, { x: M + 9.3, y: y + 0.28, w: 2.6, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.muted, valign: 'middle' });
  });
  s.addText('しかも、拡張は画面から足せる。従来はファイルとコマンドの操作だった。', {
    x: M, y: 5.5, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.teal });
  s.addText('ファイルを書ける人しか扱えないなら、拡張の速度はその人数で頭打ちになる。', {
    x: M, y: 5.92, w: 11.9, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted });
  s.addNotes('ここが Anthropic のプラグイン方式との差。');
}

/* 7. 章: 技術的に何が面白いか */
sectionSlide('02', '技術的に何が面白いか', '素直に作れない要件が、いくつもある');

/* 8. 面白い所 1 */
{
  const s = lightSlide('① 承認で中断し、別のプロセスが再開する', '実行エンジンの中核。ここが一番難しい');
  const flow = ['依頼', '実行', '承認ゲート\nで中断', 'ワーカー\n終了', '人が承認', '別ワーカー\nが再開', '完了'];
  flow.forEach((t, i) => {
    const x = M + i * 1.72;
    const hi = i === 2 || i === 3 || i === 5;
    card(s, x, 2.1, 1.55, 1.15, hi ? C.tealLt : 'F7F8F8');
    s.addText(t, { x: x + 0.1, y: 2.25, w: 1.35, h: 0.85, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, bold: hi, color: hi ? C.teal : C.ink, align: 'center', valign: 'middle' });
    if (i < flow.length - 1) s.addText('▶', { x: x + 1.48, y: 2.5, w: 0.3, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11, color: C.line, align: 'center' });
  });
  const pts = [
    ['状態は毎ステップ永続化する', 'メモリ上の文脈に依存しない。プロセスが落ちても続きから'],
    ['中断したワーカーが再開するとは限らない', '承認後は待ち行列へ戻り、次に空いたワーカーが担当する'],
    ['数分〜数十分にまたがる', 'リクエスト単位で終了する実行環境では実装できない'],
  ];
  pts.forEach((v, i) => {
    const y = 3.6 + i * 0.75;
    s.addText('・' + v[0], { x: M, y, w: 5.6, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, bold: true, color: C.ink });
    s.addText(v[1], { x: M + 5.8, y: y + 0.02, w: 6.1, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.muted });
  });
  s.addNotes('これが動けば他は積み上げ。逆にここを後回しにすると何も作れない。');
}

/* 9. 面白い所 2 */
{
  const s = lightSlide('② 第三者のコードを実行せずに、拡張を受け入れる', 'プラグイン機構で最も難しいのは隔離。それを「実行しない」ことで回避する');
  const layers = [
    { n: 'L1', h: 'エージェント定義', t: '宣言的。条件分岐もループも持たない', where: 'M2Office 内で解釈', who: '業務知識だけで作れる' },
    { n: 'L2', h: 'MCP コネクタ', t: '外部システムへの接続', where: '提供者・顧客のサーバ', who: 'API が書ければ作れる' },
    { n: 'L3', h: '外部アプリ', t: '公開 API を使う独立アプリ', where: '完全に外部', who: 'Web 開発ができれば作れる' },
  ];
  layers.forEach((v, i) => {
    const y = 2.0 + i * 1.15;
    card(s, M, y, 11.9, 1.0, i === 0 ? C.tealLt : 'F7F8F8');
    s.addShape(p.ShapeType.roundRect, { x: M + 0.35, y: y + 0.25, w: 0.8, h: 0.45,
      rectRadius: 0.06, fill: { color: C.teal }, line: { color: C.teal } });
    s.addText(v.n, { x: M + 0.35, y: y + 0.25, w: 0.8, h: 0.45, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: C.white, align: 'center', valign: 'middle' });
    s.addText(v.h, { x: M + 1.35, y: y + 0.13, w: 3.0, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 16, bold: true, color: C.ink });
    s.addText(v.t, { x: M + 1.35, y: y + 0.52, w: 4.2, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.muted });
    s.addText(v.where, { x: M + 5.9, y: y + 0.3, w: 2.9, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: C.teal, valign: 'middle' });
    s.addText(v.who, { x: M + 8.9, y: y + 0.3, w: 2.8, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.muted, valign: 'middle' });
  });
  s.addText('サンドボックス実行環境を自前で作らなくて済む。', {
    x: M, y: 5.55, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.ink });
  s.addNotes('L1 がチューリング完全でないことが効いている。');
}

/* 10. 面白い所 3 */
{
  const s = lightSlide('③ テナント分離を、規律ではなく構造で守る', '「気をつける」で守るものは、いつか破れる');
  const items = [
    { h: '行レベルセキュリティ', t: 'アプリに不具合があっても\nDB がテナントを越えさせない' },
    { h: '権限区画', t: '人事・給与などの機微情報を\n別区画に隔てる' },
    { h: '存在を示さない', t: '「権限がない」と返すと\n情報の存在が推測できる' },
  ];
  items.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 2.0, 3.7, 2.3);
    numberCircle(s, i + 1, x + 0.35, 2.3, 0.45);
    s.addText(v.h, { x: x + 0.95, y: 2.33, w: 2.6, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 15, bold: true, color: C.teal, valign: 'middle' });
    s.addText(v.t, { x: x + 0.35, y: 2.95, w: 3.0, h: 1.1, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink });
  });
  card(s, M, 4.55, 11.9, 1.35, 'F7F8F8');
  s.addText('接続プールの扱いが、この方式で最も事故が起きやすい', {
    x: M + 0.45, y: 4.75, w: 11.0, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.amber });
  s.addText('セッション変数にテナントを置くと、接続が再利用されたときに前の値が残る。\nトランザクション単位で設定することを実装規約にしている。', {
    x: M + 0.45, y: 5.18, w: 11.0, h: 0.6, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.ink });
  s.addNotes('テナント越えが失敗することを自動テストで常時確認する。');
}

/* 11. 面白い所 4・5 */
{
  const s = lightSlide('④ LLM を差し替え可能にする　⑤ LLM を通さない応答', '価格競争が起きている領域に、固定で乗らない');
  card(s, M, 1.95, 5.7, 3.6);
  s.addText('④ 抽象化層', { x: M + 0.45, y: 2.2, w: 4.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 18, bold: true, color: C.teal });
  const a = ['モデル名を直書きしない', '「高速・標準・高性能」の役割で参照する', '共通形式は OpenAI 互換を土台にする', 'Gemini / Claude / OpenAI / Grok / Qwen'];
  s.addText(a.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < a.length - 1 } })), {
    x: M + 0.45, y: 2.75, w: 4.9, h: 2.0, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.ink, paraSpaceAfter: 8 });
  s.addText('モデルの更新に、仕様書もコードも追随しなくて済む', {
    x: M + 0.45, y: 4.85, w: 4.9, h: 0.5, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, bold: true, color: C.muted });

  card(s, M + 6.2, 1.95, 5.7, 3.6, 'F7F8F8');
  s.addText('⑤ 秘書の 3 層応答', { x: M + 6.65, y: 2.2, w: 4.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 18, bold: true, color: C.ink });
  const rows = [['層 1', 'データから直接返す', 'LLM を使わない'], ['層 2', '高速モデルで取り次ぐ', '判定のみ'], ['層 3', '完全な対話', '標準モデル']];
  rows.forEach((r, i) => {
    const y = 2.8 + i * 0.55;
    s.addText(r[0], { x: M + 6.65, y, w: 0.8, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, bold: true, color: i === 0 ? C.teal : C.muted });
    s.addText(r[1], { x: M + 7.5, y, w: 2.4, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink });
    s.addText(r[2], { x: M + 9.9, y, w: 1.7, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, bold: i === 0, color: i === 0 ? C.amber : C.muted });
  });
  s.addText('層 1 は推論を通らないので、事実の誤りが混入しない。\n速くて、安くて、正確。', {
    x: M + 6.65, y: 4.65, w: 4.9, h: 0.7, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, bold: true, color: C.muted });
  s.addNotes('層 1 の実測は 4〜9ms。');
}

/* 12. 面白い所 6 */
{
  const s = lightSlide('⑥ 承認ゲートが、学習データの供給源になる', '安全のために置いた仕組みが、別の価値を生む');
  const flow = [
    { h: '承認ゲート', t: '対外送信や金銭処理の前に\n人が確認する', tag: '本来の目的：安全' },
    { h: 'そこで生まれる信号', t: '承認されたか\n修正されたか\n却下されたか', tag: '副産物' },
    { h: '学習に使える組', t: '入力・出力・評価が\n揃った形で残る', tag: '価値：改善' },
  ];
  flow.forEach((v, i) => {
    const x = M + i * 4.1;
    card(s, x, 2.0, 3.7, 2.6, i === 2 ? C.tealLt : 'F7F8F8');
    s.addText(v.tag, { x: x + 0.35, y: 2.2, w: 3.0, h: 0.3, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11, color: C.muted });
    s.addText(v.h, { x: x + 0.35, y: 2.55, w: 3.0, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, bold: true, color: i === 2 ? C.teal : C.ink });
    s.addText(v.t, { x: x + 0.35, y: 3.1, w: 3.0, h: 1.3, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink });
    if (i < 2) s.addText('▶', { x: x + 3.78, y: 3.1, w: 0.3, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.line, align: 'center' });
  });
  s.addText('単に会話を残すだけでは学習の材料にならない。「その応答が良かったか」が要る。', {
    x: M, y: 4.85, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 16, bold: true, color: C.ink });
  s.addText('LLM の重みは更新しない。企業ごとに蓄積して参照することで精度を上げる。', {
    x: M, y: 5.3, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted });
  s.addNotes('モデルの学習とシステムの蓄積を分けて考える。');
}

/* 13. 章: もう動いている */
sectionSlide('03', 'もう動いている', '設計だけではありません');

/* 14. 動いているもの */
{
  const s = lightSlide('通しで動作しています', 'npm run smoke ― 一本の流れを毎回検証している');
  card(s, M, 1.9, 7.4, 4.0, C.dark);
  const log = [
    '■ 3. 承認ありの経路（AG-02 議事録作成・共有）',
    '  ✓ ジョブを受け付けた（待ち行列へ）',
    '  ✓ 承認ゲートで中断した（cursor=2）',
    '  ✓ 成果物が保存された',
    '',
    '■ 4. 承認による再開（最重要）',
    '  ✓ 承認した',
    '  ✓ 別のワーカーが続きから再開した（cursor 2 → 4）',
    '  ✓ 最後まで完了した（6 ステップ、0.12 円）',
    '',
    '■ 5. テナント分離',
    '  ✓ 他テナントの実行は見えない（404）',
    '  ✓ 権限区画の文書は区画外の検索に出ない',
  ];
  s.addText(log.join('\n'), { x: M + 0.35, y: 2.15, w: 6.8, h: 3.5, isTextBox: true, margin: 0,
    fontFace: MONO, fontSize: 11, color: 'C9E0DD', lineSpacing: 16 });
  const facts = [
    ['TypeScript', '3,853 行'],
    ['パッケージ', '5 つ（core / api / worker / web / shared）'],
    ['DB テーブル', '11'],
    ['層 1 の応答', '4〜9 ミリ秒（LLM 不使用）'],
    ['LLM の鍵', '無くても全経路が動く（スタブ）'],
  ];
  facts.forEach((f, i) => {
    const y = 2.0 + i * 0.72;
    card(s, M + 7.7, y, 4.2, 0.6, 'F7F8F8');
    s.addText(f[0], { x: M + 7.95, y: y + 0.13, w: 1.8, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.muted });
    s.addText(f[1], { x: M + 9.7, y: y + 0.13, w: 2.0, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, bold: true, color: C.teal, align: 'right' });
  });
  s.addText('最も難しい「承認で中断し、別ワーカーが再開する」経路が、すでに通っている。', {
    x: M, y: 6.05, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink });
  s.addNotes('テナントを 2 つ作って動かしている。');
}

/* 15. 構成 */
{
  const s = lightSlide('構成 ｜ モノレポ 5 パッケージ', '依存の向きを固定している。core に HTTP を持ち込まない');
  const pkgs = [
    { n: 'core', t: 'ドメインロジック\n実行エンジン・秘書・ツール・LLM 抽象化', dep: 'shared のみ' },
    { n: 'api', t: '公開 API（Hono）\n画面も外部アプリも同じ API を通る', dep: 'core, shared' },
    { n: 'worker', t: 'ジョブ実行の常駐プロセス\n中断と再開を担う', dep: 'core, shared' },
    { n: 'web', t: 'ワークスペース（Vite + React）\nAPI 以外にデータへ到達できない', dep: 'shared（型のみ）' },
    { n: 'shared', t: '型定義と定数\n実装は置かない', dep: 'なし' },
  ];
  pkgs.forEach((v, i) => {
    const y = 1.95 + i * 0.83;
    card(s, M, y, 11.9, 0.7, i === 0 ? C.tealLt : 'F7F8F8');
    s.addText(v.n, { x: M + 0.35, y: y + 0.18, w: 1.5, h: 0.35, isTextBox: true, margin: 0,
      fontFace: MONO, fontSize: 15, bold: true, color: i === 0 ? C.teal : C.ink });
    s.addText(v.t.replace('\n', '　｜　'), { x: M + 2.0, y: y + 0.18, w: 7.2, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink });
    s.addText(v.dep, { x: M + 9.3, y: y + 0.18, w: 2.3, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.muted, align: 'right' });
  });
  s.addText('依存の向きは型検査で守る。core が崩れると、API とワーカーから同じロジックを呼べなくなる。', {
    x: M, y: 6.15, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted });
  s.addNotes('SPA を選んだのは A-2 を構造で担保するため。');
}

/* 16. 技術選定 */
{
  const s = lightSlide('技術選定と、その理由', '判断はすべて ADR に残している');
  const rows = [
    ['画面', 'Vite + React（SPA）', 'API を経由する以外に手段がない＝抜け道を作れない'],
    ['API', 'Hono', '型推論が強く画面と型を共有できる。概念が少ない'],
    ['ワーカー', 'Node.js 常駐プロセス', '中断と再開はリクエスト単位の環境では作れない'],
    ['DB', 'PostgreSQL（RLS）', 'テナント分離をアプリの外で強制する'],
    ['LLM', 'Gemini（抽象化層あり）', '既定は Gemini。差し替え可能にしておく'],
    ['インフラ', 'さくらインターネット', 'データ所在地。国内'],
  ];
  rows.forEach((r, i) => {
    const y = 1.95 + i * 0.72;
    card(s, M, y, 11.9, 0.6, i % 2 ? 'FBFCFC' : 'F7F8F8');
    s.addText(r[0], { x: M + 0.35, y: y + 0.13, w: 1.5, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.muted });
    s.addText(r[1], { x: M + 1.95, y: y + 0.13, w: 3.3, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, bold: true, color: C.teal });
    s.addText(r[2], { x: M + 5.4, y: y + 0.15, w: 6.2, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.ink });
  });
  s.addText('却下した案の利点も記録している。状況が変わったときに、何を知った上で決めたかを追える。', {
    x: M, y: 6.3, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted });
  s.addNotes('ADR-0001 が SPA、ADR-0002 が Hono。');
}

/* 17. 章: これから */
sectionSlide('04', 'これから', '何を、どの順で作るか');

/* 18. Phase 1 */
{
  const s = lightSlide('Phase 1 ｜ まず自社で使う', '毎日発生する業務が、エージェントで回っている状態を作る');
  const agents = [
    { id: 'AG-04', n: '社内ナレッジ Q&A', st: '実装済み' },
    { id: 'AG-02', n: '議事録作成・共有', st: '実装済み' },
    { id: 'AG-05', n: '週次ブリーフ', st: '次はここ' },
    { id: 'AG-01', n: '受信箱整理・返信起案', st: 'Gmail 審査を見つつ' },
    { id: 'AG-03', n: '日程調整', st: '社内限定から' },
  ];
  agents.forEach((v, i) => {
    const y = 1.95 + i * 0.78;
    const done = v.st === '実装済み';
    card(s, M, y, 7.6, 0.65, done ? C.tealLt : 'F7F8F8');
    s.addText(v.id, { x: M + 0.35, y: y + 0.15, w: 1.1, h: 0.35, isTextBox: true, margin: 0,
      fontFace: MONO, fontSize: 13, bold: true, color: done ? C.teal : C.muted });
    s.addText(v.n, { x: M + 1.6, y: y + 0.15, w: 3.6, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 14, color: C.ink });
    s.addText(v.st, { x: M + 5.2, y: y + 0.15, w: 2.2, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, bold: done, color: done ? C.teal : C.amber, align: 'right' });
  });
  card(s, M + 8.0, 1.95, 3.9, 3.48, 'F7F8F8');
  s.addText('完了の条件', { x: M + 8.35, y: 2.2, w: 3.2, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.ink });
  const cond = ['全員が秘書を日常的に使う', '定型処理 3 種が回る', '議事録が組織知識になる', '労務規定の照会が完結する', '削減時間が確認できる'];
  s.addText(cond.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < cond.length - 1 } })), {
    x: M + 8.35, y: 2.65, w: 3.2, h: 2.5, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, color: C.ink, paraSpaceAfter: 8 });
  s.addText('Phase 2 で関連会社、Phase 3 で限定外販、Phase 4 で一般提供。事例を作ってから外へ出す。', {
    x: M, y: 6.0, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.muted });
  s.addNotes('Phase 1 の完了条件は仕様書 第24.1節。');
}

/* 19. 後から作れないもの */
{
  const s = lightSlide('Phase 1 で守ること ｜ 後から作れないもの', '「今は作らないが、作れる形にしておく」項目');
  const items = [
    '画面と外部で同じ API を使う', 'LLM 抽象化層を最初から設ける',
    '2 段階認証の拡張点を用意する', '個人記憶と組織知識を分ける',
    '監査ログを全操作で記録する', 'ツール層を Google 非依存にする',
    'テナントから接続先を解決する層', '実行ごとのコストを記録する',
    'データに権限区画の属性を持たせる',
  ];
  items.forEach((t, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = M + col * 4.1, y = 2.0 + row * 1.0;
    card(s, x, y, 3.7, 0.82, 'F7F8F8');
    numberCircle(s, i + 1, x + 0.25, y + 0.16, 0.5, C.teal);
    s.addText(t, { x: x + 0.9, y: y + 0.13, w: 2.65, h: 0.55, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.ink, valign: 'middle' });
  });
  card(s, M, 5.15, 11.9, 1.1, C.tealLt);
  s.addText('混ざってから分けることは、できない。', {
    x: M + 0.45, y: 5.35, w: 11.0, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 17, bold: true, color: C.teal });
  s.addText('後付けが困難な箇所を洗い出して、最初から形だけ用意しておく。', {
    x: M + 0.45, y: 5.78, w: 11.0, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 13, color: C.ink });
  s.addNotes('仕様書 第24.2節。');
}

/* 20. 進め方 */
{
  const s = lightSlide('開発の進め方', '決めてあること。迷わないための土台');
  const rules = [
    { h: '仕様が先', t: '仕様にない機能を実装しない。\n先に仕様書を更新して合意する。' },
    { h: '迂回しない境界', t: 'テナント境界、承認ゲート、\n画面から DB を直接触らない。' },
    { h: 'JSDoc は必須', t: '型は TypeScript に、\nJSDoc には「なぜ」を書く。' },
    { h: 'README を必ず作る', t: '変更と同じコミットで直す。\n古い README は無いより有害。' },
  ];
  rules.forEach((v, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = M + col * 6.2, y = 1.95 + row * 1.75;
    card(s, x, y, 5.7, 1.5);
    s.addText(v.h, { x: x + 0.4, y: y + 0.2, w: 4.9, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 17, bold: true, color: C.teal });
    s.addText(v.t, { x: x + 0.4, y: y + 0.68, w: 4.9, h: 0.7, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: C.ink });
  });
  const docs = [['specification.md', '4,427 行・9 部 26 章'], ['docs/coding-standards.md', '開発規約'], ['docs/release-process.md', 'リリース規定'], ['docs/adr/', '設計判断の記録']];
  docs.forEach((d, i) => {
    const x = M + i * 3.05;
    s.addText(d[0], { x, y: 5.6, w: 2.9, h: 0.3, isTextBox: true, margin: 0,
      fontFace: MONO, fontSize: 11, bold: true, color: C.ink });
    s.addText(d[1], { x, y: 5.9, w: 2.9, h: 0.3, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 11, color: C.muted });
  });
  s.addNotes('文書は揃っている。読むところから始められる。');
}

/* 21. いまの状態 */
{
  const s = lightSlide('いまの状態', '仕様と骨組みは揃っている。ここから一緒に作る');
  const stats = [
    { n: '4,427', t: '行の仕様書\n9 部 26 章' },
    { n: '3,853', t: '行の TypeScript\n通しで動作' },
    { n: '26 / 55', t: '決定済みの論点\n残りは順次' },
    { n: '12', t: '設計の不変則\n破ってはならない境界' },
  ];
  stats.forEach((v, i) => {
    const x = M + i * 3.05;
    card(s, x, 2.1, 2.75, 2.3);
    s.addText(v.n, { x, y: 2.35, w: 2.75, h: 0.85, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 38, bold: true, color: C.teal, align: 'center' });
    s.addText(v.t, { x: x + 0.2, y: 3.3, w: 2.35, h: 0.9, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 12, color: C.ink, align: 'center' });
  });
  card(s, M, 4.75, 11.9, 1.3, 'F7F8F8');
  s.addText('次にやること', { x: M + 0.45, y: 4.95, w: 3, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 14, bold: true, color: C.ink });
  s.addText('Google 連携（OAuth）　→　AG-05 と定時実行　→　管理者ページと個人設定', {
    x: M + 0.45, y: 5.38, w: 11.0, h: 0.4, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 15, bold: true, color: C.teal });
  s.addNotes('B-2・B-3 の準備ができ次第、認証に着手する。');
}

/* 22. 結び */
{
  const s = darkSlide();
  s.addText('一緒に作りませんか', { x: M, y: 1.5, w: 10, h: 0.9, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 38, bold: true, color: C.white });
  const pts = [
    ['市場は空いている', '中小企業の 6 割以上が未着手。全社導入は 4.1%'],
    ['設計は固まっている', '9 部 26 章。判断の理由も記録してある'],
    ['骨組みは動いている', '最も難しい経路が、すでに通っている'],
    ['作る余地がある', 'エージェント、拡張機構、パートナー制度'],
  ];
  pts.forEach((v, i) => {
    const y = 2.75 + i * 0.92;
    numberCircle(s, i + 1, M, y, 0.52, '13514E');
    s.addText(v[0], { x: M + 0.8, y: y - 0.02, w: 9.5, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 19, bold: true, color: C.white });
    s.addText(v[1], { x: M + 0.8, y: y + 0.4, w: 9.5, h: 0.33, isTextBox: true, margin: 0,
      fontFace: F, fontSize: 13, color: 'A7C4C1' });
  });
  s.addText('株式会社M2ホールディングス　　もっと自由で楽しい世界を実現したい', {
    x: M, y: 6.6, w: 11, h: 0.35, isTextBox: true, margin: 0,
    fontFace: F, fontSize: 12, color: '7FA5A2' });
  s.addNotes('質疑へ。');
}

await p.writeFile({ fileName: 'M2Office_開発キックオフ.pptx' });
console.log('生成しました');
