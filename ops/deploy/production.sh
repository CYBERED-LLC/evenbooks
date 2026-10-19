#!/usr/bin/env bash
# Deploys the checked-out commit to Railway production and, once it is live, moves the `prod` tag
# to it and pushes the tag (the public mirror publishes that tag, ops/public-mirror/README.md).
# Run by .gitea/workflows/deploy.yml on every push to main; also works by hand from a clean checkout.
#
# web goes first because its pre-deploy runs the migrations, and the worker must not run new code
# against the old schema. The worker is a cron service: its deploy is done once the build succeeds,
# and the next tick runs the new code. A failed deploy leaves the previous one running and the tag
# where it was.
#
# Required variables:
#   DEPLOY_PROJECT   Railway project id
# Optional variables:
#   RAILWAY_TOKEN    project token for the production environment (required when CI is set;
#                    otherwise the CLI uses the operator's login)
#   DEPLOY_TIMEOUT   seconds to wait for each service to go live (default: 1800)
set -euo pipefail

project=${DEPLOY_PROJECT:?DEPLOY_PROJECT must be the Railway project id}
timeout=${DEPLOY_TIMEOUT:-1800}
environment=production
health_url=https://evenbooks.org/api/health

log() { echo "$(date -u +%FT%TZ) $*"; }
fail() { log "FAILED: $*"; exit 1; }

cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# `railway up` uploads the working tree, so it must be exactly the commit that gets tagged.
[[ -z $(git status --porcelain) ]] || fail "the working tree has changes; deploy from a clean checkout"
# Without a token in CI the CLI would start an interactive login, or create a new project.
[[ -n ${RAILWAY_TOKEN:-} || -z ${CI:-} ]] || fail "RAILWAY_TOKEN is not set"
sha=$(git rev-parse HEAD)
subject=$(git log -1 --format=%s | cut -c1-80)
log "deploying $sha ($subject) to $environment"

railway_args=(-p "$project" -e "$environment")
deployments() { railway deployment list "${railway_args[@]}" -s "$1" --limit 20 --json; }

deploy() {
  local service=$1 message id="" status="" started
  # Fails here, before anything is uploaded, if the token cannot see the project or the service.
  deployments "$service" > /dev/null || fail "cannot list $service deployments in $environment"
  message="${sha:0:12} $subject [$(date -u +%s)-$$]"
  log "$service: uploading"
  railway up "${railway_args[@]}" -s "$service" -d -m "$message" || fail "$service: upload failed"

  started=$SECONDS
  while (( SECONDS - started < timeout )); do
    if [[ -z $id ]]; then
      id=$(deployments "$service" | jq -r --arg m "$message" 'first(.[] | select(.meta.cliMessage == $m) | .id) // empty')
      [[ -n $id ]] && log "$service: deployment $id"
    fi
    if [[ -n $id ]]; then
      status=$(deployments "$service" | jq -r --arg id "$id" '.[] | select(.id == $id) | .status')
      case $status in
        SUCCESS) log "$service: live after $(( SECONDS - started ))s"; return 0 ;;
        FAILED | CRASHED | REMOVED | SKIPPED)
          log "$service: deployment $id is $status; last log lines:"
          railway logs "${railway_args[@]}" -s "$service" --build --lines 60 "$id" || true
          railway logs "${railway_args[@]}" -s "$service" --deployment --lines 60 "$id" || true
          fail "$service: deployment $id is $status" ;;
      esac
    fi
    sleep 15
  done
  fail "$service: deployment ${id:-(not found)} still ${status:-pending} after ${timeout}s"
}

deploy web
deploy worker

log "checking $health_url"
curl -fsS --max-time 20 --retry 5 --retry-delay 10 --retry-all-errors "$health_url" | jq -e '.ok == true' > /dev/null ||
  fail "$health_url does not report ok"

previous=$(git ls-remote origin refs/tags/prod | cut -f1)
git tag -f prod "$sha" > /dev/null
git push -q -f origin refs/tags/prod
log "moved prod from ${previous:-(none)} to $sha"
