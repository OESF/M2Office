/**
 * @file 動いている環境（仕様書 第8.6.7.1節）。管理画面の「機械」（ローカルの形）と運営の画面の「稼働状況」（クラウドの形）に出す、
 * M2Office が動いているソフトと機械の様子の型と、Node.js のサポートの表。
 *
 * - Node.js の系ごとの段階とサポートの終わりの予定は、ここに表で持つ。画面は外（nodejs.org など）へ見に行かない
 * - **リリースのたびに、公式の予定（https://raw.githubusercontent.com/nodejs/Release/main/schedule.json）と見比べて直す**
 *   （リリース規定の事前の確認。docs/release-process.md）
 * - セキュリティの修正の下限（`secure`）は、公式のセキュリティの発表（https://nodejs.org/en/blog/vulnerability）と見比べて直す。
 *   発表があったら、ほかの変更を待たずに下限だけを直した PATCH のリリースを出す。値は M2Medical と同じにする
 * - 秘密の値・業務の中身・個人の情報は入れない
 * - M2Medical の同じ部品（packages/shared/src/runtime.ts。2026-10-22）を写した
 */

/** Node.js の系の段階。Current（新しい機能を足していく）・LTS（長く支える）・LTS の保守の段階（大事な修正だけ）・サポートの終わった・表に無い。 */
export type NodeStage = 'current' | 'lts' | 'maintenance' | 'eol' | 'unknown';

/** 段階の書き方。 */
export const NODE_STAGE_LABELS: Record<NodeStage, string> = {
  current: 'Current', lts: 'LTS', maintenance: 'LTS の保守の段階（大事な修正とセキュリティの修正だけ）', eol: 'サポートの終わった版', unknown: '表にない系',
};

/**
 * Node.js の系ごとの予定。日付は公式の予定（YYYY-MM-DD）。26 系までは偶数の系だけが LTS になり、27 系からはどの系も LTS になる。
 * `lts` は LTS になる日、`maintenance` は保守の段階になる日、`end` はサポートの終わる日。2026-10-22 に nodejs/Release の schedule.json と見比べた。
 * `secure` はセキュリティの修正の下限（その系で分かっている穴をすべて直した最も古い版）。サポートの終わった系とまだ出ていない系は `null`。
 * 2026-10-21 の発表（22 系 v22.23.4・24 系 v24.22.1・26 系 v26.12.1）で決めた（仕様書 第8.6.7.1節、Q-259）。
 */
export const NODE_RELEASE_LINES: { major: number; codename: string | null; released: string; lts: string | null; maintenance: string | null; end: string; secure: string | null }[] = [
  { major: 20, codename: 'Iron', released: '2023-04-18', lts: '2023-10-24', maintenance: '2024-10-22', end: '2026-04-30', secure: null },
  { major: 22, codename: 'Jod', released: '2024-04-24', lts: '2024-10-29', maintenance: '2025-10-21', end: '2027-04-30', secure: 'v22.23.4' },
  { major: 24, codename: 'Krypton', released: '2025-05-06', lts: '2025-10-28', maintenance: '2026-10-20', end: '2028-04-30', secure: 'v24.22.1' },
  { major: 25, codename: null, released: '2025-10-15', lts: null, maintenance: '2026-04-01', end: '2026-06-01', secure: null },
  { major: 26, codename: null, released: '2026-05-05', lts: '2026-10-28', maintenance: '2027-10-20', end: '2029-04-30', secure: 'v26.12.1' },
  { major: 27, codename: null, released: '2027-04-22', lts: '2027-10-20', maintenance: null, end: '2030-04-30', secure: null },
];

/** サポートの終わりの何か月前から知らせるか。 */
export const NODE_SUPPORT_WARN_MONTHS = 6;

/** 動いている Node.js の版の、段階とサポートの終わり。 */
export interface NodeSupport {
  version: string;
  major: number | null;
  codename: string | null;
  stage: NodeStage;
  /** サポートの終わる日（表に無ければ `null`）。 */
  end: string | null;
  /** サポートの終わりまで 6 か月を切った（終わった後も真）。 */
  warn: boolean;
  /** サポートが終わった。 */
  expired: boolean;
  /** その系のセキュリティの修正の下限（表に無ければ `null`）。 */
  secure: string | null;
  /** 下限より古い（セキュリティの修正がある）。版が読めなければ `false`。 */
  insecure: boolean;
}

