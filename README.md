# 推しガチャ開封所

MUZE TOOL BOX のツール。銀袋を指で切って開ける、MAZZELアー写カードのランダム開封ごっこです。
開封所を作って招待リンクを送ると、お友達がそれぞれのスマホから同じ開封所に参加でき、自引きランキング・開封の流れ・交換できる組み合わせがリアルタイムで並びます。

- GitHub Pages 対応の静的サイト（ビルド不要）
- 共有には Firebase（匿名ログイン + Firestore、無料枠）を使用
- Firebase の設定が空のときは、この端末だけに保存する「ひとりモード」で動きます

## ファイル構成

| パス | 内容 |
| --- | --- |
| `index.html` | ページ本体（MUZE TOOL BOX 共通ヘッダー付き） |
| `assets/style.css` | 「作業机」ブランドのスタイル |
| `assets/app.js` | ガチャ・開封所・共有のロジック |
| `assets/firebase-config.js` | Firebase の設定（ここに貼る） |
| `firestore.rules` | Firestore のセキュリティルール（Firebaseコンソールに貼る） |
| `photos/<member>/01〜18.jpg` | 各メンバーのアー写カード（15枚＋最新アー写3枚） |
| `photos/group/01〜16.jpg` | シークレット「MAZZEL 集合」用の集合写真 |

## セットアップ

1. Firebase コンソールでプロジェクトを作成
2. Authentication → ログイン方法 → **匿名** を有効化
3. Firestore Database を作成（`asia-northeast1`、本番環境モード）
4. Firestore → ルール に `firestore.rules` の中身を貼って公開
5. プロジェクトの設定 → マイアプリ → ウェブアプリを追加し、`firebaseConfig` を `assets/firebase-config.js` に貼る
6. GitHub の Settings → Pages で `main` ブランチの `/ (root)` を公開

## データの形

```
rooms/{開封所コード}                 { owner, price, secretRate, createdAt }
rooms/{開封所コード}/players/{uid}   { name, oshi, inv, shots, pulls, hits, queue, recent }
```

- `inv`: メンバーごとの枚数
- `shots`: メンバーごとに集めたアー写の番号（0始まり）
- `recent`: 直近15回の開封（`{m: メンバーID, s: アー写番号, t: 時刻, hit: 自引きか}`）

## メンバー・写真の差し替え

メンバーは `assets/app.js` の `NAMES` と、`photos/` 以下のフォルダ名（小文字）で決まります。
写真を足すときは `photos/<member>/` に連番で追加し、`nums(18)` の枚数を合わせてください。
