/**
 * @file AI の利用の用途の名前（仕様書 第6.6.2節「AI の利用の記録と上限」・第6.7.13節）。
 *
 * 用途は入口が付ける口の名前（`api:<口>`・`worker:<処理>`・`agent:<業務>`・`secretary` など）。管理者ページの利用状況と効果のレポートで、同じ言葉にする。
 */

import { agentDisplayName } from '@m2office/shared';

/** 口の名前（`api:<口>`・`worker:<処理>`）を、利用状況に出す業務の言葉にする。 */
const PURPOSE_LABELS: Record<string, string> = {
  secretary: '秘書', voice: '音声の秘書', other: 'そのほか', worker: '自動の処理',
  'api:columns': 'コラムの作成', 'api:print-designs': '販促物の作成', 'api:competitors': '競合の分析', 'api:cards': '名刺管理',
  'api:inventory': '在庫管理', 'api:signage': 'サイネージ', 'api:announcements': 'お知らせの作成', 'api:inquiries': '問い合わせの記録',
  'api:web-review': 'Webの分析', 'api:contracts': '契約書の管理', 'api:subsidies': '補助金・助成金', 'api:members': '会員とポイント',
  'api:hr': '人事・給与', 'api:reservations': '予約', 'api:knowledge': '知識', 'api:files': 'ファイル', 'api:me': '個人設定', 'api:admin': '管理者ページ',
  'api:effect': '効果のレポート',
  'worker:competitors': '競合の分析（見回り）', 'worker:columns': 'コラムの作成（予定とテーマ案）', 'worker:web-review': 'Webの分析（月の便り）',
  'worker:subsidies': '補助金・助成金（月の調べもの）', 'worker:knowledge': '秘書が学んだことの整理', 'worker:knowledge-embed': '知識の意味の検索の準備', 'worker:proactive': '秘書の先回り',
  'worker:memory': '会話から覚えること', 'worker:inquiries': '問い合わせの見張り', 'worker:announcements': 'お知らせの作成（予約）',
  'worker:effect': '効果のレポート（毎月）', 'worker:profile': '秘書の本人の像',
};

/**
 * 用途の名前（業務は業務の名前）。
 *
 * @param purpose 記録の用途（`purposeGroup` でまとめたもの）
 * @param agents 会社で使える業務（業務の名前を引く）
 */
export function purposeLabel(purpose: string, agents: { id: string; name: string }[]): string {
  if (purpose.startsWith('agent:')) {
    const id = purpose.slice(6);
    return agentDisplayName(agents.find((a) => a.id === id)?.name, id);
  }
  return PURPOSE_LABELS[purpose] ?? (purpose.startsWith('api:') ? `画面の操作（${purpose.slice(4)}）` : purpose.startsWith('worker:') ? `自動の処理（${purpose.slice(7)}）` : purpose);
}
