/**
 * @file 音声の相手に渡す、秘書の名乗りと応対のしかた（仕様書 第6.5.3節・第10.5.6節）。
 *
 * 音声の対話（`relay.ts`）と声を試す（`sample.ts`）の両方が使う。
 * 同じ指示から作るため、試したときの口調が実際の対話と変わらない（第10.5.8節）。
 */

import { VOICE_CHOICES, type UserSettings } from '@m2office/shared';

/** 名乗りと応対のしかたを決める材料。 */
export interface VoicePersona {
  /** 会社の呼び方（略称、無ければ正式な会社名）。空なら「中小企業」とする。 */
  org: string;
  /** 本人の表示名。呼ばれ方が未設定のときに「〇〇さん」として使う。 */
  displayName: string;
  /** 個人設定「秘書」の値（第6.5.3節）。 */
  secretary: Pick<UserSettings['secretary'], 'name' | 'callMe' | 'style' | 'voiceStyle'>;
}

/**
 * 本人の呼び方。未設定なら「表示名さん」。
 *
 * @remarks 画面の欄の既定（placeholder）と同じにする
 */
export function callMeOf(p: VoicePersona): string {
  return p.secretary.callMe || `${p.displayName}さん`;
}

/**
 * 秘書の名乗り・呼び方・応対スタイルの指示（音声の相手への指示の先頭）。
 *
 * @remarks 話し方の指示は末尾に足すため、ここには入れない（{@link voiceStyleLine}）
 */
export function personaLines(p: VoicePersona): string[] {
  return [
    `あなたは${p.org ? `「${p.org}」` : '中小企業'}の従業員に付く秘書${p.secretary.name ? `「${p.secretary.name}」` : ''}です。`,
    `相手を「${callMeOf(p)}」と呼びます。`,
    p.secretary.style === 'concise' ? '要点だけを短く答えます。' : '丁寧な日本語で、要点を先に答えます。',
  ];
}

/**
 * 本人が書いた話し方の指示（例: 関西弁で話して）。音声のときだけ使う（第10.5.6節）。未設定なら空の文字。
 */
export function voiceStyleLine(p: VoicePersona): string {
  return p.secretary.voiceStyle ? `話し方の指定: ${p.secretary.voiceStyle}` : '';
}

/**
 * 提供者に渡す声の名前。一覧に無い名前は渡さず、空（提供者の既定）にする（第10.5.6節）。
 */
export function voiceNameOf(voice: string): string {
  return VOICE_CHOICES.some((v) => v.name === voice) ? voice : '';
}
