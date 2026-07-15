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
