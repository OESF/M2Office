/**
 * @file 名刺の表（CSV・Excel）の読み書きの単体テスト（仕様書 第27.4節「表から取り込む」・第27.10節「書き出し」）。
 *
 * よくある見出しの言い方の読み方、姓と名・住所の分かれた列のつなぎ方、日付の読み方、書き出した表を取り込み直せることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_CARD_FIELDS, type Contact } from '@m2office/shared';
import { CARD_EXPORT_COLUMNS, cardFromRow, exportRow, mapCardHeaders, mapCardHeadersByWords, tableDate } from '../src/index.js';

const TODAY = '2026-10-01';

test('見出し: 名刺サービスの書き出しによくある言い方を、推論なしで読む', () => {
  const headers = ['会社名', '部署名', '役職', '姓', '名', '姓(カナ)', '名(カナ)', 'e-mail', '郵便番号', '住所1', '住所2', 'TEL会社', 'TEL直通', 'Fax', '携帯電話', 'URL', '名刺交換日', 'メモ', '登録者'];
  assert.deepEqual(mapCardHeadersByWords(headers), [
    'company', 'department', 'title', 'lastName', 'firstName', 'lastKana', 'firstKana', 'email', 'postalCode', 'address', 'address',
    'phoneMain', 'phoneDirect', 'fax', 'phoneMobile', 'website', 'receivedOn', 'note', 'ignore',
  ]);
  // 1 つだけの項目は、2 つ目の列に当てない（推論に回す）
  assert.deepEqual(mapCardHeadersByWords(['氏名', '名前']), ['name', null]);
});

test('見出し: 推論が使えなければ、読めた列だけを使う', async () => {
  assert.deepEqual(await mapCardHeaders(['氏名', 'よくわからない列'], null), ['name', null]);
});

test('行: 姓と名・ふりがな（カタカナはひらがなに）・住所をつなぎ、電話を種類ごとに、メールアドレスを分けて読む', () => {
  const mapping = mapCardHeadersByWords(['姓', '名', 'セイ', 'メイ', '会社名', '住所1', '住所2', 'TEL', '携帯', 'メール', '郵便番号', '名刺交換日', '備考']);
  const r = cardFromRow(['山田', '太郎', 'ヤマダ', 'タロウ', '株式会社サンプル', '東京都千代田区', '1-2-3 ビル 4F', '03-1111-2222', '090-3333-4444',
    'Taro@Sample.example; t.yamada@sample.example', '１００－０００１', '2024/4/1', '展示会で'], mapping, TODAY);
  assert.ok(r);
  assert.equal(r.fields.name, '山田 太郎');
  assert.equal(r.fields.nameKana, 'やまだ たろう');
  assert.equal(r.fields.address, '東京都千代田区 1-2-3 ビル 4F');
  assert.deepEqual(r.fields.phones, [{ kind: 'main', number: '03-1111-2222' }, { kind: 'mobile', number: '090-3333-4444' }]);
  assert.deepEqual(r.fields.emails, ['taro@sample.example', 't.yamada@sample.example']);
  assert.equal(r.fields.postalCode, '100-0001');
  assert.equal(r.receivedOn, '2024-04-01');
  assert.equal(r.note, '展示会で');
  // 氏名も会社名も無い行は名刺にしない
  assert.equal(cardFromRow(['', '', '', '', '', '', '', '03-1', '', '', '', '', ''], mapping, TODAY), null);
});

test('日付: 区切りの違い・年月日・Excel の日数を読み、今日より後と形の違うものは読まない', () => {
  assert.equal(tableDate('2024-4-1', TODAY), '2024-04-01');
  assert.equal(tableDate('2024年12月31日', TODAY), '2024-12-31');
  assert.equal(tableDate(45383, TODAY), '2024-04-01', 'Excel の日数');
  assert.equal(tableDate('2024-02-30', TODAY), null, '無い日');
  assert.equal(tableDate('2027-01-01', TODAY), null, '今日より後');
  assert.equal(tableDate('先週', TODAY), null);
});

test('書き出し: 書き出した表は、見出しのとおりに取り込み直せる', () => {
  const contact: Contact = {
    ...EMPTY_CARD_FIELDS, id: 'ct-1', tenantId: 't', scope: 'company', ownerUserId: 'u', note: 'メモの文',
    name: '佐藤 花子', nameKana: 'さとう はなこ', company: 'A社', department: '営業部', title: '部長', postalCode: '100-0001', address: '東京都',
    phones: [{ kind: 'main', number: '03-1' }, { kind: 'direct', number: '03-2' }, { kind: 'mobile', number: '090-1' }, { kind: 'fax', number: '03-9' }],
    emails: ['a@a.example', 'b@a.example'], website: 'https://a.example', extra: 'X: @hanako',
    status: 'active', trashedAt: null, createdBy: 'u', createdAt: '', updatedBy: 'u', updatedAt: '',
  };
  const row = exportRow(contact, '2025-05-05', '管理者');
  const mapping = mapCardHeadersByWords(CARD_EXPORT_COLUMNS);
  assert.ok(!mapping.includes(null), `読めない見出し: ${CARD_EXPORT_COLUMNS.filter((_, i) => mapping[i] === null).join('、')}`);
  const back = cardFromRow(row, mapping, TODAY);
  assert.ok(back);
  const { kanaEstimated: _k, ...want } = { ...EMPTY_CARD_FIELDS, ...contact };
  for (const k of ['name', 'nameKana', 'company', 'department', 'title', 'postalCode', 'address', 'phones', 'emails', 'website', 'extra'] as const) {
    assert.deepEqual(back.fields[k], want[k], k);
  }
  assert.equal(back.note, 'メモの文');
  assert.equal(back.receivedOn, '2025-05-05');
});
