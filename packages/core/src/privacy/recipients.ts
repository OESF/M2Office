/**
 * @file データの渡し先（委託先）の一覧を、会社の設定と接続から組み立てる（仕様書 第16.11.3節 G-3、第16.5節）。
 *
 * 管理者ページの「接続 › データの渡し先」が出す。会社がいま使っているものと、使えば渡すものを分けて並べる。
 * 分からないこと（インフラ事業者が未設定など）は推測で埋めず、分からないと書く。
 */

import type { DataRecipient } from '@m2office/shared';

/** 一覧を組み立てる材料（API が会社の設定・接続・配備の設定から集める）。 */
export interface DataRecipientFacts {
  /** 配備の形（`cloud`・`onsite`）。 */
  deployment: 'cloud' | 'onsite';
  /** インフラ事業者の名前と置き場（設定 `HOSTING_PROVIDER`・`HOSTING_LOCATION`）。 */
  hosting: { provider: string | null; location: string | null };
  /** 会社の AI の方針の実際（`cloud`・`local-first`・`local-only`）と、Gemini の鍵の出どころ。 */
  ai: { policy: 'cloud' | 'local-first' | 'local-only'; geminiSource: 'tenant' | 'platform' | 'none'; localConfigured: boolean };
  /** 会社が登録した鍵・接続の種類（`google_oauth`・`google_chat_app`・`line`・`inquiry_mailbox`・`wordpress`・`places`・`web_review`）。 */
  credentials: Set<string>;
  /** 入れている内蔵の拡張。 */
  extensions: { webReview: boolean; printDesigns: boolean; competitors: boolean; columns: boolean; inquiries: boolean };
  /** Canva のつなぎが用意されているか（運営の設定）。 */
  canvaAvailable: boolean;
  /** 会社が登録したコネクタ（MCP）。 */
  connectors: { id: string; name: string; url: string }[];
}

const UNSET = '（運営が設定していません）';
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/**
 * データの渡し先の一覧を組み立てる。
 *
 * @remarks 危険度: read（何も変えない）。順は、置き場 → 推論 → Google → 業務ごとのつなぎ → 会社が登録したコネクタ
 */
export function buildDataRecipients(f: DataRecipientFacts): DataRecipient[] {
  const onsite = f.deployment === 'onsite';
  const cloudAi = f.ai.policy !== 'local-only' && f.ai.geminiSource !== 'none';
  const list: DataRecipient[] = [
    onsite
      ? { id: 'hosting', name: '会社の中の機械（ローカルの形）', purpose: 'M2Office を動かし、データを置く', data: 'すべての業務のデータ（預かった鍵は暗号化して保管）', location: '会社の中', contract: 'machine', active: true }
      : { id: 'hosting', name: f.hosting.provider ?? `インフラ事業者${UNSET}`, purpose: 'M2Office を動かし、データを置く', data: 'すべての業務のデータ（通信と保管を暗号化。預かった鍵はさらに暗号化）', location: f.hosting.location ?? UNSET, contract: 'operator', active: true },
    {
      id: 'gemini', name: 'Google（Gemini API）', purpose: '秘書と業務の推論（文の読み書き・画像と音声の読み取り・Web の調べもの）',
      data: '依頼の文と、業務が読んだ文・画像・音声（会社の AI の方針で外部の AI に渡さないものは除く）。M2Office は学習に使わせない（第11.9.3節）',
      location: '国外を含む（Google の設備）', contract: f.ai.geminiSource === 'tenant' ? 'company' : 'operator', active: cloudAi,
    },
    ...(f.ai.localConfigured ? [{ id: 'local-ai', name: '社内の AI（ローカル AI）', purpose: '外部の AI に渡さない推論', data: '会社の AI の方針で社外に出さない文', location: '会社の中', contract: 'machine' as const, active: f.ai.policy !== 'cloud' }] : []),
    {
      id: 'google-workspace', name: 'Google Workspace（会社の Google）', purpose: 'ログインと、メール・予定・ドライブ・Chat などを業務から使う',
      data: '本人が許した範囲で読み書きする中身（メールの下書き・予定・文書など）', location: '会社の Google の契約による', contract: 'company', active: true,
    },
    { id: 'google-chat-app', name: 'Google Chat（会社の Chat アプリ）', purpose: '通知の控えを本人に届ける', data: '通知の題と本文', location: '会社の Google の契約による', contract: 'company', active: f.credentials.has('google_chat_app') },
    { id: 'line', name: 'LINE（会社の LINE 公式アカウント）', purpose: '問い合わせの受け付けと返事', data: '問い合わせのやり取り', location: 'LINE の設備', contract: 'company', active: f.extensions.inquiries && f.credentials.has('line') },
    { id: 'mailbox', name: '窓口のメール（会社の Gmail）', purpose: '問い合わせのメールの受け付けと返事', data: '問い合わせのメールのやり取り', location: '会社の Google の契約による', contract: 'company', active: f.extensions.inquiries && f.credentials.has('inquiry_mailbox') },
    { id: 'wordpress', name: '会社の WordPress', purpose: 'コラムの公開', data: 'コラムの本文と画像', location: '会社の Web サイトの置き場', contract: 'company', active: f.extensions.columns && f.credentials.has('wordpress') },
    { id: 'places', name: 'Google（地図の API）', purpose: '競合の見つけと見回り', data: '会社の地域と、競合の名前（個人の情報は渡さない）', location: '国外を含む（Google の設備）', contract: 'company', active: f.extensions.competitors && f.credentials.has('places') },
    { id: 'web-review', name: 'Google（アナリティクス・Search Console・PageSpeed Insights）', purpose: 'Web の分析', data: '会社の Web サイトの URL（アクセスの数字は読むだけ）', location: '国外を含む（Google の設備）', contract: 'company', active: f.extensions.webReview && f.credentials.has('web_review') },
    ...(f.canvaAvailable ? [{ id: 'canva', name: 'Canva', purpose: '販促物を Canva で仕上げる（本人がつないだとき）', data: '販促物のデザインと画像', location: '国外を含む（Canva の設備）', contract: 'operator' as const, active: f.extensions.printDesigns }] : []),
    ...f.connectors.map((c) => ({
      id: `connector:${c.id}`, name: `${c.name}（コネクタ。${host(c.url)}）`, purpose: '会社が登録したコネクタの道具を業務が呼ぶ', data: '業務が道具に渡す入力（会社の AI の方針で社外に出さないものは除く）',
      location: '接続先の事業者による', contract: 'company' as const, active: true,
    })),
  ];
  return list;
}
