/**
 * @file 店頭サイネージ（内蔵の拡張）の型（仕様書 第31章、ADR-0051）。
 *
 * 画面（端末 1 台に 1 画面・1 社 3 台まで）・素材（画像・動画・HTML）・流れ（画面ごとの素材の並び）・割り込み・ジングル・呼び出しの受け口を持つ。
 * 料金は取らない標準の機能で、会社ごとに入り切りする（既定は切り。第31.2節）。
 */

/** 店頭サイネージの拡張の ID（内蔵の拡張。第12.13節）。 */
export const SIGNAGE_EXTENSION_ID = 'signage';

/** 1 社で登録できる画面の数（全社共通の決まり。第31.4節）。 */
export const SIGNAGE_MAX_SCREENS = 3;

/** 1 社の素材の合計の上限（バイト。案 2 GB。第31.4節・Q-141）。 */
export const SIGNAGE_STORAGE_LIMIT = 2 * 1024 * 1024 * 1024;

/** 素材の大きさの上限（第31.6.1節）。画像は縮めた後、動画はそのまま。 */
export const SIGNAGE_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  /** 動画の長さの上限（ミリ秒。案 10 分）。 */
  videoMs: 10 * 60 * 1000,
  thumbnailBytes: 100 * 1024,
  /** HTML の素材（中に入れた後。案 10 MB。第31.6.3節）。 */
  htmlBytes: 10 * 1024 * 1024,
  /** 割り込みの文の長さ（整えた後。第31.7.1節）。 */
  textChars: 80,
  /** 割り込みを出す秒数の範囲。 */
  minInterruptSeconds: 5,
  maxInterruptSeconds: 60,
  /** 画面ごとの割り込みの待ちの上限（第31.7.2節）。 */
  queue: 20,
  /** 割り込みの素材の数（会社で）。 */
  interruptAssets: 50,
  /** 画面ごとの時間帯の流れの数（第31.6.6節）。 */
  bands: 3,
  /** 会社のジングルの音（第31.7.3節。案）。 */
  soundBytes: 300 * 1024,
  soundMs: 5000,
  sounds: 10,
  /** 画面ごとの流れの行の数。 */
  entries: 100,
  /** 画像を出す秒数の範囲。 */
  minSeconds: 3,
  maxSeconds: 120,
} as const;

/** 会社のサイネージの設定（第31.4節・第31.15.1節）。 */
export interface SignageSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /** 画像と HTML を出す秒数の既定（3〜120）。 */
  imageSeconds: number;
  /** 店の色（`#RRGGBB`）。`null` なら濃い青。 */
  color: string | null;
  /** 割り込みを出す秒数の既定（5〜60）。 */
  interruptSeconds: number;
  /** 割り込みでジングルを鳴らすか（既定は入り）。 */
  chime: boolean;
  /** 既定のジングル（M2Office の音の名前か、会社の音の ID）。 */
  jingle: string;
  /** 番号と場所を送る呼び出しの言い回し（`{番号}`・`{場所}` を差し込む）。 */
  callTemplate: string;
  /** 番号だけの呼び出しの言い回し。 */
  callTemplateNoPlace: string;
  /** 在庫の入荷と品切れの案内を流すか（第31.6.7節。既定は切り）。 */
  stockNotices: boolean;
}

/** サイネージの既定の設定。 */
export const DEFAULT_SIGNAGE_SETTINGS: SignageSettings = {
  enabled: false, imageSeconds: 10, color: null, interruptSeconds: 15, chime: true, jingle: 'pinpon',
  callTemplate: '{番号}番の方、{場所}へお越しください', callTemplateNoPlace: '{番号}番の方、お越しください', stockNotices: false,
};

/** M2Office が持つジングル（画面の側で合成する。第31.7.3節）。 */
export const SIGNAGE_JINGLES: { id: string; label: string }[] = [
  { id: 'pinpon', label: 'ピンポーン' },
  { id: 'pinponpanpon', label: 'ピンポンパンポーン' },
  { id: 'poron', label: 'ポロン' },
  { id: 'bell', label: 'ベル' },
];

/** 店の色が無いときの色（濃い青。第31.4節）。 */
export const SIGNAGE_DEFAULT_COLOR = '#1f3a5f';

/** 画面の向き。 */
export type SignageOrientation = 'landscape' | 'portrait';

/** 画面を回す角度。 */
export type SignageRotation = 0 | 90 | 180 | 270;

