/**
 * 認証まわりの設定。
 *
 * @remarks
 * 開発用の入口（利用者を選んでログインする画面、`X-User` ヘッダー）は、
 * Google の OAuth クライアント（B-2）が整うまでの足場である。
 * **本番で有効になっていたら起動を止める。** 誤って公開されると誰でも誰にでもなれるため。
 */
export interface AuthConfig {
  /** 開発用ログイン（利用者を選ぶ）を許すか。 */
  devLogin: boolean;
  /** `X-User` ヘッダーでの利用者指定を許すか。動作確認のスクリプト用。 */
  devHeaders: boolean;
  /** Google でのログインが設定済みか。 */
  googleConfigured: boolean;
  /** ログイン状態の有効時間（時間）。 */
  sessionTtlHours: number;
  /** Cookie に Secure 属性を付けるか。HTTPS で配信する環境では必ず有効にする。 */
  cookieSecure: boolean;
}

/**
 * 環境変数から設定を読む。
 *
 * @throws {Error} 本番環境で開発用の入口が有効になっている場合
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const flag = (k: string) => env[k] === 'true';
  const config: AuthConfig = {
    devLogin: flag('AUTH_DEV_LOGIN'),
    devHeaders: flag('AUTH_DEV_HEADERS'),
    googleConfigured: !!env['GOOGLE_CLIENT_ID'] && !!env['GOOGLE_CLIENT_SECRET'],
    sessionTtlHours: Number(env['SESSION_TTL_HOURS'] ?? 168),
    cookieSecure: flag('COOKIE_SECURE'),
  };
  if (env['NODE_ENV'] === 'production' && (config.devLogin || config.devHeaders)) {
    throw new Error(
      '本番環境で AUTH_DEV_LOGIN または AUTH_DEV_HEADERS が有効です。起動を中止します。',
    );
  }
  return config;
}
