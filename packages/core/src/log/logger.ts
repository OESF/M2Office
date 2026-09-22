/**
 * @file アプリログ（システムログ）のロガー。レベルによる絞り込み、JSON と読みやすい形の出力、伏せ字を担う。
 *
 * API とワーカーはこのロガーを通して標準出力へ書く。保存と入れ替えは出力先の基盤が行う。
 * 外部のパッケージは使わない。必要な機能が短く書けるため（仕様書 第20.8節 第 2 項）。
 *
 * @see 開発規約 第7章 ログ
 */

/** ログのレベル。下にいくほど詳しい。 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** ログに添える項目。値は JSON にできるもの。 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  /** 項目を固定した子のロガーを作る。要求 ID や実行 ID を毎回書かずに済ませるため。 */
  child(fields: LogFields): Logger;
  /** そのレベルが出力されるかどうか。重い組み立てを避けたいときに使う。 */
  enabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  /** どのプロセスか（`api`・`worker`）。 */
  service: string;
  level?: LogLevel;
  format?: 'json' | 'pretty';
  /** 書き出し先。既定は標準出力（`error` と `warn` は標準エラー）。テストで差し替える。 */
  write?: (line: string, level: LogLevel) => void;
  /** 時刻の取得。テストで差し替える。 */
  now?: () => Date;
}

/**
 * 伏せ字にする項目の名前（小文字で比較する）。
 *
 * @remarks
 * 書き漏らしへの備えであり、中身を渡してよい理由にはならない（開発規約 第7.5節）。
 */
const SECRET_KEYS = new Set([
  'password', 'passwd', 'token', 'accesstoken', 'refreshtoken', 'secret', 'apikey', 'api_key',
  'authorization', 'cookie', 'set-cookie', 'csrftoken', 'x-csrf-token',
  'body', 'text', 'content', 'transcript', 'input', 'message', 'prompt', 'present',
]);

/** 文字列を切り詰める長さ。長い文字列はたいてい中身であり、ログに要らない。 */
const MAX_STRING = 200;

/**
 * 環境変数からロガーを作る。
 *
 * @param service どのプロセスか
 * @remarks
 * `LOG_LEVEL`・`LOG_FORMAT` が無ければ、開発は `debug`・`pretty`、
 * 本番（`NODE_ENV=production`）は `info`・`json` とする（開発規約 第7.3節）。
 */
export function createLoggerFromEnv(service: string, env: NodeJS.ProcessEnv = process.env): Logger {
  const prod = env['NODE_ENV'] === 'production';
  const level = (LOG_LEVELS as readonly string[]).includes(env['LOG_LEVEL'] ?? '')
    ? (env['LOG_LEVEL'] as LogLevel)
    : prod ? 'info' : 'debug';
  const format = env['LOG_FORMAT'] === 'json' || env['LOG_FORMAT'] === 'pretty'
    ? env['LOG_FORMAT']
    : prod ? 'json' : 'pretty';
  return createLogger({ service, level, format });
}

/**
 * ロガーを作る。
 *
 * @param opts プロセス名・レベル・形式・書き出し先
 */
export function createLogger(opts: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(opts.level ?? 'info');
  const format = opts.format ?? 'json';
  const write = opts.write ?? defaultWrite;
  const now = opts.now ?? (() => new Date());

  const make = (base: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
      if (LOG_LEVELS.indexOf(level) > threshold) return;
      const record: LogFields = {
        time: now().toISOString(), level, service: opts.service, msg,
        ...sanitize({ ...base, ...fields }, level),
      };
      write(format === 'json' ? JSON.stringify(record) : pretty(record), level);
    };
    return {
      error: (m, f) => emit('error', m, f),
      warn: (m, f) => emit('warn', m, f),
      info: (m, f) => emit('info', m, f),
      debug: (m, f) => emit('debug', m, f),
      child: (fields) => make({ ...base, ...fields }),
      enabled: (level) => LOG_LEVELS.indexOf(level) <= threshold,
    };
  };
  return make({});
}

/** 何も書かないロガー。ロガーを渡されなかった部品の既定値に使う。 */
export const silentLogger: Logger = {
  error() {}, warn() {}, info() {}, debug() {},
  child() { return silentLogger; },
  enabled() { return false; },
};

/**
 * 例外を記録できる形にする。
 *
 * @remarks 呼び出し履歴は `error` のときだけ残す。量が多く、それ以外では調査に要らないため。
 */
function serializeError(err: unknown, level: LogLevel): LogFields {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: truncate(err.message),
      ...(level === 'error' && err.stack ? { stack: err.stack.split('\n').slice(0, 12).join('\n') } : {}),
    };
  }
  return { message: truncate(String(err)) };
}

/** 伏せ字と切り詰めを施す。入れ子は 3 段まで見る。 */
function sanitize(fields: LogFields, level: LogLevel, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === 'err') {
      out[k] = serializeError(v, level);
    } else if (SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = '[伏せ字]';
    } else if (typeof v === 'string') {
      out[k] = truncate(v);
    } else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
      out[k] = sanitize(v as LogFields, level, depth + 1);
    } else if (Array.isArray(v)) {
      out[k] = v.length > 20 ? `[${v.length} 件]` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function truncate(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…（${s.length} 文字）` : s;
}

const COLORS: Record<LogLevel, string> = {
  error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m',
};

/** 開発用の読みやすい形。`時刻 レベル メッセージ 項目=値 …`。 */
function pretty(r: LogFields): string {
  const { time, level, service: _service, msg, err, ...rest } = r as LogFields & { level: LogLevel };
  const t = new Date(String(time)).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
  const kv = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  let line = `${t} ${COLORS[level]}${level.toUpperCase().padEnd(5)}\x1b[0m ${msg}${kv ? `  \x1b[90m${kv}\x1b[0m` : ''}`;
  if (err) {
    const e = err as { name?: string; message?: string; stack?: string };
    line += `\n  ${e.name ?? 'Error'}: ${e.message ?? ''}`;
    if (e.stack) line += `\n${e.stack.split('\n').slice(1).map((s) => `  ${s.trim()}`).join('\n')}`;
  }
  return line;
}

function defaultWrite(line: string, level: LogLevel): void {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
