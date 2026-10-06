/**
 * @file 会議室・社用車・備品の予約（内蔵の拡張。仕様書 第37章）の型と決まり。
 *
 * 予約できるものと予約は M2Office に持ち、予約した人の Google カレンダーにも予定を入れる（第37.6節）。
 * 予約の正は M2Office で、カレンダーの予定を直しても予約は変わらない。承認は挟まない（Q-181）。
 */

/** 予約の拡張機能の ID。 */
export const RESERVATIONS_EXTENSION_ID = 'reservations';

/** 予約できるものの種類（並べ方と「会議室を」のような頼み方に使う）。 */
export type ReservableKind = 'room' | 'car' | 'equipment' | 'other';

/** 種類の名前。 */
export const RESERVABLE_KIND_LABELS: Record<ReservableKind, string> = {
  room: '会議室', car: '社用車', equipment: '備品', other: 'そのほか',
};

/** 予約できるもの（第37.3節）。 */
export interface ReservableItem {
  id: string;
  /** 会社の中で重ならない名前（40 字まで） */
  name: string;
  kind: ReservableKind;
  /** 定員（会議室だけ。目安で、超えても断らない） */
  capacity: number | null;
  /** 場所（任意） */
  location: string;
  /** 並びの順（小さいほど先） */
  sortOrder: number;
  /** 止めたものは新しく予約できない */
  status: 'active' | 'stopped';
  createdBy: string;
  createdAt: string;
}

/** 予約（第37.3節）。 */
export interface Reservation {
  id: string;
  itemId: string;
  /** 始め（ISO 8601） */
  startAt: string;
  /** 終わり（ISO 8601。始めと同じ時刻の次の予約とは重ならない） */
  endAt: string;
  /** 用件（任意。120 字まで） */
  purpose: string;
  /** 予約した人 */
  userId: string;
  /** 予約した人の名前（見せるときに引く） */
  userName: string;
  /** 予約した人の Google カレンダーの予定（入れられなかったら `null`） */
  calendarEventId: string | null;
  status: 'booked' | 'cancelled';
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 会社の設定（入り切りだけ。予約できるものは表に持つ）。 */
export interface ReservationSettings {
  enabled: boolean;
}

/** 予約は既定で切り（第37.2節）。 */
export const DEFAULT_RESERVATION_SETTINGS: ReservationSettings = { enabled: false };

/** 予約の決まり（第37.5節。Q-183）。 */
export const RESERVATION_LIMITS = {
  /** 1 件の長さ（日） */
  maxDays: 14,
  /** どこまで先を予約できるか（日） */
  aheadDays: 90,
  /** 名前の長さ */
  nameMax: 40,
  /** 用件の長さ */
  purposeMax: 120,
  /** 場所の長さ */
  locationMax: 60,
  /** 予約できるものの数 */
  itemsMax: 200,
  /** 終わった予約を残す日数（第37.11節） */
  keepDays: 365,
} as const;

/** 重なって断ったときに示す、空いている時間とほかのもの（第37.5節）。 */
export interface ReservationConflict {
  /** 重なった予約（予約した人の名前と時間） */
  taken: { userName: string; startAt: string; endAt: string };
  /** そのものの、同じ長さで次に空いている時間 */
  nextFree: { startAt: string; endAt: string } | null;
  /** 同じ種類で、その時間に空いているほかのもの */
  others: { id: string; name: string; capacity: number | null }[];
}
