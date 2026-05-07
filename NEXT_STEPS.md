# Shifty: あなたが次にやるべきこと

私が手元で完了させた作業と、**あなた本人にしかできない作業**を整理しました。

---

## ✅ 私が完了したセットアップ（2026-05-07 時点）

| 項目 | 状態 | 備考 |
|---|---|---|
| Cloud Run 本番稼働 | ✅ | `https://shifty-1028920472559.asia-northeast1.run.app` |
| Firestore (multi-tenant ready) | ✅ | コレクション prefix 分離 |
| 全 URL 動作確認（15エンドポイント） | ✅ | 全 200 OK |
| API 認証ガード | ✅ | 認証必須エンドポイント全て 401 確認 |
| **Gmail SMTP（メール送受信）** | ✅ | 動作確認済 |
| **日次自動バックアップ** | ✅ | Cloud Scheduler `shifty-daily-snapshot` 毎日 03:00 JST |
| **git 初期化 + 初回コミット** | ✅ | 36ファイル / `.claude` `.env` `*.db` 等は除外済 |
| Sentry / Stripe / GA4 | 🟡 | コード実装済、env 設定で即有効化 |
| 営業資料 1 ページ（PDF印刷可） | ✅ | `/sales-pitch.html` ローカルで開いて印刷可 |
| Air シフト → Shifty 移行ツール | ✅ | `python tools/import_air_shift.py` |

---

## 🚧 あなた本人にしかできない作業

### 🔴 すぐに（今日中、合計 30 分）

#### 1. **管理者パスワードを変更** (5 分)
- `https://shifty-1028920472559.asia-northeast1.run.app/app` でログイン (`demo1234`)
- 設定タブ → 2. オーナーパスワード変更
- 強いパスワードに変更（推奨 16 字以上）

#### 2. **GitHub リポジトリ作成 + push** (10 分)
- https://github.com/new で **Private** 新規リポジトリ作成（例: `voixa/shifty`）
- ターミナルで:
```bash
cd /c/Users/seiji/shift-ai
git remote add origin git@github.com:<your-username>/shifty.git
git push -u origin main
```

#### 3. **GitHub Actions Secrets 登録** (10 分)
- repo Settings → Secrets and variables → Actions
- 以下 2 件を登録:
  - `GCP_WORKLOAD_IDENTITY_PROVIDER` (VOIXA で同じならそれ流用)
  - `GCP_SERVICE_ACCOUNT`
- 以降 `git push origin main` で自動デプロイ

#### 4. **Stripe アカウント作成（KYC は数日かかるので先に着手）** (15 分)
- https://signup.sendgrid.com/ ではなく **https://dashboard.stripe.com/register**
- 飲DX 情報入力
- 商品 3 つ作成: Starter (¥3,000), Standard (¥6,000), Pro (¥10,000) すべて 14 日トライアル付き
- API キー取得後、私に教えてもらえれば即接続します

---

### 🟡 今週末（合計 2 時間）

#### 5. **カスタムドメイン `shifty.in-dx.jp` 反映** (作業 15 分 + DNS 反映待ち〜24h)

> 💡 **私が試した結果**: ドメイン所有検証が必要でしたので、user 作業必須

ステップ:
1. https://search.google.com/search-console/welcome で `in-dx.jp` を所有確認
   - DNS レコード or HTML ファイル方式
   - VOIXA で既に検証済みなら `seijirooo.y@gmail.com` で再認証だけ
2. 所有確認完了後、ターミナルで:
```bash
cd /c/Users/seiji/shift-ai
gcloud beta run domain-mappings create \
  --service=shifty \
  --domain=shifty.in-dx.jp \
  --project=restaurant-call-ai \
  --region=asia-northeast1
```
3. 出力された CNAME を in-dx.jp の DNS（Google Workspace 管理コンソール）に追加
4. 反映後（〜24h）、env 更新:
```bash
gcloud run services update shifty \
  --project=restaurant-call-ai --region=asia-northeast1 \
  --update-env-vars="SITE_URL=https://shifty.in-dx.jp"
```

#### 6. **SNS アカウント開設** (60 分)
- X: `@shifty_indx` 等
- Note: `shifty-indx`
- プロフィール画像・カバー画像（`og.png` を流用可）
- 1 投稿目: `docs/marketing.md` の Post 1 をコピペ

#### 7. **VOIXA 顧客リスト整理 + 営業メール送信** (60 分)
- VOIXA Firestore の `stores` コレクションから連絡先を抽出
- スプレッドシート（店舗名・オーナー名・メール）作成
- `docs/marketing.md` の VOIXA 顧客向けメールテンプレで 5 件送信

---

### 🟢 来週以降

#### 8. **β顧客 1〜3 件獲得**
- 興味あり店舗には `/demo` URL 送る → Zoom デモ → 14 日無料トライアル
- 契約後は `bash setup_tenant.sh izakaya-en "いざかや 縁"` で独立 deployment

#### 9. **β顧客 30 分インタビュー**
- 何が便利か / 使いにくいか / 欲しい機能 / 価格感
- フィードバックを Round 14 のインプットに

---

## 🛠️ 私に追加で頼めること（いつでも）

- Stripe API キー設定 → 即実装
- カスタムドメイン反映後の env 更新
- β 顧客フィードバックを元に Round 14 改善
- 移行データ（Air シフトCSV等）の特殊フォーマット対応
- Note 記事の下書き（マーケティング文章）
- X 投稿バッチ作成
- 動画台本作成
- メール文面の調整
- 新機能の実装
- バグ対応

---

## 📊 全体ステータスダッシュボード

```
プロダクト本体          ████████████████ 100%
Cloud Run + Firestore   ████████████████ 100%
認証・セキュリティ      ████████████████ 100%
LP / 法的ページ         ████████████████ 100%
ヘルプセンター          ████████████████ 100%
監査可能 AI / テスト    ████████████████ 100%
モバイル UX             ████████████████ 100%
変更履歴 / オンボーディング ██████████████ 100%
日次自動バックアップ    ████████████████ 100%
Gmail SMTP メール       ████████████████ 100%
Stripe 決済             ████████░░░░░░░░  50% (コード済、KYC待ち)
カスタムドメイン        ████░░░░░░░░░░░░  25% (DNS設定待ち)
GitHub CI/CD            ████░░░░░░░░░░░░  25% (push待ち)
SNS / マーケ            ░░░░░░░░░░░░░░░░   0% (user作業)
β顧客獲得               ░░░░░░░░░░░░░░░░   0% (営業フェーズ)
```

**MVP 開発の純技術部分: 完了。あとは営業・運用フェーズ。**

---

## 🆘 困ったら

| 状況 | 対処 |
|---|---|
| Cloud Run のログ | `gcloud run services logs read shifty --project=restaurant-call-ai --region=asia-northeast1 --limit=50` |
| Scheduler ジョブ確認 | `gcloud scheduler jobs list --project=restaurant-call-ai --location=asia-northeast1` |
| Scheduler 手動実行 | `gcloud scheduler jobs run shifty-daily-snapshot --location=asia-northeast1` |
| データ復元 | `/app` ログイン → 設定タブ → スナップショット → 該当日 → 復元 |
| 自動テスト確認 | `https://shifty-...run.app/tests/algorithm.test.html` |
| アルゴリズム仕様 | `https://shifty-...run.app/docs/algorithm.md` |

---

最終更新: 2026-05-07
