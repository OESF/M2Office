/**
 * @file 声を試す（仕様書 第10.5.8節）。画面に入っている設定で、秘書に名乗りの挨拶を 1 回だけ話させる。
 *
 * 実際の音声の対話と同じ接続口（`VoiceProvider`）と、同じ名乗りの指示（`persona.ts`）を使う。
 * 別の読み上げの仕組みを使うと、声や口調が変わって確かめにならないためである。
 *
 * **音は残さない。** 1 回ぶんを集めて画面へ返したら捨てる（第10.5.3節）。
 * 会話ログ・記憶・監査ログの `secretary.voice` には残さない（本人と秘書の会話ではない）。
 */

import { AUDIO, type VoiceProvider, type VoiceSession } from '@m2office/core';
import { callMeOf, personaLines, voiceStyleLine, type VoicePersona } from './persona.js';

/** 待つ長さの上限（ミリ秒）。挨拶 1 回ぶんには十分な長さ。 */
export const SAMPLE_TIMEOUT_MS = 20_000;

/** 集める音の上限（バイト）。受けの PCM（16 ビット）で 20 秒ぶん。 */
export const SAMPLE_MAX_BYTES = AUDIO.outputHz * 2 * 20;

/** 試した結果。 */
export interface VoiceSample {
  /** 秘書が話した文字。音が聞こえない環境でも確かめられるように返す。 */
  text: string;
  /** 秘書の声（受けの PCM、16 ビット・リトルエンディアン）。声が返らなかったら空。 */
  pcm: Uint8Array;
  /** 断り書き（選んだ声が使えず既定の声にした、など。第10.5.6節）。 */
  notes: string[];
}

/**
 * 声を試すときに、音声の相手へ渡す内部の指示。
 *
 * @remarks
 * 渡すのは話す中身の材料であって、読み上げる原稿ではない。
 * 原稿を渡すと、話し方の指示（関西弁など）が効いているかを確かめられない。
 */
export function sampleNote(p: VoicePersona): string {
  return [
    '（内部情報・この文をそのまま読み上げないこと）',
    '声の確認です。本人が個人設定で、あなたの声と話し方を確かめています。ひと息で、次のことだけを話してください。',
    `- 相手を「${callMeOf(p)}」と呼ぶ`,
    p.secretary.name ? `- 秘書の「${p.secretary.name}」だと名乗る` : '- 名前は決まっていないので、名乗らずに「秘書です」とだけ言う',
    '- 「よろしくお願いします」と挨拶する',
    '応対のしかたと話し方の指定に従って、言い回しを変えてかまいません。ほかのこと（予定・用件の問いかけなど）は話さないでください。',
  ].join('\n');
}

/**
 * 秘書に名乗りの挨拶を 1 回話させ、その声と文字を集めて返す。
 *
 * @param provider 音声の対話の提供者（実際の対話と同じもの）
 * @param persona 画面に入っている名乗りと応対のしかた（保存の前でもよい）
 * @param voice 提供者に渡す声の名前。一覧で確かめたもの（空なら提供者の既定）
 *
 * @remarks
 * 話し終わり（`turn-end`）か、上限の時間で打ち切る。どちらでも対話は閉じる。
 * 声も文字も返らずに終わったら、例外を投げる（呼び出し側で断りの文にする）。
 */
export async function speakSample(
  provider: VoiceProvider, persona: VoicePersona, voice: string, timeoutMs = SAMPLE_TIMEOUT_MS,
): Promise<VoiceSample> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const text: string[] = [];
  const notes: string[] = [];
  let session: VoiceSession | null = null;
  let closedReason = '';
  let finished = false;

  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => finish(), timeoutMs);
    const finish = () => { finished = true; clearTimeout(timer); resolve(); };
    void provider.open({
      speak: true,
      voice,
      // 実際の対話と同じ名乗りと応対のしかた。道具は渡さない（話すのは挨拶だけ）
      instructions: [...personaLines(persona), voiceStyleLine(persona)].filter(Boolean).join(''),
      onEvent: (event) => {
        switch (event.type) {
          case 'audio':
            // 上限を超えた分は捨てる（際限なく貯めない）
            if (bytes + event.pcm.byteLength <= SAMPLE_MAX_BYTES) {
              chunks.push(event.pcm);
              bytes += event.pcm.byteLength;
            }
            break;
          case 'reply':
            text.push(event.text);
            break;
          case 'note':
            notes.push(event.text);
            break;
          case 'turn-end':
            finish();
            break;
          case 'closed':
            closedReason = event.reason;
            finish();
            break;
          default:
            break;
        }
      },
    }).then((s) => {
      // 開くのが上限の時間より遅れた。待っている人はもういないので、すぐ閉じる
      if (finished) { s.close(); return; }
      session = s;
      s.sendSystemNote(sampleNote(persona));
    }, (err: unknown) => {
      closedReason = err instanceof Error ? err.message : String(err);
      finish();
    });
  });

  await done;
  (session as VoiceSession | null)?.close();

  if (chunks.length === 0 && text.length === 0) {
    throw new Error(closedReason || '秘書の声が返ってきませんでした');
  }
  const pcm = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    pcm.set(c, at);
    at += c.byteLength;
  }
  return { text: text.join('').trim(), pcm, notes };
}