/** 画面の生きている知らせ（第31.5.1節）。割り込みの文を入れない。 */
export interface SignageReport {
  /** いま出している素材の ID（無ければ `null`）。 */
  current: string | null;
  flowVersion: number;
  /** 取り置けた素材の数。 */
  cached: number;
  /** 取り置けなかった素材の ID。 */
  uncached: string[];
  /** 流せなかった素材の ID。 */
  failed: string[];
  /** 同じ HTML で 3 回続けて止まったため、飛ばしている素材の ID（第31.6.3節）。古い再生のページは送らない。 */
  skipped?: string[];
  /** ページの版。 */
  pageVersion: string;
  /** 端末の画面の縦横（回す前）。 */
  viewport: { width: number; height: number };
  /** 取り置きの場所の空き（バイト。分からなければ `null`）。 */
  storageFree: number | null;
  /** 音を出せるか（段 2。分からなければ `null`）。 */
  audio?: boolean | null;
  /** 割り込みを出しているか（段 2。文は入れない）。 */
  interrupting?: boolean;
}

/** 画面（第31.15.1節）。鍵のハッシュは画面に出さない。 */
export interface SignageScreen {
  id: string;
  name: string;
  orientation: SignageOrientation;
  rotation: SignageRotation;
  /** 音の大きさ（0〜100）。 */
  volume: number;
  flowVersion: number;
  lastSeenAt: string | null;
  lastReport: SignageReport | null;
  /** 最後の知らせから 3 分以内か。 */
  online: boolean;
  registeredAt: string;
}

/** 素材の種類。 */
export type SignageAssetKind = 'image' | 'video' | 'html';

/** 素材（第31.6.1節）。 */
export interface SignageAsset {
  id: string;
  kind: SignageAssetKind;
  name: string;
  mime: 'image/jpeg' | 'image/png' | 'video/mp4' | 'text/html';
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  /** 動画の長さ（ミリ秒）。画像は `null`。 */
  durationMs: number | null;
  hasThumbnail: boolean;
  /** 割り込みの素材か（画像か HTML）。 */
  isInterrupt: boolean;
  /** 割り込みの素材にしたときの音（`null` なら会社の既定）。 */
  jingle: string | null;
  /**
   * 動画の下に重ねて出す字幕（コラムから作った動画の題名と一言。第32.18.6節）。無ければ `null`。
   *
   * @remarks 生成 AI に字を描かせないため、字は再生の画面が重ねる
   */
  caption: string | null;
  createdAt: string;
}

/** 流れの 1 行（第31.6.2節）。 */
export interface SignageEntry {
  assetId: string;
  /** 画像の秒数（`null` なら会社の既定。動画は `null`）。 */
  seconds: number | null;
  /** 止めている（流れに残したまま、画面には流さない。行のスライドスイッチで止める・再開する。第31.9.4節）。省けば流す。 */
  paused?: boolean;
}

/**
 * 時間帯の流れの時間帯（第31.6.6節）。名前は持たず、時刻と曜日から呼び方を作る（{@link signageBandLabel}）。
 * 終わりが始めより前なら夜中をまたぐ。曜日は始めた日で見る。
 */
export interface SignageBand {
  id: string;
  /** 始め（`HH:MM`。日本時間） */
  start: string;
  /** 終わり（`HH:MM`。この時刻になったら外れる） */
  end: string;
  /** 曜日（7 ビット。月=1、火=2、水=4、木=8、金=16、土=32、日=64。毎日は 127） */
  days: number;
}

/** 曜日のビット（月〜日の順）。 */
export const SIGNAGE_WEEKDAYS: { bit: number; label: string }[] = [
  { bit: 1, label: '月' }, { bit: 2, label: '火' }, { bit: 4, label: '水' }, { bit: 8, label: '木' },
  { bit: 16, label: '金' }, { bit: 32, label: '土' }, { bit: 64, label: '日' },
];

/** `HH:MM` を 0 時からの分に（読めなければ `null`）。 */
export function signageMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** 曜日の呼び方（毎日・平日・土日、ほかは「月・水・金」）。 */
export function signageDaysLabel(days: number): string {
  if (days === 127) return '毎日';
  if (days === 31) return '平日';
  if (days === 96) return '土日';
  return SIGNAGE_WEEKDAYS.filter((d) => days & d.bit).map((d) => d.label).join('・');
}

/** 時間帯の呼び方（「11:00〜14:00 平日」）。 */
export function signageBandLabel(b: Pick<SignageBand, 'start' | 'end' | 'days'>): string {
  return `${b.start}〜${b.end} ${signageDaysLabel(b.days)}`;
}

/** 曜日のビット（日本時間の日付から。月=1 … 日=64）。 */
const weekdayBit = (jstDay: number) => 1 << ((jstDay + 6) % 7);

/**
 * いま当たっている時間帯（無ければ `null`。いつもの流れ）。
 *
 * @param jst 日本時間に直した時刻（`getUTC*` で日本時間の値が読めるもの）
 */
