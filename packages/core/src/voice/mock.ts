/**
 * @file 鍵が無い環境の、見本の音声の対話（仕様書 第10.5.4節、ADR-0018 決定 7）。
 *
 * 音声は返さない。聞こえた文字と応答の文字だけを返し、画面と中継を通しで動かせるようにする。
 * それらしい音声や、それらしい聞き取りの結果を作らない（第12.9.4節と同じ考え方）。
 */

import type { VoiceProvider, VoiceSession, VoiceSessionOptions } from './provider.js';

/**
 * 見本の応答の文。選んだ声と話し方の指示を書き添えて、設定が届いていることを確かめられるようにする。
 *
 * @remarks それらしい音声は作らない（ADR-0018 決定 7）。
 */
function sampleReply(session: VoiceSessionOptions): string {
  const chosen = [
    session.voice ? `声「${session.voice}」` : '',
    session.instructions.includes('話し方の指定:') ? '話し方の指示' : '',
  ].filter(Boolean).join('と');
  return [
    '［見本の応答］鍵が設定されていないため、音声の対話は行えません。文字でお尋ねください。',
    chosen ? `（${chosen}を受け取りました。鍵の設定後に反映されます）` : '',
  ].join('');
}

/** 見本の応答を返すまでの待ち（ミリ秒）。話し終わりの区切りに使う。 */
const REPLY_DELAY_MS = 300;

/**
 * 見本の音声の対話。
 *
 * @remarks 本番では使わない。鍵が設定されていないときに選ばれる。
 */
export class MockVoiceProvider implements VoiceProvider {
  readonly name = 'mock';

  async open(session: VoiceSessionOptions): Promise<VoiceSession> {
    let chunks = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    /** 話が途切れたら、聞こえた形と見本の応答を返す。 */
    const replyLater = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (closed) return;
        // 何を話したかは分からない。分かるのは受け取った量だけであり、それを正直に返す
        session.onEvent({ type: 'heard', text: `［見本］音声を ${chunks} 区切り受け取りました（文字にはしていません）` });
        session.onEvent({ type: 'reply', text: sampleReply(session) });
        session.onEvent({ type: 'turn-end' });
        chunks = 0;
      }, REPLY_DELAY_MS);
    };

    return {
      sendAudio() {
        chunks++;
        replyLater();
      },
      sendText(text) {
        session.onEvent({ type: 'heard', text });
        session.onEvent({ type: 'reply', text: sampleReply(session) });
        session.onEvent({ type: 'turn-end' });
      },
      sendSystemNote(text) {
        // 内部の指示は、利用者の発言として扱わない。聞こえた文字には出さない
        session.onEvent({ type: 'reply', text: `［見本］お調べした結果をお伝えします。（材料: ${text.slice(0, 40)}…）` });
        session.onEvent({ type: 'turn-end' });
      },
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        session.onEvent({ type: 'closed', reason: '見本の対話を終わりました' });
      },
    };
  }
}
