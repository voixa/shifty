#!/bin/bash
# ============================================================
# Shifty — カスタムドメイン (shifty.in-dx.jp) セットアップ
# 使い方: bash setup_domain.sh
# 前提: gcloud 認証済み、in-dx.jp の DNS 管理権限
# ============================================================
set -e

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-restaurant-call-ai}"
REGION="asia-northeast1"
SERVICE_NAME="shifty"
DOMAIN="${DOMAIN:-shifty.in-dx.jp}"

echo "================================================"
echo " Shifty Custom Domain Setup"
echo " Domain  : $DOMAIN"
echo " Service : $SERVICE_NAME"
echo "================================================"

# ----- 1. Domain Mapping を作成 -----
echo ""
echo "▶ [1/2] Cloud Run Domain Mapping を作成"

# 既存マッピング確認
EXISTING=$(gcloud beta run domain-mappings list \
  --project="$PROJECT_ID" --region="$REGION" \
  --format="value(metadata.name)" 2>/dev/null | grep -E "^${DOMAIN}$" || echo "")

if [ -n "$EXISTING" ]; then
  echo "  ✓ ドメインマッピングは既存（スキップ）"
else
  gcloud beta run domain-mappings create \
    --service="$SERVICE_NAME" \
    --domain="$DOMAIN" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --quiet
  echo "  ✓ マッピング作成完了"
fi

# ----- 2. DNS レコード情報を表示 -----
echo ""
echo "▶ [2/2] DNS レコード情報"

gcloud beta run domain-mappings describe \
  --domain="$DOMAIN" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format="yaml(status.resourceRecords)"

echo ""
echo "================================================"
echo " 📝 次のステップ（手動）"
echo "================================================"
echo ""
echo " 1. 上記の DNS レコード（CNAME or A レコード）を"
echo "    in-dx.jp の DNS 管理画面に登録してください。"
echo ""
echo "    例（一般的に出力されるパターン）:"
echo "    レコードタイプ : CNAME"
echo "    名前(ホスト)   : shifty"
echo "    値(ターゲット) : ghs.googlehosted.com."
echo "    TTL            : 3600"
echo ""
echo " 2. DNS 反映まで 5〜30 分待つ（最大 24 時間）"
echo ""
echo " 3. SSL 証明書は Google が自動発行・管理します"
echo "    （DNS 認証完了後 15〜60 分で HTTPS 利用可能）"
echo ""
echo " 4. 完了後アクセス:"
echo "    https://$DOMAIN/"
echo ""
echo "================================================"