export function activeSignageBand<B extends SignageBand>(bands: B[], jst: Date): B | null {
  const now = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const today = weekdayBit(jst.getUTCDay());
  const yesterday = weekdayBit((jst.getUTCDay() + 6) % 7);
  for (const b of bands) {
    const s = signageMinutes(b.start);
    const e = signageMinutes(b.end);
    if (s === null || e === null || s === e) continue;
    if (s < e) { if (now >= s && now < e && b.days & today) return b; continue; }
    // 夜中をまたぐ: 始めた日の夜と、次の日の朝
    if ((now >= s && b.days & today) || (now < e && b.days & yesterday)) return b;
  }
  return null;
}

/** 2 つの時間帯が、同じ曜日の同じ時刻で重なるか（重なりは断る。第31.6.6節）。 */
export function signageBandsOverlap(a: Pick<SignageBand, 'start' | 'end' | 'days'>, b: Pick<SignageBand, 'start' | 'end' | 'days'>): boolean {
  // 週の分（月曜 0 時から）の区間にして比べる
  const spans = (x: Pick<SignageBand, 'start' | 'end' | 'days'>): [number, number][] => {
    const s = signageMinutes(x.start) ?? 0;
    const e = signageMinutes(x.end) ?? 0;
    const len = e > s ? e - s : e + 1440 - s;
    return SIGNAGE_WEEKDAYS.flatMap((d, i) => (x.days & d.bit ? [[i * 1440 + s, i * 1440 + s + len] as [number, number]] : []))
      .flatMap(([from, to]) => (to > 7 * 1440 ? [[from, 7 * 1440], [0, to - 7 * 1440]] as [number, number][] : [[from, to]]));
  };
  return spans(a).some(([a1, a2]) => spans(b).some(([b1, b2]) => a1 < b2 && b1 < a2));
}

/** 割り込みの出どころ（第31.15.1節）。 */
export type SignageOrigin = 'staff' | 'secretary' | 'hook';

/** 割り込みの画面ごとの状態（第31.7.2節）。 */
export type SignageTargetState = 'waiting' | 'showing' | 'done' | 'cleared' | 'expired';

/** 割り込みを出すときの値（スタッフのページ・秘書・受け口で同じ処理を通す。第31.12.1節）。 */
export interface SignageInterruptInput {
  /** 文（整えて 80 字まで）。 */
  text?: string;
  /** 番号（言い回しに差し込む）。 */
  number?: string;
  /** 場所（言い回しに差し込む）。 */
  place?: string;
  /** 割り込みの素材の ID。 */
  assetId?: string;
  /** 出す先の画面の ID（無ければすべて）。 */
  screens?: string[];
  seconds?: number;
  chime?: boolean;
  jingle?: string;
}

/** 画面の側に渡す割り込み（第31.9.2節）。 */
export interface SignagePlayInterrupt {
  id: string;
  kind: 'text' | 'asset';
  text: string | null;
  /** 大きく出す番号（文の先頭）。 */
  number: string | null;
  assetId: string | null;
  seconds: number;
  /** 鳴らす音（鳴らさなければ `null`）。 */
  jingle: string | null;
  state: SignageTargetState;
  /** 作ってからの経過（ミリ秒。サーバーが数える）。 */
  ageMs: number;
}

/** 管理の画面・スタッフのページに出す割り込み。 */
export interface SignageInterruptView {
  id: string;
  kind: 'text' | 'asset';
  /** 文（出し終えて 24 時間で消える。消えたら `null`）。 */
  text: string | null;
  assetId: string | null;
  origin: SignageOrigin;
  seconds: number;
  createdAt: string;
  targets: { screenId: string; state: SignageTargetState; startedAt: string | null; endedAt: string | null }[];
}

/** よく出す案内（第31.9.3節）。 */
export interface SignagePhrase {
  id: string;
  /** 番号を空けた形（`{番号}` を含むことがある）。 */
  template: string;
  hasNumber: boolean;
  count: number;
}

/** 呼び出しの受け口（第31.8.2節）。鍵は作ったときだけ返す。 */
export interface SignageSource {
  id: string;
  name: string;
  status: 'active' | 'stopped';
  /** 項目の対応（まだ推測していなければ `null`）。 */
  mapping: SignageSourceMapping | null;
  lastReceivedAt: string | null;
  /** 今日の受け付けた数と断った数。 */
  stats: { day: string; accepted: number; rejected: Record<string, number> };
  createdAt: string;
}

/** 受け口の項目の対応（ドットでつないだ道）。 */
export interface SignageSourceMapping {
  text?: string;
  number?: string;
  place?: string;
  image?: string;
  screens?: string;
  seconds?: string;
  chime?: string;
  jingle?: string;
  requestId?: string;
}

/** 会社のジングルの音（第31.7.3節）。 */
export interface SignageSound {
  id: string;
  name: string;
  mime: 'audio/mpeg' | 'audio/wav';
  bytes: number;
  durationMs: number;
  createdAt: string;
}
