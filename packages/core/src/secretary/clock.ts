/**
 * @file 秘書（AI）に渡す、いまの日時と曜日（仕様書 第10.3.1節）。
 *
 * AI は自分ではいまの日時を知らない。渡さないと、深夜に「おはようございます」と挨拶したり、
 * 「今日」「明日」を取り違えたりする（2026-10-31 の 0:30 に、トップ画面の秘書が「おはようございます」と挨拶した）。
 * 文字の会話・音声・最初の画面の一言のどれにも、同じ形で渡す。
 */

/**
 * いまの日時と曜日を、秘書への指示の 1 行にする。
 *
 * @param timeZone 本人のタイムゾーン（個人設定。空なら日本時間）
 * @param now 試験のために渡せるいまの時刻
 * @returns 例「いまは 2026 年 10 月 31 日（土）0:30（Asia/Tokyo）です。挨拶や「今日」「明日」は、この日時に合わせます。」
 */
export function secretaryClockLine(timeZone = '', now: Date = new Date()): string {
  const zone = timeZone || 'Asia/Tokyo';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    // 知らないタイムゾーンが入っていたら日本時間で読む
    return secretaryClockLine('Asia/Tokyo', now);
  }
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `いまは ${get('year')} 年 ${get('month')} 月 ${get('day')} 日（${get('weekday')}）${get('hour')}:${get('minute')}（${zone}）です。`
    + '挨拶や「今日」「明日」は、この日時に合わせます（深夜に「おはようございます」とは言いません）。';
}
