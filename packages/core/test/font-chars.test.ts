/**
 * @file 同梱の書体に無い字の置き換えの単体テスト。住所の「１９−１３」のマイナス記号が四角や〓にならないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBundledFontChars } from '../src/files/font-chars.js';
import { missingCharacters } from '../src/files/pdf-render.js';

test('JIS の正式な対応の字を、同梱の書体にある同じ形の字にする', async () => {
  assert.equal(toBundledFontChars('東京都江東区東砂７丁目１９−１３'), '東京都江東区東砂７丁目１９－１３');
  assert.equal(toBundledFontChars('‖¢£¬'), '∥￠￡￢');
  assert.equal(toBundledFontChars('ふつうの文 1-2'), 'ふつうの文 1-2');
  // 置き換えた後は、書体に無い字として数えない
  assert.deepEqual(await missingCharacters(['東砂７丁目１９−１３', '¢£']), []);
});
