/**
 * @file 名刺についての依頼の見分け。「〇〇さんの電話番号は？」は名刺を探す調べものへ、「〇〇さんの電話番号を…に直して」は名刺の修正へ回す。
 *
 * 推論に選ばせずに決める。名刺の問いを、業務の取次の推論が「分かりません」と答えてしまわないようにするため。
 *
 * @see 仕様書 第27.9節 秘書と業務から使う
 */

/** 人を指す言葉（〇〇さん・〇〇様・〇〇社の人）。 */
const PERSON = /さん|様|氏|社長|部長|課長|担当/;
/** 名刺から分かる項目。 */
const CONTACT_ITEM = /電話番号|電話|携帯|メールアドレス|メアド|連絡先|住所|FAX|ファックス|役職|部署/;
/** 尋ねる言い回し。 */
const ASKS = /[?？]|教えて|知りたい|何番|探して|調べて|分かる|わかる|ある[?？]?$|は$/;
/** 直す・書き足す言い回し。 */
const FIXES = /直して|修正して|訂正して|に変えて|に変更して|メモして|メモを(残|書|足)|書き足して|追記して/;
/** 名刺を受け取った日を告げる言い回し（「9 月 25 日の展示会でもらった」）。 */
const RECEIVED = /(もらった|受け取った|いただいた|交換した)/;
/** 日付を表す言葉。 */
const A_DATE = /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|昨日|おととい|一昨日|先週|先月|今日/;
/** 一覧や誰かを尋ねる言い回し（受け取った日を告げる文と見分ける）。 */
const ASKS_WHO = /[?？]|教えて|誰|だれ|一覧|人は|方は/;

/** 名刺交換を振り返る問い（「先週名刺交換した人」）。 */
const EXCHANGED = /名刺(を)?交換した(人|方)|名刺をもらった(人|方)|受け取った名刺/;

/**
 * 名刺についての依頼かを見分ける。
 *
 * @returns `ask`（名刺を探す）・`fix`（名刺を直す・メモする）。名刺の依頼でなければ `null`
 * @remarks 送る依頼（「〇〇さんにメールを送って」）は名刺の依頼にしない（尋ねる言い回しが無いため）
 */
export function contactRequest(message: string): 'ask' | 'fix' | null {
  const m = message.trim();
  const aboutCard = /名刺/.test(m);
  if (FIXES.test(m) && (aboutCard || (PERSON.test(m) && (CONTACT_ITEM.test(m) || /メモ/.test(m))))) return 'fix';
  // 「佐々木さんの名刺は 9 月 25 日の展示会でもらった」は、受け取った日を直す依頼（第27.9節）
  if (aboutCard && PERSON.test(m) && RECEIVED.test(m) && A_DATE.test(m) && !ASKS_WHO.test(m)) return 'fix';
  if (EXCHANGED.test(m)) return 'ask';
  if (aboutCard && ASKS.test(m)) return 'ask';
  if (PERSON.test(m) && CONTACT_ITEM.test(m) && ASKS.test(m)) return 'ask';
  return null;
}
