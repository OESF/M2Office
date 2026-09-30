/**
 * @file 名刺管理（内蔵の拡張）の単体テスト。読み取り結果の解釈、同じ人の見分け、項目のまとめ方、形式の判定、PDF の分け方、vCard、秘書の見分け。
 *
 * @see 仕様書 第27章 名刺管理
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { EMPTY_CARD_FIELDS, type CardFields } from '@m2office/shared';
import {
  dateIn, detectCardKind, flowRotation, judgeSamePerson, mergeFields, orderCorners, parseCardReading, parseLocations, splitCardPdf, toVCard, canManage,
  type LlmProvider,
} from '../src/index.js';
import { contactRequest } from '../src/secretary/contacts.js';
import { DIRECT_QUERIES } from '../src/secretary/catalog.js';
import { mailCheckRequest, mailCheckText, parseMailVerdicts, senderName } from '../src/secretary/mail.js';

const fields = (over: Partial<CardFields>): CardFields => ({ ...EMPTY_CARD_FIELDS, ...over });

test('読み取り結果: 項目ごとに取り出し、形の違う値は捨て、無い項目は空のままにする', () => {
  const r = parseCardReading(JSON.stringify({
    isCard: true, cardCount: 2, rotation: 90, side: 'front', name: ' 田中 太郎 ', nameKana: 'たなか たろう', kanaEstimated: true,
    company: '株式会社サンプル', postalCode: '〒１０００００１', phones: [{ kind: 'mobile', number: '090-1111-2222' }, { kind: 'x', number: '03-0000-0000' }, { number: '' }],
    emails: ['Tanaka@Sample.EXAMPLE', 'not-an-email'], website: 42, unknown: 'x',
  }));
  assert.equal(r.kind, 'card');
  if (r.kind !== 'card') return;
  const c = r.cards[0]!;
  assert.equal(r.cards.length, 1, '名刺ごとの配列の無い答え（以前の形）は 1 枚として読む');
  assert.equal(c.fields.name, '田中 太郎');
  assert.equal(c.fields.postalCode, '100-0001', '全角の数字と〒をそろえる');
  assert.deepEqual(c.fields.phones, [{ kind: 'mobile', number: '090-1111-2222' }, { kind: 'main', number: '03-0000-0000' }]);
  assert.deepEqual(c.fields.emails, ['tanaka@sample.example']);
  assert.equal(c.fields.website, '', '文字列でない値は空にする');
  assert.equal(c.fields.department, '', '名刺に無い項目は推測で埋めない');
  assert.equal(c.rotation, 90);
  assert.equal(c.corners, null, '四隅の無い答えは写真全体を出す');
  assert.equal(r.truncated, false);
  assert.equal(c.fields.kanaEstimated, true);
});

test('読み取り結果: 名刺でない・氏名も会社名も無い・JSON でないものは登録しない', () => {
  assert.equal(parseCardReading('{"isCard": false}').kind, 'not-card');
  assert.equal(parseCardReading('{"isCard": true, "title": "部長"}').kind, 'not-card');
  assert.equal(parseCardReading('読めませんでした').kind, 'not-card');
  // 前後に文が付いていても JSON の部分を読む
  assert.equal(parseCardReading('結果: {"isCard": true, "company": "A社"} 以上').kind, 'card');
  // 変な角度は 0 にする
  const r = parseCardReading('{"isCard": true, "name": "A", "rotation": 45}');
  assert.equal(r.kind === 'card' && r.cards[0]!.rotation, 0);
  // 文字の上側の向きから、時計回りに回す角度を決める
  const turn = (top: string) => { const x = parseCardReading(`{"isCard": true, "name": "A", "textTop": "${top}"}`); return x.kind === 'card' ? x.cards[0]!.rotation : -1; };
  assert.deepEqual(['up', 'left', 'down', 'right'].map(turn), [0, 90, 180, 270]);
  // 英数字の行が画像の中で進む向きから決める（文字の上側より確か。第27.5節）。両方あれば行の向きを採る
  const flow = (f: string) => { const x = parseCardReading(`{"isCard": true, "name": "A", "lineFlow": "${f}", "textTop": "up"}`); return x.kind === 'card' ? x.cards[0]!.rotation : -1; };
  assert.deepEqual(['left-to-right', 'top-to-bottom', 'right-to-left', 'bottom-to-top'].map(flow), [0, 270, 180, 90]);
  assert.equal(flowRotation('{"lineFlow": "top-to-bottom"}'), 270);
  assert.equal(flowRotation('{"lineFlow": "diagonal"}'), null);
  assert.equal(flowRotation('読めません'), null);
});

test('1 枚の写真の何枚もの名刺: 名刺ごとに項目・向き・四隅を読み、氏名も会社名も無いものは除き、10 枚を超えたら知らせる（第27.4節）', () => {
  const card = (name: string, extra: object = {}) => ({ name, company: 'A社', textTop: 'up', corners: [[100, 100], [450, 100], [450, 300], [100, 300]], ...extra });
  const r = parseCardReading(JSON.stringify({ isCard: true, cardCount: 3, cards: [card('田中'), { title: '部長' }, card('佐藤', { textTop: 'down', corners: [[900, 900], [550, 900], [550, 700], [900, 700]] })] }));
  assert.equal(r.kind, 'card');
  if (r.kind !== 'card') return;
  assert.deepEqual(r.cards.map((c) => c.fields.name), ['田中', '佐藤'], '氏名も会社名も無いものは名刺にしない');
  assert.deepEqual(r.cards[0]!.corners, [[100, 100], [450, 100], [450, 300], [100, 300]]);
  assert.equal(r.cards[1]!.rotation, 180);
  assert.deepEqual(r.cards[1]!.corners, [[900, 900], [550, 900], [550, 700], [900, 700]], '逆さの名刺は、文字の左上が画像の右下に来る');
  const many = parseCardReading(JSON.stringify({ isCard: true, cardCount: 12, cards: Array.from({ length: 12 }, (_, i) => card(`名前${i}`)) }));
  assert.ok(many.kind === 'card' && many.cards.length === 10 && many.truncated);
});

test('四隅: 文字の向きに合う並びに回し直し、裏返しの順を直し、画像の外・へこんだ形・小さすぎるものは捨てる', () => {
  const upright = [[100, 100], [500, 100], [500, 350], [100, 350]];
  // 推論が並びを 1 つずらして答えても、正しい向き（回さない）なら左上から始まる並びにする
  assert.deepEqual(orderCorners([upright[2], upright[3], upright[0], upright[1]], 0), upright);
  // 反時計回りの順も直す
  assert.deepEqual(orderCorners([upright[0], upright[3], upright[2], upright[1]], 0), upright);
  // 90 度回す（文字の上側が左）なら、左上から右上へ向かう辺が画像の上向きになる並び
  assert.deepEqual(orderCorners(upright, 90), [[100, 350], [100, 100], [500, 100], [500, 350]]);
  assert.equal(orderCorners([[0, 0], [1100, 0], [1000, 1000], [0, 1000]], 0), null, '画像の外');
  assert.equal(orderCorners([[0, 0], [500, 400], [1000, 0], [500, 1000]], 0), null, 'へこんだ四角形');
  assert.equal(orderCorners([[0, 0], [100, 0], [100, 100], [0, 100]], 0), null, '写真の 2% 未満');
  assert.equal(orderCorners([[0, 0], [1, 0]], 0), null);
});

test('位置と向きの答え: [y, x] の点を [x, y] にし、英数字の行の向きで並べ、四隅が使えなければ囲む範囲から作る（第27.5節）', () => {
  // 2026-09-30 に本番の写真で高性能のモデルが返した答え（逆さの名刺 2 枚）
  const two = parseLocations('{"cards":[{"name":"楠本 和弘","box_2d":[76,325,442,794],"corners":[[76,328],[76,789],[442,792],[442,325]],"lineFlow":"right-to-left"},'
    + '{"name":"佐野 毅","box_2d":[520,313,919,793],"corners":[[520,319],[546,792],[918,775],[894,314]],"lineFlow":"right-to-left"}]}');
  assert.deepEqual(two.map((l) => l.rotation), [180, 180]);
  assert.deepEqual(two[0]!.corners, [[792, 442], [325, 442], [328, 76], [789, 76]], '逆さなので、文字の左上は画像の右下');
  // 横倒し（上から下へ進む）
  const side = parseLocations('{"cards":[{"name":"小原 勝利","box_2d":[17,153,835,810],"corners":[[17,158],[44,807],[819,798],[833,157]],"lineFlow":"top-to-bottom"}]}');
  assert.equal(side[0]!.rotation, 270);
  assert.deepEqual(side[0]!.corners![0], [807, 44], '文字の左上は画像の右上');
  // 四隅が使えなければ囲む範囲（入れ子でも読む）
  const box = parseLocations('{"cards":[{"name":"A","box_2d":[[100,100,500,700]],"corners":[[0,0],[1,1]]}]}');
  assert.deepEqual(box[0]!.corners, [[100, 100], [700, 100], [700, 500], [100, 500]]);
  assert.equal(box[0]!.rotation, null);
  assert.deepEqual(parseLocations('読めません'), []);
});

test('新しい名刺は現在の値になり、古い名刺は空の項目を埋めるだけ。名刺に無い項目で今の値を消さない', () => {
  const current = fields({ name: '田中 太郎', company: 'A社', title: '課長', phones: [{ kind: 'main', number: '03-1' }], emails: ['t@a.example'] });
  const card = fields({ name: '田中 太郎', company: 'A社', title: '部長', department: '営業部', phones: [{ kind: 'mobile', number: '090-1' }] });
  const newer = mergeFields(current, card, true);
  assert.equal(newer.title, '部長');
  assert.equal(newer.department, '営業部');
  assert.deepEqual(newer.phones?.map((p) => p.number), ['090-1', '03-1'], '新しい名刺の番号を先に、古い番号も残す');
  assert.equal(newer.emails, undefined, 'メールアドレスが無い名刺で、今のアドレスを消さない');
  const older = mergeFields(current, card, false);
  assert.equal(older.title, undefined, '古い名刺は今の役職を上書きしない');
  assert.equal(older.department, '営業部', '空の項目は埋める');
});

test('同じ人の判断: 推論が「確か」と答えたときだけまとめる。答えが読めなければまとめない', async () => {
  const llm = (text: string): LlmProvider => ({ name: 'fake', complete: async () => ({ text, tokensUsed: 1 }) });
  const a = fields({ name: '田中', company: 'A社' });
  assert.equal(await judgeSamePerson(llm('{"same": true, "sure": true}'), a, a), true);
  assert.equal(await judgeSamePerson(llm('{"same": true, "sure": false}'), a, a), false);
  assert.equal(await judgeSamePerson(llm('わかりません'), a, a), false);
  const failing: LlmProvider = { name: 'x', complete: async () => { throw new Error('down'); } };
  assert.equal(await judgeSamePerson(failing, a, a), false, '推論が使えなければ別の連絡先にする');
});

test('名刺の形式: 拡張子と中身の先頭の両方で確かめる。HEIC・WebP も受け付ける', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  assert.equal(detectCardKind('a.jpg', bytes(0xff, 0xd8, 0xff)), 'jpeg');
  assert.equal(detectCardKind('a.png', bytes(0x89, 0x50, 0x4e, 0x47)), 'png');
  assert.equal(detectCardKind('a.webp', bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'))), 'webp');
  assert.equal(detectCardKind('IMG_0001.HEIC', bytes(0, 0, 0, 24, ...ascii('ftypheic'))), 'heic');
  assert.equal(detectCardKind('a.jpg', bytes(0x89, 0x50, 0x4e, 0x47)), null, '拡張子と中身が違えば受け付けない');
  assert.equal(detectCardKind('a.xlsx', bytes(0x50, 0x4b, 3, 4)), null);
});

test('PDF は 1 ページを 1 枚の名刺に分ける（画像が埋め込まれていなければページだけの PDF）', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([255, 155]).drawText('card 1');
  doc.addPage([255, 155]).drawText('card 2');
  const pages = await splitCardPdf(await doc.save());
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p) => [p.page, p.kind]), [[1, 'pdf'], [2, 'pdf']]);
  assert.equal((await PDFDocument.load(pages[1]!.bytes)).getPageCount(), 1);
  assert.deepEqual(await splitCardPdf(new Uint8Array([1, 2, 3])), [], '開けない PDF は空');
});

test('vCard: 区切りの文字を逃がし、空の項目は書かない', () => {
  const v = toVCard({
    ...fields({ name: '田中 太郎', nameKana: 'たなか', company: 'A社; 本社', title: '部長', phones: [{ kind: 'fax', number: '03-9' }], emails: ['t@a.example'] }),
    note: '展示会,で会った',
  });
  assert.match(v, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nFN:田中 太郎/);
  assert.match(v, /ORG:A社\\; 本社/);
  assert.match(v, /TEL;TYPE=WORK,FAX:03-9/);
  assert.match(v, /NOTE:展示会\\,で会った/);
  assert.doesNotMatch(v, /URL:|ADR/);
  assert.ok(v.endsWith('END:VCARD\r\n'));
});

test('範囲の変更・消去ができるのは、取り込んだ本人と、会社で共有のものは管理者', () => {
  const admin = { id: 'u-admin', roles: ['admin'] };
  const other = { id: 'u-other', roles: ['member'] };
  assert.equal(canManage({ scope: 'company', ownerUserId: 'u1' }, { id: 'u1', roles: [] }), true);
  assert.equal(canManage({ scope: 'company', ownerUserId: 'u1' }, admin), true);
  assert.equal(canManage({ scope: 'company', ownerUserId: 'u1' }, other), false);
  assert.equal(canManage({ scope: 'personal', ownerUserId: 'u1' }, admin), false, '自分だけの名刺は管理者も扱えない');
});

test('秘書の見分け: 名刺を探す依頼・直す依頼・名刺と関係ない依頼', () => {
  assert.equal(contactRequest('〇〇社の田中さんの電話番号は？'), 'ask');
  assert.equal(contactRequest('先週名刺交換した人を教えて'), 'ask');
  assert.equal(contactRequest('山田さんのメールアドレスを教えて'), 'ask');
  assert.equal(contactRequest('田中さんの電話番号を 03-1234-5678 に直して'), 'fix');
  assert.equal(contactRequest('田中さんは展示会で会った、とメモして'), 'fix');
  assert.equal(contactRequest('田中さんにメールを送って'), null, '送る依頼は名刺の依頼にしない');
  assert.equal(contactRequest('佐々木さんの名刺は 9 月 25 日の展示会でもらった'), 'fix', '受け取った日を告げる文は直す依頼');
  assert.equal(contactRequest('田中さんの名刺は昨日受け取った'), 'fix');
  assert.equal(contactRequest('先週名刺をもらった人は？'), 'ask', '誰かを尋ねる文は探す依頼');
  assert.equal(contactRequest('明日の予定は？'), null);
  assert.equal(contactRequest('会議の議事録を作って'), null);
  // 音声の秘書が画面に出すよう渡す、尋ねる言い回しの無い名詞の形（2026-09-29 に未読メールの件数を答えていた）
  assert.equal(contactRequest('佐々木美穂さんの連絡先情報（メールアドレス・住所など）'), 'ask');
  assert.equal(contactRequest('佐々木さんの電話番号'), 'ask');
  assert.equal(contactRequest('佐々木さんのメールアドレスに資料を送って'), null, '送る依頼は名刺の依頼にしない');
});

test('メールの確認は件数の答えに当てず、振り分けて案内する調べものに回す', () => {
  const match = (m: string) => DIRECT_QUERIES.find((q) => q.patterns.some((p) => p.test(m)) && !q.excludes?.some((p) => p.test(m)))?.id;
  for (const m of ['もう一度メールチェックしてください', 'メールを確認して', '大事なメールある？', '何かメール来てる？', '受信箱を見て']) {
    assert.equal(mailCheckRequest(m), true, m);
    assert.equal(match(m), undefined, `${m} は件数の答えにしない`);
  }
  for (const m of ['未読のメールは何件？', '未読メールは？']) {
    assert.equal(mailCheckRequest(m), false, m);
    assert.equal(match(m), 'mail-unread', `${m} は件数で答える`);
  }
  assert.equal(mailCheckRequest('確認したメールに返信の下書きを作って'), false, '書く依頼は受信箱整理へ');
  assert.equal(mailCheckRequest('佐々木さんのメールアドレスを確認して'), false, '連絡先の問いは名刺へ');
  assert.equal(mailCheckRequest('返信待ちのメールを確認して'), false, '返信待ちは「返信待ちの追跡」へ');
});

test('メールの確認: 推論の振り分けを読み、返信・対応が要るものを先に、宣伝は差出人だけで案内する', () => {
  const mails = [
    { from: 'Bvlgari <news@bvlgari.example>', subject: '新作のご案内' },
    { from: '"佐藤 一郎" <sato@example.jp>', subject: '見積もりのご確認' },
    { from: '楽天証券 <info@rakuten.example>', subject: 'ログインがありました' },
    { from: 'Dan <dan@example.com>', subject: 'Re: PR #1' },
  ];
  const verdicts = parseMailVerdicts('```json\n{"items": [{"i": 0, "group": "promo"}, {"i": 1, "group": "reply", "reason": "見積もりの返事", "due": "10/3"}, {"i": 2, "group": "action", "reason": "心当たりを確認"}, {"i": 9, "group": "reply"}]}\n```', mails.length);
  assert.deepEqual(verdicts.map((v) => v.group), ['promo', 'reply', 'action', 'read'], '返ってこなかった 1 通は「目を通すだけ」');
  const text = mailCheckText(mails, verdicts, 30, false);
  assert.match(text, /^未読は 30 件です。返信・対応が要るものは 2 件です。/);
  assert.ok(text.indexOf('**返信が要る') < text.indexOf('**対応が要る') && text.indexOf('**対応が要る') < text.indexOf('**目を通すだけ'), '返信・対応が先');
  assert.match(text, /佐藤 一郎 — 見積もりのご確認（見積もりの返事・期限 10\/3）/);
  assert.match(text, /宣伝・お知らせ（1）\*\*\nBvlgari$/m, '宣伝は差出人だけ');
  assert.match(text, /ほかに 26 件の未読は見ていません/);
  assert.deepEqual(parseMailVerdicts('読めない答え', 2).map((v) => v.group), ['read', 'read'], '読めなければ推測で返信にしない');
  assert.equal(senderName('"山田 太郎" <a@b.jp>'), '山田 太郎');
});

test('未読メールの定型の答えは、人の連絡先を尋ねる依頼に当てない', () => {
  const match = (m: string) => DIRECT_QUERIES.find((q) => q.patterns.some((p) => p.test(m)) && !q.excludes?.some((p) => p.test(m)))?.id;
  assert.equal(match('佐々木美穂さんの連絡先情報（メールアドレス・住所など）'), undefined);
  assert.equal(match('山田さんのメアドは？'), undefined);
  assert.equal(match('未読のメールは？'), 'mail-unread', '未読メールの問いには答える');
});

test('今日の日付は本人のタイムゾーンで決める（世界標準時では日本の朝が前の日になる）', () => {
  // 日本時間 2026-09-28 06:00 は、世界標準時では 9 月 27 日
  const at = new Date('2026-09-27T21:00:00Z');
  assert.equal(dateIn('Asia/Tokyo', at), '2026-09-28');
  assert.equal(dateIn('UTC', at), '2026-09-27');
  assert.equal(dateIn('Not/AZone', at), '2026-09-28', '知らないタイムゾーンは日本時間');
});

test('お礼のメール: 推論が使えなければ定型の文。本日・先日を受け取った日で決め、署名を付ける', async () => {
  const { draftThanksMail } = await import('../src/index.js');
  const input = {
    contact: { name: '佐々木 美穂', company: '株式会社さくら', department: '', title: '', note: '' },
    receivedOn: '2026-09-28', today: '2026-09-28', senderName: '三浦', companyName: 'OESF',
    style: { selfReference: '当法人', greeting: '', closing: '', signature: '---\nOESF 三浦', terms: [], notes: '' },
  };
  const t = await draftThanksMail(null, input);
  assert.match(t.subject, /名刺交換のお礼/);
  assert.match(t.body, /^株式会社さくら\n佐々木 美穂 様/);
  assert.match(t.body, /本日は名刺を交換/);
  assert.match(t.body, /当法人をどうぞ/);
  assert.match(t.body, /OESF 三浦$/);
  assert.match((await draftThanksMail(null, { ...input, receivedOn: '2026-09-01' })).body, /先日は/);
  const broken = { name: 'x', complete: async () => ({ text: '書けませんでした', tokensUsed: 1 }) };
  assert.deepEqual(await draftThanksMail(broken, input), t, '推論の答えが読めなければ定型の文');
});
