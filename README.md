# Shifty — AI シフト自動作成 SaaS

飲食店向け、AI 自動最適化のシフト管理ツール。**飲DX** の第二弾プロダクト（VOIXA に続く）。

🌐 **公開URL**: https://shifty.in-dx.jp（DNS反映待ち）/ https://shifty-1028920472559.asia-northeast1.run.app

## 🎯 サービス概要

- **ターゲット**: 飲食店オーナー（スタッフ 5〜30 名規模）
- **コア価値**: シフト作成 4 時間 → 5 分（自動化）
- **料金**: ¥3,000 / ¥6,000 / ¥10,000（月額・3 プラン）
- **トライアル**: 14 日間無料・クレカ不要

## 🧱 機能一覧

| 機能 | 説明 |
|---|---|
| 🤖 AI シフト自動生成 | 2段階制約充足アルゴリズム + スコア説明付き |
| 📱 モバイル希望収集 | スタッフはトークンURLでスマホから1タップ入力 |
| 📅 複数週管理 | 前週・次週・任意週ジャンプ、テンプレート保存 |
| ✅ 確定→通知 | 確定ボタンで LINE 通知文を自動生成 |
| ⚙️ 詳細設定 | ポジション・営業セッション・必要人数マトリクス・労務ルール |
| 🆘 代打推薦 | 欠勤時にAIが最適候補をスコア順表示 |
| 📈 過去週分析 | 人件費・カバー率・希望充足率の週次推移 |
| 📊 月間ランキング | スタッフ別月間労働時間・給与の可視化 |
| 🔐 認証 | bcrypt + セッションクッキー、ログイン試行制限 |
| ☁️ クラウド永続化 | Firestore（本番）/ SQLite（ローカル） |
| 📥 バックアップ | JSON エクスポート / インポート |
| 📲 PWA | Add to Home Screen 対応 |

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

## 📊 ロードマップ

- [x] Round 1-7: コア機能実装（AI生成、複数週、認証、PWA等）
- [x] Round 8: Cloud Run + Firestore デプロイ
- [x] Round 9: LP + 法的ページ + 問合せ受付（**現在地**）
- [ ] Round 10: Stripe 決済導入
- [ ] Round 11: マルチテナント対応
- [ ] Round 12: 弥生・freee 連携
- [ ] Round 13: 欠勤・実績記録
- [ ] Round 14: LINE Messaging API 自動配信

## 📞 お問い合わせ

- メール: support@in-dx.jp
- 屋号: 飲DX（代表: 柳下 征二郎）
- 関連サービス: [VOIXA](https://voixa.in-dx.jp)

## ⚖️ ライセンス

Private — 飲DX 所有

