# @m2office/shared

型定義と定数だけを置くパッケージ。画面・API・ワーカーが共通で参照します。

**実装（ドメインロジック）は置きません。** それは `@m2office/core` の役割です。

## 前提

Node.js 22 以上。単体では動かさず、他のパッケージから参照されます。

## 構成

```
src/types/agent.ts    エージェント定義のスキーマ（schema_version: 1）と危険度
src/types/run.ts      ジョブ・実行・ステップ・承認・成果物
src/types/tenant.ts   テナント・利用者・要求ごとの文脈
src/types/audit.ts    監査ログ
src/types/cards.ts    名刺管理（連絡先・名刺・読み取った項目・範囲。仕様書 第27章）
src/types/deliveries.ts 外部のアプリからの配信の依頼（依頼・結果・停止の形・上限 DELIVERY_MAX_RECIPIENTS・1 日の上限・照合の値と結果を持つ日数。仕様書 第13.4.4節）
src/types/slide-designs.ts スライドの組み込みのデザイン（SLIDE_DESIGNS の 6 つ・色・字体・表紙の飾り・findSlideDesign。組み立てと画面の見本の絵が同じ定義を使う。仕様書 第9.4.2節）
src/types/sales-docs.ts 販売の書類と受注（書類・受注・品目・候補・会社の設定。仕様書 第42章）
src/types/tax.ts      消費税の区分と日付で変わる税率（税率の表 TAX_RATE_TABLE・予定の変更・品名からの区分の推し量り・帳票の印と内訳。制度が変わったら更新で直す。仕様書 第15.1.1節）
src/types/runtime.ts  動いている環境（Node.js のサポートの表 NODE_RELEASE_LINES とセキュリティの修正の下限 secure・nodeSupport・compareNodeVersions・環境の形。リリースのたびに公式の予定とセキュリティの発表と見比べる。仕様書 第8.6.7.1節）
```

## 主なもの

| 名前 | 内容 |
|---|---|
| `AgentDefinition` | エージェント定義。条件分岐を持たない（仕様書 第9.2.1節） |
| `RiskLevel` | ツールの危険度。承認の要否を決める |
| `alwaysRequiresApproval()` | `external-send` 以上かどうかを判定する |
| `RunStatus` | 実行の状態。`awaiting_approval` が中断を表す |
| `RequestContext` | 要求ごとに確定するテナント境界 |

## 関連文書

- 仕様書 [第9.2節 エージェント定義のスキーマ](../../spec/09-agent-platform.md)
- 仕様書 第19.1節 主要エンティティ
