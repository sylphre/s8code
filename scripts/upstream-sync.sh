#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2014-2026 Laurier Sylph.

# Scaffold to merge upstream (pingdotgg/t3code) into a throwaway branch.
# Conflicts are listed and left in place: nothing is resolved or pushed.

set -u

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo 'working tree is dirty; commit or stash first' >&2
  exit 1
fi

upstream="${1:-upstream}"
if ! git remote get-url "$upstream" >/dev/null 2>&1; then
  echo "no git remote named '$upstream'" >&2
  exit 1
fi

git fetch --tags "$upstream" || exit 1

# Latest stable tag on upstream, falling back to main when none exists.
tag=$(git ls-remote --tags --refs "$upstream" 'v*' | awk -F/ '{print $NF}' | grep -v '-' | sort -V | tail -n 1)
if [ -n "$tag" ]; then
  base="$tag"
else
  base="$upstream/main"
fi
echo "syncing against $base"

branch="sync/upstream-$(date +%Y%m%d)"
if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "branch $branch already exists; delete or rename it first" >&2
  exit 1
fi
git switch -c "$branch" || exit 1

if git merge --no-edit "$base"; then
  echo "merged $base into $branch"
  exit 0
fi

echo 'merge conflicts; resolve them by hand:' >&2
git diff --name-only --diff-filter=U >&2
exit 1
