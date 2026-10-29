#!/usr/bin/env python3
"""Calls the browser open-eyes Browser instead of Chromium in its UI text, in every language.

Usage: rename.py <chromium source tree>
"""
import os
import re
import sys
from pathlib import Path

NAME = "open-eyes Browser"
WORD = re.compile(r'(?<![\w./-])Chromium(?![\w-])(?! Authors| Web Store| OS\b|\.org| open source project|<ph name="END_LINK_CHROMIUM")')
MESSAGE = re.compile(r"<message\b.*?</message>", re.DOTALL)
TRANSLATION = re.compile(r'(<translation id=")(\d+)(">)(.*?)(</translation>)', re.DOTALL)
SKIP = {".pc", "out", "chromeos", "ash", "remoting", "testdata"}


def rename(text: str) -> str:
    return WORD.sub(NAME, text)


for before, after in [
    ("About Chromium", "About open-eyes Browser"),
    ("Chromium is up to date.", "open-eyes Browser is up to date."),
    ("Chromium's settings", "open-eyes Browser's settings"),
    ("Copyright The Chromium Authors", "Copyright The Chromium Authors"),
    ("the Chromium Web Store", "the Chromium Web Store"),
    ("Chromium OS", "Chromium OS"),
    ("https://www.chromium.org/Chromium", "https://www.chromium.org/Chromium"),
    ("chromium.org and Chromium.org", "chromium.org and Chromium.org"),
    ("ChromiumOS or Chromium-based", "ChromiumOS or Chromium-based"),
    ("Chromium is made possible by the Chromium open source project", "open-eyes Browser is made possible by the Chromium open source project"),
    ('the <ph name="BEGIN_LINK_CHROMIUM"/>Chromium<ph name="END_LINK_CHROMIUM"/> project', 'the <ph name="BEGIN_LINK_CHROMIUM"/>Chromium<ph name="END_LINK_CHROMIUM"/> project'),
]:
    assert rename(before) == after, f"{before!r} became {rename(before)!r}"


def walk(src: Path, suffixes: tuple[str, ...]):
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for name in files:
            if name.endswith(suffixes):
                yield Path(root, name)


class AllFalse(dict):
    """GRIT build variables: every one is defined and false, so any <if> can be read."""

    def __contains__(self, name):
        return True

    def __missing__(self, name):
        return False


def message_ids(grit, grd: Path) -> list[str]:
    """Translation ids of every message, in order. Ids hash the English text, so renaming changes them."""
    root = grit.grd_reader.Parse(str(grd), debug=False, defines=AllFalse(), target_platform="linux", skip_validation_checks=True)
    return [node.GetCliques()[0].GetId() for node in root.Preorder() if isinstance(node, grit.node.message.MessageNode)]


def main(src: Path) -> None:
    sys.path.insert(0, str(src / "tools" / "grit"))
    import grit.grd_reader
    import grit.node.message

    sources = list(walk(src, (".grd", ".grdp")))
    changed = {path for path in sources if WORD.search("".join(MESSAGE.findall(path.read_text(encoding="utf-8"))))}
    grds = [path for path in sources if path.suffix == ".grd" and (path in changed or "<part " in path.read_text(encoding="utf-8"))]
    before = {grd: message_ids(grit, grd) for grd in grds}

    for path in changed:
        text = path.read_text(encoding="utf-8")
        path.write_text(MESSAGE.sub(lambda m: rename(m.group(0)), text), encoding="utf-8")

    moved: dict[str, str] = {}
    for grd in grds:
        after = message_ids(grit, grd)
        assert len(after) == len(before[grd]), f"{grd}: renaming changed the number of messages"
        moved.update((old, new) for old, new in zip(before[grd], after) if old != new)

    translated = 0
    for xtb in walk(src, (".xtb",)):
        text = xtb.read_text(encoding="utf-8")

        def move(m: re.Match) -> str:
            if m.group(2) not in moved:
                return m.group(0)
            return m.group(1) + moved[m.group(2)] + m.group(3) + rename(m.group(4)) + m.group(5)

        renamed = TRANSLATION.sub(move, text)
        if renamed != text:
            xtb.write_text(renamed, encoding="utf-8")
            translated += 1

    print(f"renamed Chromium in {len(changed)} string files, {len(moved)} messages, {translated} translation files")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
