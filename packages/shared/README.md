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