/**
 * Node.js の版を比べる。主・副・修正の番号を数として比べる（`v24.9.0` は `v24.22.1` より古い）。
 *
 * @returns `a` が古ければ負、同じなら 0、新しければ正。どちらかが読めなければ `null`
 */
export function compareNodeVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** 日付に月を足す（YYYY-MM-DD）。 */
function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Node.js の版（`v24.22.1` など）から、段階とサポートの終わりを出す。表に無い系は `unknown`（推測しない）。
 *
 * @param today 今日（YYYY-MM-DD。日本の日付）
 */
export function nodeSupport(version: string, today: string): NodeSupport {
  const m = /^v?(\d+)\./.exec(version.trim());
  const major = m ? Number(m[1]) : null;
  const line = NODE_RELEASE_LINES.find((x) => x.major === major);
  if (!line) return { version, major, codename: null, stage: 'unknown', end: null, warn: false, expired: false, secure: null, insecure: false };
  const stage: NodeStage = today >= line.end ? 'eol' : line.lts && line.maintenance && today >= line.maintenance ? 'maintenance' : line.lts && today >= line.lts ? 'lts' : 'current';
  return {
    version, major, codename: line.lts && today >= line.lts ? line.codename : null, stage, end: line.end,
    warn: today >= addMonths(line.end, -NODE_SUPPORT_WARN_MONTHS), expired: today >= line.end,
    secure: line.secure, insecure: line.secure !== null && (compareNodeVersions(version, line.secure) ?? 0) < 0,
  };
}

/** 機械の様子（OS・CPU・メモリー。取れなかった値は `null`）。 */
export interface RuntimeMachine {
  /** OS（例: macOS 26.1）。 */
  os: string | null;
  /** CPU の種類（arm64 など）。 */
  arch: string | null;
  cpu: string | null;
  cores: number | null;
  /** メモリー（バイト）。`free` は使える量（macOS はすぐに空けられる分を含む）。 */
  memTotal: number | null;
  memFree: number | null;
}

/** API・ワーカーが置く、動いている知らせ（`runtime_beats`）。 */
export interface RuntimeBeat {
  role: 'api' | 'worker';
  /** その処理の M2Office の版。 */
  version: string | null;
  /** その処理の Node.js の版。 */
  node: string;
  startedAt: string;
  /** 最後に置いた時刻。 */
  at: string;
  machine: RuntimeMachine;
}

/** 1 つの処理（API かワーカー）の様子。 */
export interface RuntimeProcess {
  version: string | null;
  node: NodeSupport;
  startedAt: string;
  lastSeen: string;
  /** 知らせが 12 分より古い（止まっているかもしれない）。 */
  stale: boolean;
}

/** セキュリティの修正の知らせ（下限より古い部分ごと）。 */
export type NodeSecurityNotice = { role: 'api' | 'worker'; version: string; secure: string }[];

/** 動いている環境（取れなかった値は `null`）。 */
export interface RuntimeEnvironment {
  /** API（知らせが来ていなければ `null`）。 */
  api: RuntimeProcess | null;
  /** ワーカー（知らせが来ていなければ `null`）。 */
  worker: RuntimeProcess | null;
  /** PostgreSQL の版。 */
  postgres: string | null;
  /** API の動いている機械（無ければワーカーの機械）。 */
  machine: RuntimeMachine | null;
  /** 動いている形（ローカルの形・クラウドの形）とデバッグモード。 */
  deployment: 'onsite' | 'cloud';
  debug: boolean;
  /** 推論の説明（秘密の値は入れない）。 */
  inference: string | null;
  /** Node.js の更新が要るか（API かワーカーのサポートの終わりまで 6 か月を切った・終わった）。 */
  nodeWarn: { expired: boolean; end: string | null; version: string } | null;
  /** セキュリティの修正があるか（API かワーカーの Node.js が、その系の下限より古い）。古い部分ごと。無ければ `null`。 */
  nodeSecurity: NodeSecurityNotice | null;
  checkedAt: string;
}
