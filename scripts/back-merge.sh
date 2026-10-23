#!/usr/bin/env bash
# Git flow back-merge after a release: merges main into develop with a merge commit.
#
# develop only accepts squash merges, and a ruleset bypass cannot change the merge method,
# so this turns the "Squash features into develop" ruleset off for the merge and always
# turns it back on afterwards. CI and CodeQL stay required throughout. Needs admin rights.
#
# Usage: scripts/back-merge.sh <pr-number>
set -euo pipefail
repo=SchlaftGut0-1/open-eyes
pr=${1:?usage: scripts/back-merge.sh <pr-number>}

# Some setups (like mise shims) print extra lines on stdout; keep only the last one.
last() { tail -n 1; }

branches=$(gh pr view "$pr" -R "$repo" --json headRefName,baseRefName --jq '"\(.headRefName)->\(.baseRefName)"' | last)
if [ "$branches" != "main->develop" ]; then
  echo "PR #$pr is $branches, not main->develop; refusing to merge it with a merge commit." >&2
  exit 1
fi
ruleset=$(gh api "repos/$repo/rulesets" --jq '.[] | select(.name == "Squash features into develop") | .id' | last)

reenable() { gh api -X PUT "repos/$repo/rulesets/$ruleset" -f enforcement=active >/dev/null && echo "squash-only rule turned back on"; }
trap reenable EXIT
gh api -X PUT "repos/$repo/rulesets/$ruleset" -f enforcement=disabled >/dev/null
echo "squash-only rule turned off for the back-merge"
gh pr merge "$pr" -R "$repo" --merge
