/**
 * @file 音声の対話の接続口（仕様書 第10.5.4節、Q-35、ADR-0018）。
 *
 * 画面とサーバーの中継は、この接続口だけを見る。提供者（Gemini Live）固有の形は実装の中に閉じる。
 * やり取りするのは音のかたまり（PCM）と文字だけである。
 *
 * **録音は残さない。** 受け取った音は通したら捨て、どこにも書き出さない（第10.5.3節）。
 */

/** 音の形。接続口の実装が、提供者の求める形へ変換する。 */
export const AUDIO = {
  /** 送り（マイク）の標本化周波数。 */
  inputHz: 16_000,
  /** 受け（読み上げ）の標本化周波数。 */
  outputHz: 24_000,
} as const;

/** 対話の中で届く出来事。 */
export type VoiceEvent =
  /** 聞こえた文字（本人の発話）。 */
  | { type: 'heard'; text: string }
  /** 秘書の応答の文字。 */
  | { type: 'reply'; text: string }
  /** 秘書の応答の音（PCM）。読み上げを切っている人には送らない。 */
  | { type: 'audio'; pcm: Uint8Array }
  /** 応答が一区切りついた。 */
  | { type: 'turn-end' }
  /**
   * 画面へ伝える断り書き。**本人の発言でも秘書の応答でもない。**
   *
   * @remarks 選んだ声が使えず既定の声にした、といった知らせに使う（仕様書 第10.5.6節）。
   */
  | { type: 'note'; text: string }
  /** 終わった。 */
  | { type: 'closed'; reason: string };

/** 開いている対話。 */
export interface VoiceSession {
  /** マイクの音を送る（16 kHz・16 ビットの PCM）。 */
  sendAudio(pcm: Uint8Array): void;
  /** 文字で送る（聞き取りが難しいときの補い）。 */
  sendText(text: string): void;
  /**
   * 内部の指示を送る（仕様書 第10.11.7節）。
   *
   * @remarks
   * 利用者の発言ではない。後ろで終わった調べものの**材料**を渡し、
   * 秘書が自分の言葉で伝えられるようにする。読み上げる原稿は渡さない。
   *
   * **話している最中に送ってはならない。** 割り込みとみなされ、再生中の音声が切れる。
   * 送るのは話し終わり（`turn-end`）のあとである。
   */
  sendSystemNote(text: string): void;
  /** 終わる。 */
  close(): void;
}

/**
 * 音声の相手に渡す道具（仕様書 第10.5.7節）。音声の相手が呼び、その結果をもとに話す。
 *
 * @remarks 引数は文字の項目だけ。道具は例外を投げず、答えを返す（呼び出し側で断りの文にする）
 */
export interface VoiceTool {
  name: string;
  /** 音声の相手への説明。いつ呼ぶかを書く。 */
  description: string;
  /** 引数（すべて文字）。 */
  parameters: Record<string, { description: string }>;
  required: string[];
  run(args: Record<string, string>): Promise<Record<string, unknown>>;
}

export interface VoiceSessionOptions {
  /** 秘書の名乗りと応対のしかた（仕様書 第6.5.3節）。 */
  instructions: string;
  /** 音声で応答するか。切っている人には文字だけを返す（第10.5.5節）。 */
  speak: boolean;
  /**
   * 読み上げの声（仕様書 第10.5.6節）。提供者が用意する声の名前。
   *
   * @remarks 空なら提供者の既定に任せる。知らない名前を渡さないよう、呼び出し側が確かめる
   */
  voice?: string;
  /** 音声の相手に渡す道具（仕様書 第10.5.7節）。無ければ話し相手だけになる。 */
  tools?: VoiceTool[];
  /** 出来事を受け取る。 */
  onEvent(event: VoiceEvent): void;
}

/**
 * 音声の対話の提供者。
 *
 * @remarks
 * 実装は `GeminiLiveProvider`（本番）と `MockVoiceProvider`（鍵が無い環境）。
 * 乗り換えるときは、この接続口の実装を 1 つ書き直す（ADR-0018 決定 1）。
 */
export interface VoiceProvider {
  readonly name: string;
  /** 対話を開く。開けなければ例外を投げる。 */
  open(options: VoiceSessionOptions): Promise<VoiceSession>;
}
