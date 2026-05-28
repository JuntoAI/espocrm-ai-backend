#!/usr/bin/env bash
#
# Deploy knowledge files to the production VM.
#
# Usage:
#   bash deploy-knowledge.sh
#
# This uploads the local knowledge/ directory to the VM at /opt/espocrm/knowledge/
# which is mounted into the ai-backend container at /data/knowledge/.
#
# The KnowledgeStore refreshes every 5 minutes, so changes take effect
# without restarting the container.
#

set -euo pipefail

PROJECT="juntoai-espocrm"
ZONE="us-central1-a"
VM="espocrm"
REMOTE_PATH="/opt/espocrm/knowledge"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_KNOWLEDGE="$SCRIPT_DIR/knowledge"

if [ ! -d "$LOCAL_KNOWLEDGE" ]; then
  echo "ERROR: knowledge/ directory not found at $LOCAL_KNOWLEDGE"
  exit 1
fi

echo "==> Creating remote directory structure..."
gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --quiet \
  --command="sudo mkdir -p $REMOTE_PATH/global $REMOTE_PATH/users && sudo chmod -R 777 $REMOTE_PATH"

echo "==> Uploading knowledge files..."
gcloud compute scp --recurse "$LOCAL_KNOWLEDGE/"* \
  "$VM:/tmp/knowledge-upload/" \
  --project="$PROJECT" --zone="$ZONE" --quiet

echo "==> Moving files into place..."
gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --quiet \
  --command="sudo cp -r /tmp/knowledge-upload/* $REMOTE_PATH/ && sudo chmod -R 755 $REMOTE_PATH && rm -rf /tmp/knowledge-upload"

echo ""
echo "✓ Knowledge files deployed to $REMOTE_PATH"
echo "  The AI backend will pick them up within 5 minutes (next refresh cycle)."
echo "  To force immediate reload, restart the container:"
echo "    gcloud compute ssh $VM --project=$PROJECT --zone=$ZONE --command='cd /opt/espocrm && sudo docker compose restart ai-backend'"
