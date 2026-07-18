# MtG-Deckbuild-MCP

Scryfall API に接続し、AI モデルが Magic: The Gathering の実践的なデッキ構築を行えるようにする MCP サーバーです。

## 機能

- Scryfall のカード検索、曖昧カード名解決、フォーマット別リーガリティ確認
- フォーマット、色、ギミック、予算、パワーレベルを考慮したカード提案
- Commander / Brawl / Oathbreaker のシングルトン構築と 60 枚構築の基本構造に対応
- 土地、ランプ、ドロー、除去、シナジー、勝ち筋、サイドボードをカテゴリ分けして提案
- MTGDecks、MTGGoldfish、MTGTop8 の大会結果ページを出典として返す参照ツール
- 既存デッキリストの枚数、カード解決、リーガリティ、シングルトン問題の簡易分析
- 対話形式でカラー・キーワード能力・プレイスタイルを聞き取りながら最適デッキを提案するウィザード
- 既存デッキ中の高価カードに対する廉価な代替候補の提案(概算節約額付き)
- マイデッキの保存・一覧・取得・編集・削除(Workers KV / ローカル JSON ファイル)
- Cloudflare Workers Secret に保存したトークンによる Bearer 認証(マイデッキ機能をゲート)

## セットアップ

```bash
npm install
npm run build
```

## MCP クライアント設定例

```json
{
  "mcpServers": {
    "mtg-deckbuild": {
      "command": "node",
      "args": ["C:/github/MtG-Deckbuild-MCP/dist/index.js"]
    }
  }
}
```

開発中は以下でも起動できます。

```bash
npm run dev
```

## Cloudflare Workers へのリモートデプロイ

stdio 版とは別に、Cloudflare Workers 上でリモート MCP サーバー(Streamable HTTP、`/mcp` エンドポイント)としても動作します。ツール定義は `src/server.ts` の `createServer()` に共通化されており、stdio(`src/index.ts`)と Workers(`src/worker.ts`)の両エントリから利用されます。

### ローカル確認

```bash
npm run dev:worker
```

