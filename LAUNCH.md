# Shifty ローンチガイド

## 🚦 現在のステータス

✅ **デプロイ済み** : `https://shifty-1028920472559.asia-northeast1.run.app`
🟡 **カスタムドメイン待ち** : `https://shifty.in-dx.jp`（DNS設定必要）
🟡 **マーケティング未着手** : X / Note / 営業

---

## 🚀 ローンチまでの残タスク

### 1. カスタムドメイン設定（手動 + DNS反映待ち）

```bash
cd C:\Users\seiji\shift-ai
bash setup_domain.sh
```

このスクリプトが出力する DNS レコードを **in-dx.jp の DNS 管理画面に登録**：

```
タイプ : CNAME
名前   : shifty
値     : ghs.googlehosted.com.
TTL    : 3600
```

DNS 反映 5〜30 分 + SSL 自動発行 15〜60 分後に `https://shifty.in-dx.jp/` でアクセス可能。

### 2. GitHub リポジトリ作成 + プッシュ

```bash
cd C:\Users\seiji\shift-ai
git init
git add .
git commit -m "Initial commit: Shifty MVP v1.0"
git branch -M main

# GitHub で空のリポジトリを作成（例: voixa/shifty-backend）してから:
git remote add origin git@github.com:voixa/shifty-backend.git
git push -u origin main
```

### 3. GitHub Actions CI/CD 有効化

リポジトリの Settings > Secrets and variables > Actions で以下を登録：

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

> 💡 **簡易版（推奨しないが手早い）**: Workload Identity の代わりに JSON 鍵を使う場合は `GCP_SA_KEY` を登録し、deploy.yml を JSON 鍵認証に書き換え。

設定後、`main` ブランチへの push で自動デプロイ。

### 4. メール通知の有効化（Gmail App Password）

問合せが届いた時に `support@in-dx.jp` への通知 + 応募者への自動返信メールを送るために、Gmail の App Password を設定します。

**手順**:
1. Google アカウント (admin@in-dx.jp) で 2 段階認証を有効化
   - https://myaccount.google.com/security
2. App Passwords ページへ
   - https://myaccount.google.com/apppasswords
3. 「Shifty SMTP」等の名前で生成 → 16 文字のパスワードをコピー
4. Cloud Run の env / Secret Manager に登録：

```bash
# 推奨: Secret Manager 経由
echo "xxxxxxxxxxxxxxxx" | gcloud secrets create GMAIL_APP_PASSWORD \
  --project=restaurant-call-ai --replication-policy=automatic --data-file=-

gcloud run services update shifty \
  --project=restaurant-call-ai --region=asia-northeast1 \
  --set-secrets="GMAIL_APP_PASSWORD=GMAIL_APP_PASSWORD:latest" \
  --update-env-vars="GMAIL_USER=support@in-dx.jp,NOTIFY_TO=support@in-dx.jp"
```

設定後、問合せフォームから送信すると：
- support@in-dx.jp に「【Shifty】お問合せ: 店舗名 / 名前」というメール
- 応募者に「お問合せありがとうございます」自動返信

### 5. Stripe 設定（決済を有効化する場合）

現状はお問合せベース。Stripe を入れる場合：

1. Stripe アカウント作成（既存があればスキップ）
2. ダッシュボードで「商品」を 3 つ作成（Starter / Standard / Pro）
3. Webhook エンドポイントを `https://shifty.in-dx.jp/api/stripe/webhook` に設定
4. Cloud Run の env に追加：
   - `STRIPE_SECRET_KEY=sk_live_...`
   - `STRIPE_WEBHOOK_SECRET=whsec_...`
5. server.py に Stripe ハンドラ追加（次フェーズ実装）

### 6. SNS アカウント開設

- [ ] X (Twitter): `@shifty_inDX` または `@flintdx_shifty`
- [ ] Note: shifty-indx 等
- [ ] 既存 VOIXA アカウントからクロスポスト

### 7. 新規顧客向けデプロイ（マルチテナント）

各顧客向けに完全分離した Cloud Run service を 1 コマンドで作成できます。
Firestore コレクション prefix で完全分離されるため、誤って他店データが見えるリスクはゼロ。

```bash
bash setup_tenant.sh <slug> "<表示名>"

# 例
bash setup_tenant.sh izakaya-en   "いざかや 縁"
bash setup_tenant.sh cafe-musashi "カフェ 武蔵"
```

これで以下が自動セットアップされます:
- Cloud Run service: `shifty-{slug}` （独立 URL）
- Firestore collection: `shifty_{slug}` プレフィックスで分離
- 各テナントは独立した認証・state・スタッフ・トークンを持つ
- 既存のメインサービス (`shifty`) は default tenant として継続稼働

**カスタムドメインを各テナントに割り当て**:
```bash
gcloud beta run domain-mappings create \
  --service=shifty-izakaya-en \
  --domain=izakaya-en.shifty.in-dx.jp \
  --region=asia-northeast1
```

スケール上限: Cloud Run のサービス数上限（プロジェクト当たり 1000）= 顧客 1000 店舗まで対応可能。

### 8. ローンチ告知

`docs/marketing.md` のテンプレを参照：
- X 連投 (Post 1〜5)
- Note 記事 1 本目（開発ストーリー）
- VOIXA 既存顧客にメール

---

## 📊 公開済みファイル

| パス | 役割 |
|---|---|
| `/` | ランディングページ |
| `/app` | 管理画面（オーナー用） |
| `/staff?t={token}` | スタッフポータル |
| `/tos` | 利用規約 |
| `/privacy` | プライバシーポリシー |
| `/tokushoho` | 特定商取引法に基づく表記 |
| `/api/inquiry` | 問い合わせ受付（POST） |

---

## 🔐 認証情報（メモ）

- **管理者パスワード**: 初期 `demo1234` （**本番デプロイ後は必ず変更**してください）
- **Cloud Run プロジェクト**: restaurant-call-ai
- **Firestore コレクション**:
  - `shifty/state` (state JSON)
  - `shifty/config` (admin_pass_hash)
  - `shifty_tokens/{staffId}` (tokens)
  - `shifty_inquiries` (LP からの問合せ)

---

## 📈 ローンチ後にすべきこと

### Day 1
- [ ] LP 動作確認（Chrome / Safari / モバイル）
- [ ] お問合せフォーム動作確認（自分でテスト送信）
- [ ] 管理画面 `/app` 動作確認
- [ ] スタッフポータル動作確認

### Week 1
- [ ] X 連投（5 本）
- [ ] Note 記事 1 本
- [ ] VOIXA 既存 5 顧客にメール
- [ ] 反応モニタリング

### Month 1
- [ ] 申込者 5 件と 30 分インタビュー
- [ ] フィードバック反映で LP 改修
- [ ] 機能優先度の再評価
- [ ] 次の TOP3 改善実装

---

## 🆘 トラブルシューティング

**LP が表示されない**
→ `gcloud run services describe shifty --region=asia-northeast1 --format="value(status.url)"` でURL確認

**お問合せが届かない**
→ Firestore コンソールで `shifty_inquiries` コレクション確認
→ または `/api/admin/inquiries` (要ログイン) で一覧取得

**カスタムドメインが繋がらない**
→ DNS 反映待ち（最大 24 時間）
→ `dig shifty.in-dx.jp CNAME` で正しい CNAME になっているか確認

**Cloud Run のコールドスタート遅い**
→ `min-instances=1` に変更（少額課金発生）
