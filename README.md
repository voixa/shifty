# Shifty — AI シフト自動作成 SaaS

飲食店向け、AI 自動最適化のシフト管理ツール。**飲DX** の第二弾プロダクト（VOIXA に続く）。

🌐 **公開URL**: https://shifty.in-dx.jp / https://shifty-1028920472559.asia-northeast1.run.app

## 🎯 サービス概要

- **ターゲット**: 飲食店オーナー（個人店〜中規模チェーン）
- **コア価値**: シフト作成 4 時間 → 5 分（自動化）
- **料金** (Round 40 で 4 段階化):
  - **Free**: ¥0/月（永久無料・1 店舗・8 名まで）
  - **Pro**: ¥1,980/月（1 店舗・スタッフ無制限）
  - **Business**: ¥4,980/月（5 店舗まで・全店舗集計）
  - **Enterprise**: 要相談（6 店舗以上）
- **トライアル**: 有料プラン 14 日間無料・クレカ不要

## 🧱 主な機能

| カテゴリ | 機能 |
|---|---|
| AI 最適化 | 2段階制約充足アルゴリズム / 動的時間切り出し / モデルシフト / 5 戦略プリセット |
| 希望収集 | モバイルポータル / セッション 4 ボタン / 自由時間入力 / 複数週同時提出 |
| シフト編成 | ドラッグ&ドロップ / 入替モード / クイックアサイン / 緊急代打 |
| 打刻 | 出退勤打刻 / 予実比較 / 実績ベース給与計算 |
| 通知 | メール / Webhook (Slack/Discord/IFTTT) / Web Push (Round 34) |
| 多店舗 | 1 オーナー × 最大 5 店舗 / 全店舗集計ダッシュボード |
| エクスポート | 給与計算 CSV (弥生/freee) / 印刷ビュー (店内/個人/詳細) / 週次/月次 PDF |
| 経営管理 | 売上連動人件費率 / 業界ベンチマーク / 月次労務リスク警告 |
| アクセス | パスワードレス magic link 認証 / マルチテナント / Stripe 決済 |
| その他 | PWA / ダークモード / 38 カ所のキーボードショートカット / Cmd+K コマンドパレット |

## 🏗️ アーキテクチャ

```
┌────────────────────────┐         ┌──────────────────────┐
│   shifty.in-dx.jp/     │         │   shifty.in-dx.jp/   │
│   (Landing Page)       │         │   staff?t={token}    │
└─────────┬──────────────┘         └──────────┬───────────┘
          │                                    │
┌─────────▼──────────────┐         ┌──────────▼───────────┐
│   shifty.in-dx.jp/app  │         │ Mobile portal        │
│   (Admin App)          │         │ (Token auth)         │
└─────────┬──────────────┘         └──────────┬───────────┘
          │                                    │
          ▼                                    ▼
        ┌─────────────────────────────────────────┐
        │  Cloud Run (server.py / Flask + gunicorn)│
        │   ├─ /api/auth/*                        │
        │   ├─ /api/state    (要認証)            │
        │   ├─ /api/admin/*  (要認証)            │
        │   ├─ /api/portal/{token} (公開)        │
        │   └─ /api/inquiry  (公開, LP用)        │
        └────────────────┬────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Firestore Native   │
              │   ├─ shifty/state    │
              │   ├─ shifty/config   │
              │   ├─ shifty_tokens/* │
              │   └─ shifty_inquiries│
              └──────────────────────┘
```

## 🚀 セットアップ

### ローカル開発

```bash
git clone <repo>
cd shift-ai
pip install -r requirements.txt
python server.py  # http://localhost:5173
```

ローカルでは SQLite (`shifty.db`) を使用。

### 本番デプロイ（Cloud Run + Firestore）

```bash
# 初回のみ
bash deploy.sh

# 以降は GitHub Actions が自動デプロイ
git push origin main
```

### カスタムドメイン設定

```bash
bash setup_domain.sh
# 出力されたCNAMEを in-dx.jp の DNS に登録
```

## 📂 ファイル構成

```
shift-ai/
├── 🌐 公開ファイル
│   ├── landing.html       # ランディングページ (/)
│   ├── tos.html           # 利用規約
│   ├── privacy.html       # プライバシーポリシー
│   ├── tokushoho.html     # 特定商取引法に基づく表記
│   ├── index.html         # 管理画面 (/app)
│   ├── staff.html         # スタッフポータル (/staff)
│   ├── styles.css
│   ├── manifest.json      # PWA
│   └── sw.js              # Service Worker
│
├── 📜 JS
│   ├── js/api.js          # REST クライアント
│   ├── js/data.js         # データ層
│   ├── js/algorithm.js    # 2段階制約充足アルゴリズム
│   ├── js/app.js          # 管理画面 (~1700行)
│   └── js/staff-portal.js # ポータル
│
├── 🔧 サーバ
│   ├── server.py          # Flask + Storage 抽象化
│   └── requirements.txt
│
├── 🚢 デプロイ
│   ├── Dockerfile         # Cloud Run コンテナ
│   ├── .gcloudignore
│   ├── .dockerignore
│   ├── deploy.sh          # gcloud run deploy ワンコマンド
│   ├── setup_domain.sh    # カスタムドメイン設定
│   └── .github/workflows/deploy.yml  # CI/CD
│
├── 📚 ドキュメント
│   ├── README.md
│   ├── LAUNCH.md          # ローンチガイド
│   └── docs/marketing.md  # X/Note/営業テンプレ
│
└── 🔒 設定
    ├── .env.example
    └── .gitignore
```

## 🔧 環境変数

| 変数 | 用途 | 本番値 |
|---|---|---|
| `STORAGE_BACKEND` | sqlite / firestore | `firestore` |
| `SECRET_KEY` | Flask セッション署名 | Secret Manager `SHIFTY_SECRET_KEY` |
| `ADMIN_PASS` | 初回起動時の管理者パスワード | （任意） |
| `FLASK_ENV` | production で Secure Cookie 有効 | `production` |
| `PORT` | 待ち受けポート | Cloud Run が設定 |

## 📊 ロードマップ (R1-R40 完了)

- [x] Round 1-7: コア機能実装（AI生成、複数週、認証、PWA等）
- [x] Round 8-13: Cloud Run / Firestore / Stripe / 弥生・freee 連携
- [x] Round 14-23: 機能拡張（QR / 深夜手当 / シフト交換 / 打刻 / 売上連動 / 多店舗）
- [x] Round 24-32: UX 大幅改善（タブ統合 / コマンドパレット / 業態ウィザード / ヘルスチェック）
- [x] Round 33-39: 性能・セキュリティ・ダークモード polish
- [x] Round 40: 料金プラン 4 段階化 (Business 新設)

## 📞 お問い合わせ

- メール: support@in-dx.jp
- 屋号: 飲DX（代表: 柳下 征二郎）
- 関連サービス: [VOIXA](https://voixa.in-dx.jp)

## ⚖️ ライセンス

Private — 飲DX 所有