`http://127.0.0.1:8787/mcp` が MCP エンドポイントになります。[MCP Inspector](https://github.com/modelcontextprotocol/inspector) や `curl` の Streamable HTTP リクエストで動作確認できます。

### デプロイ

初回のみ `npx wrangler login` で Cloudflare アカウントにログインし、マイデッキ保存用の KV ネームスペースを作成してください。

```bash
npx wrangler kv namespace create DECKS
```

出力された `id` を `wrangler.jsonc` の `kv_namespaces` の `id`(`REPLACE_WITH_KV_NAMESPACE_ID`)に貼り付けます。続いて認証トークンを Workers Secret に登録します。

```bash
npx wrangler secret put AUTH_TOKEN   # 任意の長いランダム文字列を入力
```

```bash
npm run deploy
```

デプロイ後、`https://mtg-deckbuild-mcp.<あなたのサブドメイン>.workers.dev/mcp` が公開エンドポイントになります。

### 認証(AUTH_TOKEN)

Scryfall の公開 API 自体にはトークンやログインの仕組みがないため、本サーバーが独自に Bearer トークン認証を提供します。トークンは Cloudflare Workers の Secret(`AUTH_TOKEN`)として保存され、MCP クライアントは `Authorization: Bearer <トークン>` ヘッダーを送信することでログイン状態になります。

- `AUTH_TOKEN` 未設定: オープンモード。すべてのツールが認証なしで利用可能(ローカル開発向け)
- `AUTH_TOKEN` 設定済み・ヘッダーなし: カードデータ系ツールは利用可能、マイデッキ系ツールはエラーを返す(Scryfall の「カードデータをペイウォール化しない」ガイドラインに準拠)
- `AUTH_TOKEN` 設定済み・トークン一致: 認証済み。マイデッキ系ツールが利用可能
- `AUTH_TOKEN` 設定済み・トークン不一致: HTTP 401(`WWW-Authenticate: Bearer`)

複数ユーザーで使う場合は、Secret `AUTH_TOKENS` に `{"トークン": "ユーザーID"}` 形式の JSON を登録すると、ユーザーごとにマイデッキが分離されます。

ローカルの `wrangler dev` では `.dev.vars` ファイル(gitignore 済み)に `AUTH_TOKEN=devtoken` のように書くと同じ挙動を確認できます。

stdio 版(`dist/index.js`)はローカル単一ユーザー前提のため常に認証済みとして動作し、デッキは `~/.mtg-deckbuild-mcp/decks/local/` に JSON ファイルとして保存されます。

### 自動デプロイ(GitHub Actions)

`main` ブランチへの push(`src/`、`wrangler.jsonc`、`package.json` の変更時)で [.github/workflows/deploy.yml](.github/workflows/deploy.yml) が自動的に `wrangler deploy` を実行します。手動実行(`workflow_dispatch`)にも対応しています。

初回セットアップとして、GitHub リポジトリの Settings → Secrets and variables → Actions に以下を登録してください。

| Secret | 値 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare ダッシュボードで発行する API トークン。「Edit Cloudflare Workers」権限のみに絞ったカスタムトークンを推奨 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボードのアカウント ID(ダッシュボード右側サイドバーで確認可能) |

登録後は `npm run deploy` を手動実行する必要はなく、`main` への push だけでデプロイされます。

> **注意**: `wrangler.jsonc` の KV ネームスペース `id` が実際の値に置き換えられるまで、自動デプロイは失敗します(Secret はデプロイをまたいで保持されるため、ワークフロー側の変更は不要です)。

### Claude Web でカスタムコネクタとして接続

1. claude.ai の設定 → コネクタ → 「カスタムコネクタを追加」
2. 上記の `/mcp` で終わる URL を入力(`AUTH_TOKEN` を設定した場合は Bearer トークンとして入力)
3. 接続後、チャットで `search_cards` などのツールが利用可能になります

### Grok でカスタムコネクタとして接続

1. grok.com/connectors → **New Connector** → **Custom**
2. 上記の `/mcp` で終わる URL を入力
3. ツールが自動検出されれば接続完了です

### 既知の制約

- Scryfall API 向けの段階的レート制御はインスタンス内メモリに依存しています。Workers はリクエストごとに別アイソレートで実行される場合があるため、ベストエフォートの制御になります。個人利用程度のトラフィックでは問題になりません。
- `find_tournament_decks` は1回の呼び出しで最大3件の外部サイトへ fetch します。

## 公開ツール

| Tool | 用途 |
| --- | --- |
| `search_cards` | Scryfall 構文、フォーマット、色、ギミックでカード検索 |
| `get_card_details` | カード詳細、テキスト、価格、リーガリティ、Scryfall URL を取得 |
| `recommend_cards` | デッキ方針に合うカードをカテゴリ別に提案 |
| `build_deck` | 実践用のデッキシェルとデッキリストを生成 |
| `analyze_deck` | 既存デッキリストを簡易検証 |
| `find_tournament_decks` | 大会結果ページの引用スニペットと出典 URL を取得 |
| `deck_wizard` | 対話形式でカラー・キーワード能力・プレイスタイル等を聞き取り、最適デッキを構築 |
| `suggest_budget_alternatives` | デッキ中の高価カードを検出し、廉価な代替候補と概算節約額を提示 |
| `save_deck` | マイデッキを保存(要認証) |
| `list_decks` | 保存済みデッキの一覧(要認証) |
| `get_deck` | 保存済みデッキの取得(要認証) |
| `update_deck` | デッキ名・メモ・リストの編集、カードの追加/削除(要認証) |
| `delete_deck` | 保存済みデッキの削除(要認証) |

### デッキウィザードの使い方

`deck_wizard` はステートレスな対話ツールです。引数なしで呼び出すと不足している設定(フォーマット、カラー、プレイスタイルなど)への質問が `questions` として返ります。クライアント(AI)はユーザーの回答を返却された `state` にマージして再度呼び出します。必須項目が揃うとデッキが構築されます。`format` と `colors` が揃っていれば `finalize: true` で即座に構築することもできます。

### マイデッキの編集例

```json
{
  "id": "<get_deck や list_decks で取得した id>",
  "addCards": ["2 Lightning Bolt"],
  "removeCards": ["Shock"]
}
```

## 使用例

```json
{
  "format": "pioneer",
  "colors": ["B", "R"],
  "strategy": "Rakdos sacrifice",
  "mechanics": ["sacrifice", "graveyard"],
  "budget": "mid",
  "powerLevel": "competitive",
  "includeSideboard": true
}
```

Commander の例です。

```json
{
  "format": "commander",
  "colors": ["G", "U"],
  "strategy": "Simic landfall ramp",
  "mechanics": ["landfall", "ramp", "draw"],
  "commander": "Aesi, Tyrant of Gyre Strait",
  "budget": "mid",
  "powerLevel": "focused"
}
```

## Scryfall API ガイドライン準拠

本サーバーは [Scryfall API ドキュメント](https://scryfall.com/docs/api)の規約に従って実装されています。

- **必須ヘッダー**: すべての Scryfall リクエストにアプリケーション固有の `User-Agent`(`src/config.ts` で一元管理、バージョン付き)と `Accept: application/json` を送信します
- **レート制限**: エンドポイント種別ごとの段階的レート制御(検索・カード名解決などの heavy 系 500ms 間隔、autocomplete などの light 系 100ms 間隔、bulk-data 系 10 秒間隔)を行い、HTTP 429 受信時は `Retry-After` ヘッダーを尊重した指数バックオフで再試行します
- **キャッシュ**: レスポンスを最大 24 時間インメモリキャッシュし、Scryfall への不要なリクエストを削減します
- **非ペイウォール**: カードデータ系ツールは認証なしで利用できます。認証(`AUTH_TOKEN`)がゲートするのは個人のデッキ保存機能のみです
- **付加価値**: 本ソフトウェアは Scryfall データの単純な再配布ではなく、デッキ構築・分析・推奨という付加価値を提供します

## 出典と注意

- カードデータ、画像 URL、価格、リーガリティは Scryfall API を参照します。
- 大会結果の参照は MTGDecks、MTGGoldfish、MTGTop8 の公開ページ URL と取得可能なスニペットを返します。
- 生成されたリストは構築のたたき台です。大会参加前に最新禁止改定、イベント規定、ローカルメタに合わせて調整してください。
