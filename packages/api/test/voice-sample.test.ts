/**
 * @file 声を試す（`speakSample`）の単体テスト。
 *
 * 実際の音声の対話と同じ名乗りの指示と声で開くこと、挨拶だけを頼むこと、
 * 話し終わりで声と文字を集めて閉じること、声が返らなければ失敗にすることを確かめる。
 *
 * @see 仕様書 第10.5.8節 声を試す
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VoiceProvider, VoiceSessionOptions } from '@m2office/core';
import { personaLines, voiceNameOf, type VoicePersona } from '../src/voice/persona.js';
import { sampleNote, speakSample } from '../src/voice/sample.js';

const PERSONA: VoicePersona = {
  org: 'アルファ商事',
  displayName: '三浦雅孝',
  secretary: { name: 'みどり', callMe: '', style: 'polite', voiceStyle: '関西弁で話して' },
};

/** 開いたときの指示と送られた内部の指示を控え、決めた出来事を返す提供者。 */
function fakeProvider(reply: (o: VoiceSessionOptions) => void) {
  const seen: { options?: VoiceSessionOptions; notes: string[]; closed: number } = { notes: [], closed: 0 };
  const provider: VoiceProvider = {
    name: 'fake',
    async open(options) {
      seen.options = options;
      return {
        sendAudio() { /* マイクは使わない */ },
        sendText() { /* 使わない */ },
        sendSystemNote(text) {
          seen.notes.push(text);
          queueMicrotask(() => reply(options));
        },
        close() { seen.closed++; },
      };
    },
  };
  return { provider, seen };
}

test('実際の対話と同じ名乗りの指示と声で開き、挨拶の声と文字を集めて閉じる', async () => {
  const { provider, seen } = fakeProvider((o) => {
    o.onEvent({ type: 'reply', text: '三浦雅孝さん、秘書のみどりです。' });
    o.onEvent({ type: 'audio', pcm: new Uint8Array([1, 0, 2, 0]) });
    o.onEvent({ type: 'reply', text: 'よろしゅうお願いします。' });
    o.onEvent({ type: 'audio', pcm: new Uint8Array([3, 0]) });
    o.onEvent({ type: 'turn-end' });
  });
  const r = await speakSample(provider, PERSONA, voiceNameOf('Kore'));
  assert.equal(seen.options?.speak, true);
  assert.equal(seen.options?.voice, 'Kore');
  assert.equal(seen.options?.tools, undefined, '道具は渡さない');
  for (const line of personaLines(PERSONA)) assert.ok(seen.options?.instructions.includes(line), '名乗りの指示は実際の対話と同じ');
  assert.ok(seen.options?.instructions.includes('話し方の指定: 関西弁で話して'));
  assert.equal(seen.notes.length, 1);
  assert.match(seen.notes[0]!, /「三浦雅孝さん」と呼ぶ/, '呼ばれ方が未設定なら表示名さん');
  assert.match(seen.notes[0]!, /秘書の「みどり」だと名乗る/);
  assert.equal(r.text, '三浦雅孝さん、秘書のみどりです。よろしゅうお願いします。');
  assert.deepEqual([...r.pcm], [1, 0, 2, 0, 3, 0]);
  assert.equal(seen.closed, 1, '話し終わったら閉じる');
});

test('名前が未設定なら名乗らない。一覧に無い声は渡さない', () => {
  const note = sampleNote({ ...PERSONA, secretary: { ...PERSONA.secretary, name: '', callMe: '雅孝さん' } });
  assert.match(note, /名乗らずに「秘書です」/);
  assert.match(note, /「雅孝さん」と呼ぶ/);
  assert.equal(voiceNameOf('どこにもない声'), '');
});

test('選んだ声が使えなかった断り書きを返す', async () => {
  const { provider } = fakeProvider((o) => {
    o.onEvent({ type: 'note', text: '選んだ声が使えなかったため、既定の声で話します' });
    o.onEvent({ type: 'audio', pcm: new Uint8Array([1, 0]) });
    o.onEvent({ type: 'turn-end' });
  });
  const r = await speakSample(provider, PERSONA, '');
  assert.deepEqual(r.notes, ['選んだ声が使えなかったため、既定の声で話します']);
});

test('声も文字も返らずに終われば失敗にする。上限の時間で打ち切って閉じる', async () => {
  const { provider, seen } = fakeProvider(() => { /* 何も返さない */ });
  await assert.rejects(speakSample(provider, PERSONA, '', 50), /返ってきませんでした/);
  assert.equal(seen.closed, 1);
  const failing: VoiceProvider = { name: 'down', open: async () => { throw new Error('接続できません'); } };
  await assert.rejects(speakSample(failing, PERSONA, '', 50), /接続できません/);
});
