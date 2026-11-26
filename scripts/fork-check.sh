#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2014-2026 Laurier Sylph.

# Fork hygiene check: fails on leftover telemetry send paths or the upstream npm
# scope. desktopTelemetryFd is a local-only IPC channel kept on purpose and is
# never a violation here.

set -u

cd "$(dirname "$0")/.."

status=0

# Entries allowed to mention the words: paletteSearch uses "posthog" as a search
# fixture, the graphql schemas and the privacy policy describe other parties'
# use of PostHog, not ours.
allow_re='^(packages/shared/src/paletteSearch\.test\.ts|apps/server/schema/expo\.graphql|packages/issue-tracker-linear/schema/linear\.graphql|apps/marketing/src/pages/privacy-policy\.astro):'

if hits=$(grep -rniE 'posthog|ingest\.t3\.codes|T3CODE_TELEMETRY' apps packages \
    --exclude-dir=node_modules 2>/dev/null | grep -Ev "$allow_re"); then
  printf 'telemetry send patterns still present:\n%s\n' "$hits"
  status=1
fi

if [ -d apps/server/src/telemetry ]; then
  echo 'apps/server/src/telemetry/ still exists'
  status=1
fi

if [ -f packages/shared/src/telemetryId.ts ]; then
  echo 'packages/shared/src/telemetryId.ts still exists'
  status=1
fi

if hits=$(grep -rn '@t3tools/' apps packages scripts \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' \
    --exclude-dir=node_modules 2>/dev/null); then
  printf 'upstream npm scope still present:\n%s\n' "$hits"
  status=1
fi

# The scope may not survive in any manifest either (name, deps, workspaces).
while IFS= read -r manifest; do
  if grep -qn '@t3tools' "$manifest"; then
    grep -Hn '@t3tools' "$manifest"
    status=1
  fi
done < <(find . -name package.json -not -path '*/node_modules/*')

# The desktop updater stays (see the 2026-11-26 decision): the update feed comes
# from the app-update.yml baked in at build time, so a stray upstream repo id in
# the feed or the builder config would auto-update S8 Code into official T3 Code.
# Desktop test fixtures mimic upstream feeds and pages, which is not a violation,
# and the github.repository guards in .github/workflows are legitimate.
desktop_pingdot_allow_re='^(apps/desktop/src/snapShot/DesktopSnapShot\.test\.ts|apps/desktop/src/snapShot/snapShot\.test\.ts|apps/desktop/src/updates/DesktopUpdates\.test\.ts|apps/desktop/src/updates/releaseNotes\.test\.ts|apps/desktop/src/updates/githubUpdateFeed\.test\.ts):'
if hits=$(grep -rni 'pingdotgg' apps/desktop --exclude-dir=node_modules 2>/dev/null | grep -Ev "$desktop_pingdot_allow_re"); then
  printf 'upstream repo id left in the desktop app:\n%s\n' "$hits"
  status=1
fi

while IFS= read -r feed; do
  if grep -qin 'pingdotgg' "$feed"; then
    grep -Hin 'pingdotgg' "$feed"
    status=1
  fi
done < <(find . \( -name 'app-update.yml' -o -name 'app-update.yaml' \) -not -path '*/node_modules/*')

while IFS= read -r builder_config; do
  if grep -qi 'pingdotgg' "$builder_config" ; then
    grep -Hin 'pingdotgg' "$builder_config"
    status=1
  fi
done < <(find . -regextype posix-extended -type f -regex '.*/electron-builder\.(yml|yaml|json|json5|js|cjs|ts)' -not -path '*/node_modules/*')

# Author metadata like the podspec `hello@t3tools.com` contact lines is allowed.

if [ "$status" -eq 0 ]; then
  echo 'fork-check: ok'
fi
exit "$status"
