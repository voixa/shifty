#!/bin/bash
# ============================================================
# Shifty — GCP Cloud Run デプロイスクリプト（VOIXA と同パターン）
# 使い方: bash deploy.sh
# 前提: gcloud CLI 認証済み、VOIXA と同じプロジェクトでもOK
# ============================================================
set -e

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-northeast1}"
SERVICE_NAME="${SERVICE_NAME:-shifty}"

if [ -z "$PROJECT_ID" ]; then
  echo "❌ PROJECT_ID 未設定: gcloud config set project <PROJECT_ID> を実行してください"
  exit 1
fi

echo "================================================"
echo " Shifty Cloud Run Deploy"
echo " Project : $PROJECT_ID"
echo " Region  : $REGION"
echo " Service : $SERVICE_NAME"
echo "================================================"

# ----- 1. Secret Manager: SECRET_KEY を生成・登録 -----
echo ""
echo "▶ [1/3] Secret Manager セットアップ"

create_secret_if_not_exists() {
  local NAME=$1
  local VALUE=$2
  if gcloud secrets describe "$NAME" --project="$PROJECT_ID" &>/dev/null; then
    echo "  ✓ $NAME は既存（スキップ）"
  else
    echo "$VALUE" | gcloud secrets create "$NAME" \
      --project="$PROJECT_ID" \
      --replication-policy="automatic" \
      --data-file=-
    echo "  ✓ $NAME 作成完了"
  fi
}

FLASK_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || python -c "import secrets; print(secrets.token_hex(32))")
create_secret_if_not_exists "SHIFTY_SECRET_KEY" "$FLASK_KEY"

# ----- 2. Cloud Run デプロイ（Firestore 使用）-----
echo ""
echo "▶ [2/3] Cloud Run デプロイ"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=2 \
  --set-env-vars="STORAGE_BACKEND=firestore,FLASK_ENV=production" \
  --set-secrets="SECRET_KEY=SHIFTY_SECRET_KEY:latest" \
  --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format="value(status.url)")

echo "  ✓ デプロイ完了: $SERVICE_URL"

# ----- 3. Firestore のサービスアカウント権限確認 -----
echo ""
echo "▶ [3/3] Firestore 権限確認"

# Cloud Run の default compute service account に Firestore アクセス権限付与
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role="roles/datastore.user" \
  --quiet 2>/dev/null || echo "  ✓ 権限は既に付与済"

echo "  ✓ Firestore 権限OK"

echo ""
echo "================================================"
echo " ✅ デプロイ完了"
echo "================================================"
echo ""
echo "  サービスURL: $SERVICE_URL"
echo ""
echo "  初回アクセス: $SERVICE_URL"
echo "  → 「初回セットアップ」画面でオーナーパスワードを設定"
echo ""
echo "  スタッフポータル: $SERVICE_URL/staff?t={token}"
echo "  → 管理画面の「🔗 リンク」ボタンで生成"
echo ""
echo "  ⚠️ Firestore Native モードが有効か確認:"
echo "     https://console.cloud.google.com/firestore?project=$PROJECT_ID"
echo "     未有効ならコンソールで「Native mode」を選択して有効化"
echo "================================================"
