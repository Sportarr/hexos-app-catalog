#!/usr/bin/env bash
# Opens or refreshes the pull request for one app's image update in a plan from
# `bun _lib/image_watch.ts check --out <plan>`. Run from the repo root by the image-watch workflow,
# once per app, so one app's failure leaves the others' pull requests to open.
#
# The pull request lives on image-watch/<app>, rebuilt from the base branch each run, so a newer tag
# replaces the one it carried. A pull request closed without merging declines its tag: the same
# title is never opened again, and the next newer tag opens a new one.
#
# Usage: _lib/image_watch_pr.sh <plan.json> <app>   (BASE: the branch to target, staging by default)
set -euo pipefail

plan="$1"
app="$2"
base="${BASE:-staging}"
branch="image-watch/$app"

title=$(jq -r --arg app "$app" '.updates[] | select(.app == $app) | .title' "$plan")
file=$(jq -r --arg app "$app" '.updates[] | select(.app == $app) | .file' "$plan")
body=$(mktemp)
jq -r --arg app "$app" '.updates[] | select(.app == $app) | .body' "$plan" > "$body"

declined=$(gh pr list --head "$branch" --state closed --json title,mergedAt \
  | jq --arg title "$title" '[.[] | select(.mergedAt == null and .title == $title)] | length')
if [ "$declined" != "0" ]; then
  echo "$title was declined; waiting for a newer tag"
  exit 0
fi

git checkout --quiet -B "$branch" "origin/$base"
bun _lib/image_watch.ts apply "$plan" "$app"
bun _lib/validate.ts > /dev/null
bun _lib/script_bumps.ts "origin/$base" > /dev/null
# The script alone: nothing else the run touched rides along
git add -- "$file"
git commit --quiet -m "$title" -- "$file"

if git rev-parse --verify --quiet "origin/$branch" > /dev/null && git diff --quiet "origin/$branch" HEAD; then
  echo "$branch already carries $title"
else
  git push --quiet --force origin "$branch"
fi

number=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')
if [ -n "$number" ]; then
  gh pr edit "$number" --title "$title" --body-file "$body" > /dev/null
  echo "Refreshed #$number: $title"
else
  gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body"
fi
