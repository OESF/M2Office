/**
 * @file メールの署名から名刺を新しくする処理の単体テスト（仕様書 第27.6.1節、ADR-0057）。
 *
 * 差出人本人の部分の切り出し、ドメインの認証の見方、推論の答えの読み方、変わった項目だけを新しくする決まり
 * （署名に無い項目は消さない・戻した値を再び変えない・電話は同じ種類だけ置き換える）、戻す値の決め方を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_CARD_FIELDS, type Contact } from '@m2office/shared';
import {
  nameMatches, ownPart, parseSignature, revertPatch, senderAddress, signatureChanges, signatureLooksSame,
} from '../src/index.js';
import { senderAuthenticated } from '../src/connectors/google/mime.js';

const contact = (over: Partial<Contact> = {}): Contact => ({
  ...EMPTY_CARD_FIELDS, id: 'k1', tenantId: 't', scope: 'company', ownerUserId: 'u1', note: '', status: 'active', trashedAt: null,
  createdBy: 'u1', createdAt: '2026-09-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-09-01T00:00:00Z',
  name: '佐野 毅', company: '株式会社サンプル', department: '営業部', title: '課長',
  phones: [{ kind: 'main', number: '03-1111-2222' }, { kind: 'mobile', number: '090-1111-2222' }], emails: ['sano@sample.example'],
  ...over,
});

test('差出人本人の部分: 返信の引用と転送より前だけを使う', () => {
  const body = [
    'いつもお世話になっております。', '', '佐野 毅', '株式会社サンプル 営業本部 部長', '',
    '2026年9月30日(火) 10:00 山田 太郎 <yamada@other.example>:', '> 山田です', '> 株式会社別会社 部長',
  ].join('\n');
  const own = ownPart(body);
  assert.match(own, /営業本部 部長/);
  assert.doesNotMatch(own, /別会社/);
  assert.equal(ownPart('本文\n-----Original Message-----\nFrom: x'), '本文');
  assert.equal(ownPart('本文\nOn Tue, Sep 30, 2026 at 10:00 AM Taro <t@x.example> wrote:\n> 引用'), '本文');
  assert.equal(senderAddress('佐野 毅 <Sano@Sample.Example>'), 'sano@sample.example');
});

test('ドメインの認証: Gmail が付けた DMARC か、差出人のドメインに合う DKIM が通ったものだけ', () => {
  const h = (value: string) => [{ name: 'Authentication-Results', value }];
  assert.equal(senderAuthenticated(h('mx.google.com; dkim=pass header.i=@sample.example header.s=s1; spf=pass; dmarc=pass (p=NONE) header.from=sample.example'), 'sano@sample.example'), true);
  assert.equal(senderAuthenticated(h('mx.google.com; dkim=pass header.i=@mail.sample.example'), 'sano@sample.example'), false);
  assert.equal(senderAuthenticated(h('mx.google.com; dkim=pass header.d=sample.example'), 'sano@tokyo.sample.example'), true);
  // 別のドメインの DKIM・失敗・Gmail 以外が付けた結果は信じない
  assert.equal(senderAuthenticated(h('mx.google.com; dkim=pass header.i=@mailer.example; dmarc=fail header.from=sample.example'), 'sano@sample.example'), false);
  assert.equal(senderAuthenticated(h('relay.example; dmarc=pass header.from=sample.example'), 'sano@sample.example'), false);
  assert.equal(senderAuthenticated(undefined, 'sano@sample.example'), false);
});

test('推論を呼ばずに済むか: 署名の部分に今の会社名・部署・役職がそのまま見つかる', () => {
  assert.equal(signatureLooksSame('よろしくお願いします。\n佐野 毅\n株式会社サンプル\n営業部 課長', contact()), true);
  assert.equal(signatureLooksSame('よろしくお願いします。\n佐野 毅\n株式会社サンプル\n営業本部 部長', contact()), false);
  assert.equal(signatureLooksSame('佐野', contact({ company: '' })), false);
});

test('氏名: 空白・全角と半角を除いて比べ、ローマ字の併記も合うとする', () => {
  assert.equal(nameMatches('佐野毅', '佐野 毅'), true);
  assert.equal(nameMatches('佐野 毅 / Takeshi Sano', '佐野 毅'), true);
  assert.equal(nameMatches('山田 太郎', '佐野 毅'), false);
  assert.equal(nameMatches('', '佐野 毅'), false);
});

test('推論の答え: 署名が無ければ null。電話の種類と項目の名前を確かめる', () => {
  assert.equal(parseSignature('{"hasSignature": false}'), null);
  assert.equal(parseSignature('読めません'), null);
  const r = parseSignature('```json\n{"hasSignature": true, "name": "佐野 毅", "company": "株式会社サンプル", "title": "部長", '
    + '"phones": [{"kind": "direct", "number": "03-9999-0000"}, {"kind": "pager", "number": "1"}], "changed": ["title", "phones", "name"]}\n```');
  assert.ok(r);
  assert.equal(r.title, '部長');
  assert.deepEqual(r.phones, [{ kind: 'direct', number: '03-9999-0000' }]);
  assert.deepEqual(r.changed, ['title', 'phones']);
});

test('新しくする項目: 変わったと判断した項目だけ。署名に無い項目は消さず、表記だけの違いは変えない', () => {
  const reading = {
    name: '佐野 毅', company: '株式会社サンプル', department: '', title: '部長', postalCode: '', address: '', website: '',
    phones: [{ kind: 'direct' as const, number: '03-9999-0000' }, { kind: 'main' as const, number: '03(1111)2222' }],
    changed: ['title', 'phones', 'company'] as ('title' | 'phones' | 'company')[],
  };
  const { patch, fields, seen } = signatureChanges(contact(), reading, {});
  assert.deepEqual(patch.title, '部長');
  assert.equal(patch.department, undefined);
  // 会社名は今の値と同じ（changed に入っていても変えない）
  assert.equal(patch.company, undefined);
  // 直通を足し、代表は数字が同じなので置き換えない。携帯は残す
  assert.deepEqual(patch.phones, [
    { kind: 'main', number: '03-1111-2222' }, { kind: 'mobile', number: '090-1111-2222' }, { kind: 'direct', number: '03-9999-0000' },
  ]);
  assert.deepEqual(fields.title, { before: '課長', after: '部長' });
  assert.ok(seen['title'] && seen['phones']);
});

test('戻した値: 署名が同じ値を示している間は再び変えず、署名が変わったら改めて比べる', () => {
  const reading = {
    name: '佐野 毅', company: '', department: '', title: '部長', postalCode: '', address: '', website: '', phones: [], changed: ['title' as const],
  };
  const first = signatureChanges(contact(), reading, {});
  assert.equal(first.patch.title, '部長');
  // 人が「課長」に戻した後、同じ署名が届いても変えない
  const again = signatureChanges(contact({ title: '課長' }), reading, { seen: first.seen });
  assert.deepEqual(again.fields, {});
  // 署名が「本部長」に変われば新しくする
  const later = signatureChanges(contact({ title: '課長' }), { ...reading, title: '本部長' }, { seen: first.seen });
  assert.equal(later.patch.title, '本部長');
});

test('戻す値: 今の値が署名から変えた値のままの項目だけを前の値に戻す', () => {
  const fields = {
    title: { before: '課長', after: '部長' },
    department: { before: '営業部', after: '営業本部' },
    phones: { before: [{ kind: 'main' as const, number: '03-1111-2222' }], after: [{ kind: 'main' as const, number: '03-5555-6666' }] },
  };
  // 部署はその後に人が直した（署名の値ではない）ので戻さない
  const now = contact({ title: '部長', department: '第二営業部', phones: [{ kind: 'main', number: '03-5555-6666' }] });
  assert.deepEqual(revertPatch(now, fields), { title: '課長', phones: [{ kind: 'main', number: '03-1111-2222' }] });
});
