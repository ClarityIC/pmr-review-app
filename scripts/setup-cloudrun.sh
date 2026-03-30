#!/usr/bin/env bash
# =============================================================================
# setup-cloudrun.sh
# One-time setup: Artifact Registry, Secret Manager, Cloud Run, Cloud Build
# Run from pmr-review-app/ directory after: gcloud auth login travis@clarityic.com
# =============================================================================
set -euo pipefail

PROJECT=cic-prior-records-review
REGION=us-central1
SERVICE=pmr-review-app
REPO=pmr-images
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}"

echo "==> Setting project..."
gcloud config set project "${PROJECT}"

# Get project number (Cloud Build SA uses number, not ID)
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format="value(projectNumber)")
CLOUD_BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
echo "    Project number: ${PROJECT_NUMBER}"
echo "    Cloud Build SA: ${CLOUD_BUILD_SA}"

# ---------------------------------------------------------------------------
# 1. Enable required APIs
# ---------------------------------------------------------------------------
echo "==> Enabling APIs (this may take a minute)..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project="${PROJECT}"

# Wait for the Cloud Build SA to be provisioned (created automatically after API enable)
echo "==> Waiting for Cloud Build service account to be provisioned..."
for i in $(seq 1 12); do
  if gcloud iam service-accounts describe "${CLOUD_BUILD_SA}" --project="${PROJECT}" &>/dev/null; then
    echo "    Cloud Build SA is ready."
    break
  fi
  echo "    Not ready yet, waiting 10 seconds... (attempt ${i}/12)"
  sleep 10
done

# ---------------------------------------------------------------------------
# 2. Create Artifact Registry repository
# ---------------------------------------------------------------------------
echo "==> Creating Artifact Registry repository..."
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="PMR Review App Docker images" \
  --project="${PROJECT}" 2>/dev/null || echo "    (already exists, skipping)"

# ---------------------------------------------------------------------------
# 3. Grant Cloud Build SA permissions
# ---------------------------------------------------------------------------
echo "==> Granting Cloud Build SA permissions..."
# Cloud Build needs to push to Artifact Registry
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/artifactregistry.writer" --quiet

# Cloud Build needs to deploy to Cloud Run
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/run.admin" --quiet

# Cloud Build needs to act as the app's service account
gcloud iam service-accounts add-iam-policy-binding \
  "service-account@${PROJECT}.iam.gserviceaccount.com" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/iam.serviceAccountUser" --quiet

# Cloud Build needs to access Secret Manager
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/secretmanager.secretAccessor" --quiet

# ---------------------------------------------------------------------------
# 4. Grant app SA permission to access its own secrets
# ---------------------------------------------------------------------------
APP_SA="service-account@${PROJECT}.iam.gserviceaccount.com"
echo "==> Granting app SA Secret Manager access..."
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${APP_SA}" \
  --role="roles/secretmanager.secretAccessor" --quiet

# ---------------------------------------------------------------------------
# 5. Store secrets in Secret Manager
# ---------------------------------------------------------------------------
echo "==> Storing secrets in Secret Manager..."

# Load from .env file — must be run from pmr-review-app/
if [[ ! -f ".env" ]]; then
  echo "ERROR: .env file not found. Run this script from pmr-review-app/ directory."
  exit 1
fi

store_secret() {
  local name="$1"
  local value="$2"
  if gcloud secrets describe "${name}" --project="${PROJECT}" &>/dev/null; then
    echo "    Updating ${name}..."
    printf '%s' "${value}" | gcloud secrets versions add "${name}" --data-file=- --project="${PROJECT}"
  else
    echo "    Creating ${name}..."
    printf '%s' "${value}" | gcloud secrets create "${name}" --data-file=- --project="${PROJECT}" --replication-policy=automatic
  fi
}

# Parse .env and store each var (skip comments, blank lines, NODE_ENV, PORT)
# Use grep+sed to correctly handle values that contain '=' (e.g. GCP_SA_KEY JSON)
while IFS= read -r line; do
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  [[ -z "${key}" ]] && continue
  [[ "${key}" == "NODE_ENV" ]] && continue
  [[ "${key}" == "PORT" ]] && continue
  store_secret "pmr-${key}" "${value}"
done < .env

# ---------------------------------------------------------------------------
# 6. Build initial Docker image (first deploy)
# ---------------------------------------------------------------------------
echo "==> Building initial Docker image with Cloud Build..."
gcloud builds submit . \
  --tag="${IMAGE}:latest" \
  --project="${PROJECT}"

# ---------------------------------------------------------------------------
# 7. Deploy Cloud Run service
# ---------------------------------------------------------------------------
echo "==> Deploying Cloud Run service..."

gcloud run deploy "${SERVICE}" \
  --image="${IMAGE}:latest" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="${APP_SA}" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=2Gi \
  --cpu=2 \
  --timeout=900 \
  --port=3000 \
  --set-env-vars="\
NODE_ENV=production,\
GOOGLE_CLIENT_ID=643927424109-fapdkevkh88tobt5mti3cpbie212riva.apps.googleusercontent.com,\
GCP_PROJECT_ID=cic-prior-records-review,\
GCP_LOCATION=us,\
GCS_AUTHORITATIVE_BUCKET=cic-authoritative-case-files,\
GCS_STAGING_INPUT_BUCKET=cic-docai-staging-inputs,\
GCS_STAGING_OUTPUT_BUCKET=cic-docai-staging-outputs,\
BQ_DATASET=prr_data,\
BQ_TABLE0=documents,\
DOCAI_OCR_PROCESSOR_ID=26597dd107cedd1e,\
DOCAI_LAYOUT_PROCESSOR_ID=9eede265724988da,\
GEMINI_MODEL=gemini-3.1-pro-preview,\
VERTEX_LOCATION=us-central1" \
  --set-secrets="\
GCP_SA_KEY=pmr-GCP_SA_KEY:latest,\
COOKIE_SECRET=pmr-SESSION_SECRET:latest" \
  --project="${PROJECT}" \
  --quiet

# ---------------------------------------------------------------------------
# 8. Print the service URL
# ---------------------------------------------------------------------------
SERVICE_URL=$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT}" \
  --format="value(status.url)")

echo ""
echo "============================================================"
echo " Cloud Run service deployed!"
echo " URL: ${SERVICE_URL}"
echo "============================================================"
echo ""
echo "NEXT STEPS:"
echo "1. Set up Cloud Build GitHub trigger in the Console:"
echo "   https://console.cloud.google.com/cloud-build/triggers?project=${PROJECT}"
echo "   → Connect repository → ClarityIC/pmr-review-app"
echo "   → Trigger on: Push to main branch"
echo "   → Build config: cloudbuild.yaml"
echo ""
echo "2. Add this redirect URI to your OAuth 2.0 client:"
echo "   ${SERVICE_URL}/api/auth/google-redirect"
echo "   Also add: https://pmr.clarityic.com/api/auth/google-redirect"
echo "   Go to: https://console.cloud.google.com/apis/credentials?project=${PROJECT}"
echo ""
echo "3. Point Cloudflare DNS:"
echo "   CNAME pmr.clarityic.com → ${SERVICE_URL#https://}"
echo "   (strip https:// prefix for the CNAME target)"
echo ""
echo "4. Update GOOGLE_CLIENT_ID in index.html if Vite did not bake it in."
