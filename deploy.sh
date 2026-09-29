#!/usr/bin/env bash
# HandNote — Cloudflare Workers 배포
# 사용법:
#   export CLOUDFLARE_API_TOKEN="..."   # Workers Scripts:Edit 권한
#   export CLOUDFLARE_ACCOUNT_ID="..."
#   ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN 이 없습니다. 대화형 로그인으로 진행합니다 (npx wrangler login)."
  npx wrangler login
fi
echo "== 배포 전 검증 (dry-run) =="
npx wrangler deploy --dry-run --outdir=.wrangler/dry
echo "== 실제 배포 =="
npx wrangler deploy
echo
echo "완료. 다음 단계:"
echo "  1) https://<worker>.<subdomain>.workers.dev 접속 확인"
echo "  2) Cloudflare Zero Trust > Access > Applications 에서 이 호스트 이름을 Self-hosted 응용 프로그램으로 등록"
