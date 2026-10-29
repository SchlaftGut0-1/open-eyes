# open-eyes Browser on Chromium

open-eyes Browser built on Chromium: our own patches on top of
[ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium), which
strips Google's services and keys out of Chromium. See #177.

- `ungoogled-chromium/`: a submodule, pinned to the release that matches the Chromium
  version we build (156.0.8078.73).
- `patches/series`: the patches applied after ungoogled-chromium's own, in order.
  `patches/ungoogled-chromium/portablelinux/` comes from
  [ungoogled-chromium-portablelinux](https://github.com/ungoogled-software/ungoogled-chromium-portablelinux)
  and lets Chromium build outside Google's environment. Our own patches go in
  `patches/open-eyes/`: `branding.patch` names the browser open-eyes Browser, shows the eye in
  its pages' menus, and keeps it apart from Chromium: its profile lives in
  `~/.config/open-eyes-browser`, and it reads policies and native messaging hosts from
  `/etc/open-eyes-browser`, not from `/etc/chromium`. `use-typescript-7.patch`
  builds DevTools with TypeScript 7.0.2, which the build installs in its own folder:
  TypeScript 6, the version Arch ships, rejects some of DevTools' declarations.
  `purple-by-default.patch` makes open-eyes purple (`#7c5cff`), in Chromium's vibrant
  variant, the browser's color on a new profile, in light and dark; the user can still pick
  another in Customize. `hide-profile-button.patch` shows the profile button only in
  incognito and guest windows, through ungoogled-chromium's `--show-avatar-button` switch.
- `resources/icon.svg`: the eye logo. The build turns it into every product icon Chromium
  needs (PNG and XPM, at each size), since patches cannot carry images.
- `scripts/rename.py`: replaces "Chromium" with "open-eyes Browser" in the UI text, in
  every language. A message's translations are found by an id that hashes its English
  text, so the script computes each renamed message's new id with Chromium's own GRIT and
  moves its translations to it. Credits ("The Chromium Authors"), the Chromium Web Store,
  Chromium OS and URLs stay as they are.
- `flags.gn`: the GN build flags for Linux, added to ungoogled-chromium's.
- `scripts/build.sh`: downloads the Chromium source, applies everything and builds.

## Building on Linux (x64)

Needs about 100 GB of free disk and 16 GB of RAM. On Arch:

```bash
sudo pacman -S --needed ninja gperf esbuild nodejs npm go clang python librsvg imagemagick
git submodule update --init packages/browser/ungoogled-chromium
packages/browser/scripts/build.sh
```

The source and the build go to `~/.cache/open-eyes-browser` (set
`OPEN_EYES_CHROMIUM_BUILD` to use another folder). Each step leaves a stamp there, so a
stopped build picks up where it left off. The browser ends up in
`out/Default/chrome`.

## Moving to a new Chromium release

1. Move the submodule to the ungoogled-chromium tag for that release.
2. Take the matching `patches/ungoogled-chromium/portablelinux/` from
   ungoogled-chromium-portablelinux.
3. Refresh our patches until `scripts/build.sh` applies them all cleanly.

Our patches and scripts are MIT, like the rest of open-eyes. The parts taken from
ungoogled-chromium (the build steps and the portable patches) are BSD-3-Clause; see
`LICENSE.ungoogled-chromium`.
