# MtG-Deckbuild-MCP

Scryfall API に接続し、AI モデルが Magic: The Gathering の実践的なデッキ構築を行えるようにする MCP サーバーです。

## 機能

- Scryfall のカード検索、曖昧カード名解決、フォーマット別リーガリティ確認
- フォーマット、色、ギミック、予算、パワーレベルを考慮したカード提案
- Commander / Brawl / Oathbreaker のシングルトン構築と 60 枚構築の基本構造に対応
- 土地、ランプ、ドロー、除去、シナジー、勝ち筋、サイドボードをカテゴリ分けして提案
- MTGDecks、MTGGoldfish、MTGTop8 の大会結果ページを出典として返す参照ツール
- 既存デッキリストの枚数、カード解決、リーガリティ、シングルトン問題の簡易分析

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

初回のみ `npx wrangler login` で Cloudflare アカウントにログインしてください。

```bash
npm run deploy
```

デプロイ後、`https://mtg-deckbuild-mcp.<あなたのサブドメイン>.workers.dev/mcp` が公開エンドポイントになります。認証なし(authless)で公開されるため、扱う情報が公開の MTG カードデータのみであることを踏まえて運用してください。

### 自動デプロイ(GitHub Actions)

`main` ブランチへの push(`src/`、`wrangler.jsonc`、`package.json` の変更時)で [.github/workflows/deploy.yml](.github/workflows/deploy.yml) が自動的に `wrangler deploy` を実行します。手動実行(`workflow_dispatch`)にも対応しています。

初回セットアップとして、GitHub リポジトリの Settings → Secrets and variables → Actions に以下を登録してください。

| Secret | 値 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare ダッシュボードで発行する API トークン。「Edit Cloudflare Workers」権限のみに絞ったカスタムトークンを推奨 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボードのアカウント ID(ダッシュボード右側サイドバーで確認可能) |

登録後は `npm run deploy` を手動実行する必要はなく、`main` への push だけでデプロイされます。

### Claude Web でカスタムコネクタとして接続

1. claude.ai の設定 → コネクタ → 「カスタムコネクタを追加」
2. 上記の `/mcp` で終わる URL を入力(認証不要)
3. 接続後、チャットで `search_cards` などのツールが利用可能になります

### Grok でカスタムコネクタとして接続

1. grok.com/connectors → **New Connector** → **Custom**
2. 上記の `/mcp` で終わる URL を入力
3. ツールが自動検出されれば接続完了です

### 既知の制約

- Scryfall API 向けのレート制御(約90ms間隔)はインスタンス内メモリに依存しています。Workers はリクエストごとに別アイソレートで実行される場合があるため、ベストエフォートの制御になります。個人利用程度のトラフィックでは問題になりません。
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

## 出典と注意

- カードデータ、画像 URL、価格、リーガリティは Scryfall API を参照します。
- Scryfall API の要件に従い、`User-Agent` と `Accept` ヘッダーを送信します。
- 大会結果の参照は MTGDecks、MTGGoldfish、MTGTop8 の公開ページ URL と取得可能なスニペットを返します。
- 生成されたリストは構築のたたき台です。大会参加前に最新禁止改定、イベント規定、ローカルメタに合わせて調整してください。
