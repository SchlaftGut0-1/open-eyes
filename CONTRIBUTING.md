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

## How work is tracked

Every change starts as an issue, so plans and progress are visible to everyone.

- **Issues** describe one piece of work with its acceptance criteria. Use the templates.
- **Labels** say what kind of work it is (`bug`, `enhancement`, `security`, `ci`,
  `documentation`, ...) and which part of the code it touches (`area: snapshot`,
  `area: actions`, `area: overlay`, `area: browser`, `area: policy`,
  `area: distribution`).
- **Milestones** are releases (`v0.4.0`, `v0.5.0`, `v1.0.0`). An issue in a milestone is
  planned for that version; an issue without one is in the backlog.
- **The project board** ([open-eyes roadmap](https://github.com/users/SchlaftGut0-1/projects/2))
  shows every issue's status: Backlog → Todo → In progress → In review → Done, with its
  priority and size.

To work on an issue: comment on it (or assign yourself), branch as
`feature/<issue-number>-<short-name>` (for example `feature/17-scroll`), and open a pull
request into `develop` that starts with `Closes #<issue-number>`. Merging it closes the
issue and moves it to Done.

## Workflow

open-eyes uses [git flow](https://nvie.com/posts/a-successful-git-branching-model/):

| Branch | Purpose | Branches from | Merges into |
|---|---|---|---|
| `main` | Released versions only | | |
| `develop` | Integration of finished work (default branch) | `main` | `main`, via release |
| `feature/*` | One feature or fix | `develop` | `develop` (squash, enforced) |
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
4. Open a pull request from `main` into `develop` and merge it with a merge commit, not a
   squash: a squashed back-merge makes every later release conflict on `package.json`
   and the changelog. `develop` only accepts squash merges, so a maintainer does this
   one merge by hand.

### Contributing a change

1. Pick or open an issue. Fork the repo and create `feature/<issue>-<short-name>` from
   `develop`.
2. Make your change. Keep the code in the style of the surrounding files.
3. Run `npm run typecheck` and `npm test`. The end-to-end tests start a headless
   Chromium on a random port with a throwaway profile; they never touch your browser.
   Add or update tests for what you changed, and try it against a real browser.
4. Open a pull request **into `develop`** that starts with `Closes #<issue>`, describing
   what changed and how you tested it.

Feature pull requests are squash-merged, so the PR title becomes the commit message.
Please write it as a short imperative sentence ("Add iframe support to snapshot").

## Reporting bugs and ideas

Use the issue templates. For security problems, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part,
you agree to uphold it.
