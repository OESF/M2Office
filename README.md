# M2Office

> 現在の版: v0.23.0（2026-10-29）。変更の履歴は [CHANGELOG.md](CHANGELOG.md)

中小企業向けの AI エージェントシステムです。従業員ひとりひとりに AI の秘書が付き、メール・予定・文書・社内の規程を踏まえて仕事を手伝います。
定型の業務は業務エージェントが代わりに行い、**社外への送信とお金の確定だけは、人の承認を経てから**実行します。
Google Workspace とつないで使い、会社ごとに分けた 1 つのサービスとして、クラウドか社内の機械で動かします。

## 特徴

- **秘書**: 会話で頼むと、予定・メール・ToDo・社内の知識をもとに答え、業務を始めます
- **業務エージェント**: 見積書・請求書などの書類、スライドと文書の作成、在庫、人事・給与、問い合わせの対応など
- **承認の関門**: 社外に出るものとお金の確定は、承認するまで実行しません。止めた業務は承認の後にそこから続けます
- **会社ごとの分離**: データはすべて会社ごとに分け、データベースの行の単位でも守ります
- **拡張機能**: 業務と外部のサービスへの接続（MCP）を、1 つのファイルで足せます

## 必要なもの

| もの | 内容 |
|---|---|
| Node.js | 22 以上 |
| Docker | データベース（PostgreSQL 17 と pgvector）を動かす |
| Gemini の API の鍵 | AI の推論に使う。[Google AI Studio](https://aistudio.google.com/) で出す |
| Google Workspace | 本番で使うときに要る。手元で試すだけなら無くても動く（予定やメールは見本のデータになる） |

## 手元で試す

```bash
git clone https://github.com/OESF/M2Office.git
cd M2Office
cp .env.example .env
```

`.env` の `GEMINI_API_KEY=` に、Gemini の API の鍵を書きます。

```bash
npm install
npm run db:reset
npm run dev
```

ブラウザで http://a.lvh.me:3100 を開き、「開発用ログイン」から利用者を選びます。管理者を選ぶと、上の「管理者ページ」で会社の設定を変えられます。
見本の会社は 2 つあり、http://b.lvh.me:3100 がもう 1 つの会社です。

音声で話す・HTTPS で動かすなど、詳しい動かし方は [開発者ガイド](docs/development.md) にあります。

## 本番で使う

| 形 | 向いている使い方 | 手順 |
|---|---|---|
| クラウド（VPS） | 多くの会社に、サブドメインごとにサービスとして出す | [deploy/vps/README.md](deploy/vps/README.md)（運営者マニュアル [第 13 章](docs/ops-manual/13-vps-setup.md)・[第 14 章](docs/ops-manual/14-vps-m2office-setup.md)） |
| 社内の Mac | 1 つの会社が、社内の機械とローカルの AI で使う | [deploy/onsite/README.md](deploy/onsite/README.md) |

どちらも、GitHub のリリースのタグ（`v` で始まる版）を入れます。Google Workspace とのつなぎ方は [docs/google-setup.md](docs/google-setup.md) にあります。

## ドキュメント

| 文書 | 読む人 | 内容 |
|---|---|---|
| [開発者ガイド](docs/development.md) | 開発する人 | 開発環境の詳しい動かし方・テスト・拡張機能・ログ・構成・環境変数 |
| [実装状況](docs/implementation-status.md) | 全員 | いま入っている機能と、まだのもの |
| [開発者マニュアル](docs/developer/README.md) | 拡張機能を作る人 | 業務エージェントとコネクタの作り方 |
| [運営者マニュアル](docs/ops-manual/README.md) | サービスを運営する人 | マスター管理画面の使い方と、VPS への入れ方 |
| [ヘルプの記事](docs/help/) | 利用者 | 画面のヘルプセンターに出る記事 |
| [人事・給与](docs/manual/hr-payroll/README.md)・[在庫管理](docs/manual/inventory/README.md) | 担当者 | 業務のユーザーマニュアル |
| [仕様書](specification.md)（[spec/](spec/)） | 設計する人 | システムの仕様の全体（設計の正） |
| [開発規約](docs/coding-standards.md)・[リリース規定](docs/release-process.md) | 開発する人 | コードの書き方と、版の上げ方 |
| [設計判断の記録](docs/adr/) | 設計する人 | なぜそう決めたか |

## ライセンス

[Apache License 2.0](LICENSE) で公開しています。著作権の表示は [NOTICE](NOTICE) にあります。
