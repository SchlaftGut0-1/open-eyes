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

`main` is protected: every change lands through a pull request with passing CI.

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep the code in the style of the surrounding files.
3. Run `npm run typecheck` and try your change against a real browser.
4. Open a pull request describing what changed and how you tested it.

Pull requests are squash-merged, so the PR title becomes the commit message. Please
write it as a short imperative sentence ("Add iframe support to snapshot").

## Reporting bugs and ideas

Use the issue templates. For security problems, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part,
you agree to uphold it.
