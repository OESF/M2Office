/**
 * @file 音声の対話で、秘書が話し終わるまで内部の指示を待たせる仕組み（仕様書 第10.11.7節）。
 *
 * Gemini Live では、話している最中にこちらから turn を送ると**割り込み**とみなされ、
 * 再生中の音声がその場で切れる。後ろで終わった調べものを伝えるときに、
 * 会話をぶつ切りにしないための門である。
 *
 * @see 仕様書 第10.11.7節 終わったことを伝える
 */

/**
 * 話し終わりを待って伝える門。
 *
 * @remarks
 * 使い方は 3 つだけである。応答が始まったら {@link startedSpeaking}、
 * 話し終わったら {@link finishedSpeaking}、伝えたいものは {@link tell} に渡す。
 */
export class TurnGate {
  /** 秘書が話している最中か。 */
  private speaking = false;
  /** 話し終わりを待っている、伝えるべきこと。 */
  private readonly waiting: string[] = [];

  /**
   * @param send 実際に送る先。話していないときだけ呼ばれる
   */
  constructor(private readonly send: (note: string) => void) {}

  /** 応答が始まった。以降は伝えない。 */
  startedSpeaking(): void {
    this.speaking = true;
  }

  /**
   * 話し終わった。待たせていたものを 1 つだけ伝える。
   *
   * @remarks
   * **1 つだけにする。** まとめて送ると、続けて割り込むことになる。
   * 残りは次の話し終わりで伝える。
   */
  finishedSpeaking(): void {
    this.speaking = false;
    const next = this.waiting.shift();
    if (next !== undefined) this.send(next);
  }

  /** 伝える。話している最中なら、話し終わりまで待たせる。 */
  tell(note: string): void {
    if (this.speaking) {
      this.waiting.push(note);
      return;
    }
    this.send(note);
  }

  /** 待たせている件数。動作確認と記録に使う。 */
  get pending(): number {
    return this.waiting.length;
  }
}
