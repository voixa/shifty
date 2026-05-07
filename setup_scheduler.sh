#!/bin/bash
# Shifty 自動バックアップ用 Cloud Scheduler セットアップ
# 毎日 03:00 JST に /internal/snapshot を呼び出して Firestore に状態を保存
set -e

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-restaurant-call-ai}"
REGION="${REGION:-asia-northeast1}"
SERVICE_NAME="shifty"
JOB_NAME="shifty-daily-snapshot"
SCHEDULER_SA="voixa-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"  # VOIXA と同じ SA を流用

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format="value(status.url)")

echo "Setting up Cloud Scheduler job '$JOB_NAME' for $SERVICE_URL"

# サービスアカウントが存在することを確認
if ! gcloud iam service-accounts describe "$SCHEDULER_SA" --project="$PROJECT_ID" &>/dev/null; then
  echo "  ⚠️  $SCHEDULER_SA がありません。VOIXA setup_gcp.sh を先に実行してください。"
  exit 1
fi

# Cloud Run 呼び出し権限付与
gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker" --quiet 2>/dev/null || true

# 既存ジョブ確認
if gcloud scheduler jobs describe "$JOB_NAME" \
  --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  CMD="update"
else
  CMD="create"
fi

gcloud scheduler jobs $CMD http "$JOB_NAME" \
  --location="$REGION" --project="$PROJECT_ID" \
  --schedule="0 3 * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="${SERVICE_URL}/internal/snapshot" \
  --http-method=POST \
  --oidc-service-account-email="$SCHEDULER_SA" \
  --oidc-token-audience="$SERVICE_URL" \
  --quiet

echo "✅ '$JOB_NAME' を設定完了。毎日 03:00 JST に自動スナップショット取得します。"
echo ""
echo "テスト実行:"
echo "  gcloud scheduler jobs run $JOB_NAME --location=$REGION --project=$PROJECT_ID"
