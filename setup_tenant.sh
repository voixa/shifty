#!/bin/bash
# 新規テナント (顧客) 用 Cloud Run サービスのデプロイ
# 使い方: bash setup_tenant.sh <tenant-slug> <表示名>
# 例:    bash setup_tenant.sh izakaya-en 'いざかや 縁'
#
# 仕組み:
#   - Cloud Run service: shifty-{slug}
#   - Firestore collection prefix: shifty_{slug}
#   - 各 service は完全に独立した Firestore コレクションを持つ
#   - URL: https://shifty-{slug}-<hash>.a.run.app/
set -e

TENANT_SLUG="$1"
TENANT_NAME="${2:-$TENANT_SLUG}"

if [ -z "$TENANT_SLUG" ]; then
  echo "使い方: bash setup_tenant.sh <slug> <表示名>"
  echo "例:    bash setup_tenant.sh izakaya-en 'いざかや 縁'"
  exit 1
fi

# Validation: slug は半角英数とハイフンのみ
if ! [[ "$TENANT_SLUG" =~ ^[a-z0-9-]+$ ]]; then
  echo "❌ slug は半角英小文字・数字・ハイフンのみ使用可"
  exit 1
fi

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-restaurant-call-ai}"
REGION="${REGION:-asia-northeast1}"
SERVICE_NAME="shifty-${TENANT_SLUG}"
COLL_PREFIX="shifty_${TENANT_SLUG//-/_}"  # ハイフンをアンダースコアに（Firestore推奨）

echo "================================================"
echo " Shifty 新規テナントデプロイ"
echo " Tenant   : $TENANT_NAME ($TENANT_SLUG)"
echo " Service  : $SERVICE_NAME"
echo " Prefix   : $COLL_PREFIX"
echo " Project  : $PROJECT_ID"
echo "================================================"

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
  --set-env-vars="STORAGE_BACKEND=firestore,FLASK_ENV=production,STORAGE_COLLECTION_PREFIX=${COLL_PREFIX},TENANT_NAME=${TENANT_NAME}" \
  --set-secrets="SECRET_KEY=SHIFTY_SECRET_KEY:latest" \
  --quiet

URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format="value(status.url)")

echo ""
echo "================================================"
echo "✅ テナント '$TENANT_NAME' デプロイ完了"
echo "================================================"
echo ""
echo "  URL: $URL"
echo ""
echo "  Firestore コレクション:"
echo "    - $COLL_PREFIX/state"
echo "    - $COLL_PREFIX/config"
echo "    - ${COLL_PREFIX}_tokens/*"
echo "    - ${COLL_PREFIX}_snapshots/*"
echo "    - ${COLL_PREFIX}_inquiries/*"
echo "    - ${COLL_PREFIX}_staff_messages/*"
echo ""
echo "  既存テナント (default) とは完全分離されています。"
echo ""
echo "  次のステップ:"
echo "    1. URL にアクセスして初回セットアップ（パスワード設定）"
echo "    2. 設定タブで店舗名・予算・スタッフを設定"
echo "    3. オプション: カスタムドメイン (\${TENANT_SLUG}.shifty.in-dx.jp)"
echo "       gcloud beta run domain-mappings create --service=$SERVICE_NAME \\"
echo "         --domain=\${TENANT_SLUG}.shifty.in-dx.jp --region=$REGION"
echo "================================================"
