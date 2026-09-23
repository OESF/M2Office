/**
 * @file 認証まわりの設定を環境変数から読み、本番で開発用の入口が開いていれば起動を止める。
 *
 * @see 仕様書 第16.1節 認証
 * @see 仕様書 第20.7節 認証の実装方針
 */

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
  /**
   * ログインに使う運営の OAuth クライアント（仕様書 第16.1.1節）。
   *
   * @remarks
   * 求める権限は `openid`・`email`・`profile` だけである。
   * 会社のデータに触れる方のクライアントは、管理者ページで会社ごとに登録する。
   */
  login: {
    clientId: string;
    clientSecret: string;
    /**
     * Google に登録するリダイレクト URI。**運営のホスト 1 本**である（第16.1.2節）。
     *
     * Google は HTTPS を要求する（例外は `localhost`）ため、
     * テナントごとのホストは指定できない。開発では `http://localhost:3101/...` を使う。
     */
    redirectUri: string;
  } | null;
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
  const loginId = env['GOOGLE_LOGIN_CLIENT_ID'];
  const loginSecret = env['GOOGLE_LOGIN_CLIENT_SECRET'];
  const config: AuthConfig = {
    devLogin: flag('AUTH_DEV_LOGIN'),
    devHeaders: flag('AUTH_DEV_HEADERS'),
    login: loginId && loginSecret
      ? {
        clientId: loginId,
        clientSecret: loginSecret,
        redirectUri: env['GOOGLE_LOGIN_REDIRECT_URI']
          ?? `http://localhost:${env['API_PORT'] ?? 3101}/v1/oauth/google/login-callback`,
      }
      : null,
    googleConfigured: !!loginId && !!loginSecret,
    sessionTtlHours: Number(env['SESSION_TTL_HOURS'] ?? 168),
    cookieSecure: flag('COOKIE_SECURE'),
  };
  if (env['NODE_ENV'] === 'production' && (config.devLogin || config.devHeaders)) {
    throw new Error(
      '本番環境で AUTH_DEV_LOGIN または AUTH_DEV_HEADERS が有効です。起動を中止します。',
    );
  }
  // 本番では、リダイレクト URI に HTTPS を要求する。Google の規則でもあり、
  // 引換券を平文で運ばせないためでもある（第16.1.2節）
  if (env['NODE_ENV'] === 'production' && config.login && !config.login.redirectUri.startsWith('https://')) {
    throw new Error('本番環境で GOOGLE_LOGIN_REDIRECT_URI が HTTPS ではありません。起動を中止します。');
  }
  return config;
}
