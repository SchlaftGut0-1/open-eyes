# Contributing to open-eyes

Thanks for helping give agents eyes. Contributions of every size are welcome: bug
reports, docs, new commands, better snapshots.

## Development setup

You need Node.js 22+ and a Chromium-based browser.

```bash
git clone https://github.com/SchlaftGut0-1/open-eyes.git
cd open-eyes
npm install
npm run build
npm link            # optional: puts `open-eyes` on your PATH
```

On Node 23.6+ you can skip the build while iterating: `npm run dev -- snapshot`.

## Workflow

open-eyes uses [git flow](https://nvie.com/posts/a-successful-git-branching-model/):

| Branch | Purpose | Branches from | Merges into |
|---|---|---|---|
| `main` | Released versions only | | |
| `develop` | Integration of finished work (default branch) | `main` | `main`, via release |
| `feature/*` | One feature or fix | `develop` | `develop` (squash) |
| `release/x.y.z` | Prepare a release: version bump, final fixes | `develop` | `main` (merge commit) |
| `hotfix/x.y.z` | Urgent fix to a released version | `main` | `main` (merge commit) |

After a release or hotfix lands on `main`, `main` is merged back into `develop` and the
release is tagged `vX.Y.Z`.

Both `main` and `develop` are protected: changes land only through pull requests, with
CI on Node 22 and 24 and CodeQL passing. Pull requests into `main` must come from
`release/*` or `hotfix/*`; the `gitflow` check rejects anything else.

### Releasing (maintainers)

1. From `develop`, create `release/X.Y.Z`. Run `npm version X.Y.Z --no-git-tag-version`
   and move the `[Unreleased]` notes in `CHANGELOG.md` under a new `[X.Y.Z]` heading.
2. Open a pull request into `main` and merge it with a merge commit once checks pass.
3. Tag the merge on `main` and push the tag:
   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "open-eyes X.Y.Z" && git push origin vX.Y.Z
   ```
   The Release workflow checks the tag matches `package.json` and is on `main`, runs the
   tests, packs the package, signs its build provenance and publishes the GitHub release
   with the `CHANGELOG.md` notes.
4. Open a pull request from `main` into `develop` and merge it with a merge commit.

### Contributing a change

1. Fork the repo and create `feature/<short-name>` from `develop`.
2. Make your change. Keep the code in the style of the surrounding files.
3. Run `npm run typecheck` and `npm test`. The end-to-end tests start a headless
   Chromium on a random port with a throwaway profile; they never touch your browser.
   Add or update tests for what you changed, and try it against a real browser.
4. Open a pull request **into `develop`** describing what changed and how you tested it.

Feature pull requests are squash-merged, so the PR title becomes the commit message.
Please write it as a short imperative sentence ("Add iframe support to snapshot").

## Reporting bugs and ideas

Use the issue templates. For security problems, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part,
you agree to uphold it.
