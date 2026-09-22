# 6. 検証・導入・動作確認

## 6.1 検証する

```bash
npm run ext:validate                          # extensions/ の下をすべて
npm run ext:validate extensions/hello-world   # 1 つだけ
```

API が起動時に行う検証と同じものです（仕様書 第12.9.2節）。

| # | 確かめること |
|---|---|
| 1 | マニフェストの必須項目と形式 |
| 2 | 定義が基盤の規則を満たす（承認ゲート、登録されたツール、ステップ ID の重複など） |
| 3 | 定義のツールが `permissions.tools` の中にある |
| 4 | 定義のツールの危険度が `max_risk_level` を超えない |
| 5 | `help.summary` がある |
| 6 | 業務エージェントの ID が他と重ならない |

見本の応答が 1 つも無いと、「鍵が無い環境では動作を確かめられません」と注意が出ます。

## 6.2 導入して動かす

1. `npm run dev` を起動し直す（ログに `拡張機能を読み込みました` と出る）
2. 管理者ページの「拡張機能」で「導入する」→ 権限を確かめて「同意して導入する」
3. ワークスペースのメニューに現れた業務を実行する
4. 実行の詳細で、ステップの記録と成果物を確かめる

API で確かめることもできます（開発用のヘッダーを使う例）。

```bash
# 導入（管理者）
curl -X POST -H 'x-tenant: a' -H 'x-user: admin@alpha.example.jp' -H 'content-type: application/json' \
  -d '{"consent":true}' http://localhost:3101/v1/admin/extensions/jp.m2office.samples.hello-world/install

# 実行
curl -X POST -H 'x-tenant: a' -H 'x-user: member@alpha.example.jp' -H 'content-type: application/json' \
  -d '{"agentId":"jp.m2office.samples.hello-world:hello","input":{"message":"こんにちは"}}' \
  http://localhost:3101/v1/jobs

# 結果（runId は上の応答のもの）
curl -H 'x-tenant: a' -H 'x-user: member@alpha.example.jp' http://localhost:3101/v1/runs/<runId>
```

`npm run smoke` の「■ 20. 拡張機能」は、この流れ（導入していない会社で使えない、同意なしで導入できない、
他の会社には現れない、削除すると使えない）を毎回確かめています。

## 6.3 よくあるエラーと直し方

| 出るメッセージ | 原因 | 直し方 |
|---|---|---|
| `manifest.json がありません` | ディレクトリの直下に無い | `extensions/<名前>/manifest.json` に置く |
| `id は逆ドメイン名の形で書いてください` | 大文字や記号が入っている | `jp.example.my-agent` のように書く |
| `マニフェストの permissions.tools に無いツールを使っています` | 定義の `tools` に、宣言していないツールがある | マニフェストに足すか、定義から外す |
| `max_risk_level（draft）を超えるツールを使っています` | 宣言より強いツールを使っている | 本当に必要か見直す。必要なら `max_risk_level` を上げる（管理者の判断が重くなる） |
| `承認ゲートが必要です` | `external-send` 以上のツールを使うのに承認ステップが無い | 送信するステップの**直前**に承認ステップを置く |
| `help.summary がありません` | ヘルプの概要が無い | 定義に `help.summary` を書く |
| `未登録のツールを要求しています` | ツールの名前の誤り | 第4章の一覧の名前にする |
| `ID … はすでに使われています` | 他の拡張機能と ID が重なる | 拡張機能の `id` を変える |
| 実行が「この業務は、この会社に導入されていません」で失敗 | 実行の途中で導入をやめた | 導入し直す |
| 成果物が無く「見本の応答がありません」と記録される | 見本に無い入力で実行した（鍵が無い環境） | `evals` に、その入力のケースを足す |

## 6.4 本物の LLM で確かめる

`.env` に `LLM_PROVIDER=gemini` と `GEMINI_API_KEY` を設定すると、見本ではなく本物の推論で動きます。
評価のケースの `expect` と結果を見比べ、指示（`instruction`）を直してください。
