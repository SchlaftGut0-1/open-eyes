#!/usr/bin/env python3
"""Writes Lucide icons into a Chromium tree as .icon files.

usage: icons.py <chromium-src> [<.icon path> ...]
       icons.py --test

Each ICONS entry maps a .icon path to Lucide names, drawn in order, or to
literal .icon command lines. The file keeps its license header and its first
CANVAS_DIMENSIONS, and the 24-unit Lucide grid is scaled to that canvas.
"""

import math
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

LUCIDE = "0.460.0"
CACHE = Path.home() / ".cache" / "open-eyes-browser" / f"lucide-{LUCIDE}"

ICONS = {
    "chrome/app/vector_icons/new_tab_refresh_old.icon": ["square-plus"],
    "chrome/app/vector_icons/new_window_old.icon": ["app-window"],
    "chrome/app/vector_icons/incognito_refresh_menu_old.icon": ["venetian-mask"],
    "chrome/app/vector_icons/account_circle_chrome_refresh_old.icon": ["circle-user-round"],
    "components/vector_icons/password_manager_old.icon": ["key-round"],
    "chrome/app/vector_icons/history_old.icon": ["history"],
    "chrome/app/vector_icons/download_menu_old.icon": ["download"],
    "chrome/app/vector_icons/bookmarks_lists_menu_old.icon": ["star"],
    "chrome/app/vector_icons/trash_can_refresh_old.icon": ["trash-2"],
    "chrome/app/vector_icons/zoom_in_old.icon": ["zoom-in"],
    "chrome/app/vector_icons/zoom_minus_menu_refresh_old.icon": ["minus"],
    "chrome/app/vector_icons/zoom_plus_menu_refresh_old.icon": ["plus"],
    "chrome/app/vector_icons/fullscreen_refresh_old.icon": ["maximize"],
    "chrome/app/vector_icons/print_menu_old.icon": ["printer"],
    "components/vector_icons/g_translate.icon": ["languages"],
    "chrome/app/vector_icons/search_menu_old.icon": ["text-search"],
    "chrome/app/vector_icons/file_save_chrome_refresh_old.icon": ["file-down"],
    "chrome/app/vector_icons/more_tools_menu_old.icon": ["wrench"],
    "components/vector_icons/info_refresh_old.icon": ["info"],
    "chrome/app/vector_icons/exit_menu_old.icon": ["log-out"],
    "chrome/app/vector_icons/account_add_chrome_refresh_old.icon": ["user-round-plus"],
    "chrome/app/vector_icons/account_manage_chrome_refresh_old.icon": ["user-round-cog"],
    "chrome/app/vector_icons/account_box_old.icon": ["square-user-round"],
    "components/vector_icons/edit_chrome_refresh_old.icon": ["pencil"],
    "components/vector_icons/close_chrome_refresh_old.icon": ["x"],
    "chrome/app/vector_icons/credit_card_chrome_refresh_old.icon": ["credit-card"],
    "components/vector_icons/location_on_chrome_refresh_old.icon": ["map-pin"],
    "components/vector_icons/id_card_old.icon": ["id-card"],
    "components/vector_icons/trip_old.icon": ["luggage"],
    "components/vector_icons/history_chrome_refresh_old.icon": ["history"],
    "chrome/app/vector_icons/bookmark_all_tabs_chrome_refresh_old.icon": ["folder-plus"],
    "chrome/app/vector_icons/toolbar_chrome_refresh_old.icon": ["panel-top"],
    "chrome/app/vector_icons/bookmarks_manager_old.icon": ["book-marked"],
    "chrome/app/vector_icons/bookmarks_side_panel_refresh_old.icon": ["panel-right"],
    "chrome/app/vector_icons/menu_book_chrome_refresh_old.icon": ["book-open"],
    "chrome/app/vector_icons/reading_list_old.icon": ["glasses"],
    "chrome/app/vector_icons/create_new_tab_group_old.icon": ["copy-plus"],
    "chrome/app/vector_icons/cut_menu_old.icon": ["scissors"],
    "chrome/app/vector_icons/copy_menu_old.icon": ["copy"],
    "chrome/app/vector_icons/paste_menu_old.icon": ["clipboard-paste"],
    "chrome/app/vector_icons/cast_chrome_refresh_old.icon": ["cast"],
    "chrome/app/vector_icons/install_desktop_chrome_refresh_old.icon": ["monitor-down"],
    "chrome/app/vector_icons/drive_shortcut_chrome_refresh_old.icon": ["square-arrow-out-up-right"],
    "chrome/app/vector_icons/link_chrome_refresh_old.icon": ["link"],
    "chrome/app/vector_icons/devices_chrome_refresh_old.icon": ["monitor-smartphone"],
    "chrome/app/vector_icons/qr_code_chrome_refresh_old.icon": ["qr-code"],
    "chrome/app/vector_icons/settings_menu_old.icon": ["settings"],
    "chrome/app/vector_icons/help_menu_old.icon": ["circle-help"],
    "chrome/app/vector_icons/developer_tools_old.icon": ["code-xml"],
    "chrome/app/vector_icons/performance_old.icon": ["gauge"],
    "chrome/app/vector_icons/name_window_old.icon": ["text-cursor-input"],
    "chrome/app/vector_icons/report_old.icon": ["flag"],
    "chrome/app/vector_icons/security_old.icon": ["shield"],
    "chrome/app/vector_icons/dock_to_left_old.icon": ["panel-left"],
    "chrome/app/vector_icons/dock_to_right_old.icon": ["panel-right"],
    "chrome/app/vector_icons/desktop_windows_chrome_refresh_old.icon": ["monitor"],
    "chrome/app/vector_icons/sharing_hub_screenshot_old.icon": ["scan"],
    "components/vector_icons/warning_old.icon": ["triangle-alert"],
    "components/vector_icons/science_old.icon": ["flask-conical"],
    "components/vector_icons/mic_chrome_refresh_old.icon": ["mic"],
    "components/vector_icons/search_chrome_refresh_old.icon": ["search"],
    "components/vector_icons/business_chrome_refresh_old.icon": ["building-2"],
    "components/omnibox/browser/vector_icons/product_old.icon": ["eye"],
    "components/omnibox/browser/vector_icons/product_chrome_refresh_old.icon": ["eye"],
    "components/vector_icons/chromium/product.icon": ["eye"],
    "components/vector_icons/chromium/product_refresh.icon": ["eye"],
}


def num(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def cmd(name, *args):
    return ", ".join([name, *map(num, args)])


def tokens(d):
    return re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?", d)


def path_commands(d, s):
    """Converts SVG path data to absolute .icon commands, one subpath per segment,
    so the round caps also round every join."""
    toks = tokens(d)
    out = []
    i = 0
    op = None
    x = y = sx = sy = 0.0
    ctrl = None

    def take(n):
        nonlocal i
        if op in "Aa":
            vals = []
            while len(vals) < n:
                t = toks[i]
                if len(vals) in (3, 4) and len(t) > 1 and t[0] in "01" and "." not in t:
                    toks[i] = t[1:]
                    vals.append(float(t[0]))
                    continue
                vals.append(float(t))
                i += 1
            return vals
        vals = [float(t) for t in toks[i:i + n]]
        i += n
        return vals

    def seg(name, *pts):
        out.append(cmd("MOVE_TO", x * s, y * s))
        out.append(cmd(name, *pts))

    while i < len(toks):
        if re.fullmatch(r"[A-Za-z]", toks[i]):
            op = toks[i]
            i += 1
            if op in "Zz":
                if (x, y) != (sx, sy):
                    seg("LINE_TO", sx * s, sy * s)
                x, y, ctrl = sx, sy, None
                continue
        rel = op.islower()
        ox, oy = (x, y) if rel else (0.0, 0.0)
        o = op.upper()
        if o == "M":
            px, py = take(2)
            x, y = sx, sy = ox + px, oy + py
            op = "l" if rel else "L"
            ctrl = None
        elif o in "LHV":
            if o == "L":
                px, py = take(2)
                nx, ny = ox + px, oy + py
            elif o == "H":
                nx, ny = ox + take(1)[0], y
            else:
                nx, ny = x, oy + take(1)[0]
            seg("LINE_TO", nx * s, ny * s)
            x, y, ctrl = nx, ny, None
        elif o in "CS":
            if o == "C":
                x1, y1, x2, y2, px, py = take(6)
                x1, y1 = ox + x1, oy + y1
            else:
                x2, y2, px, py = take(4)
                x1, y1 = (2 * x - ctrl[0], 2 * y - ctrl[1]) if ctrl and ctrl[2] == "C" else (x, y)
            x2, y2, nx, ny = ox + x2, oy + y2, ox + px, oy + py
            seg("CUBIC_TO", x1 * s, y1 * s, x2 * s, y2 * s, nx * s, ny * s)
            x, y, ctrl = nx, ny, (x2, y2, "C")
        elif o in "QT":
            if o == "Q":
                x1, y1, px, py = take(4)
                x1, y1 = ox + x1, oy + y1
            else:
                px, py = take(2)
                x1, y1 = (2 * x - ctrl[0], 2 * y - ctrl[1]) if ctrl and ctrl[2] == "Q" else (x, y)
            nx, ny = ox + px, oy + py
            seg("QUADRATIC_TO", x1 * s, y1 * s, nx * s, ny * s)
            x, y, ctrl = nx, ny, (x1, y1, "Q")
        elif o == "A":
            rx, ry, rot, large, sweep, px, py = take(7)
            nx, ny = ox + px, oy + py
            seg("ARC_TO", rx * s, ry * s, rot, large, sweep, nx * s, ny * s)
            x, y, ctrl = nx, ny, None
        else:
            raise ValueError(f"unsupported path command {op}")
    return out


def points_path(points, close):
    pts = points.replace(",", " ").split()
    d = "M" + " ".join(pts[:2]) + " L" + " ".join(pts[2:])
    return d + (" Z" if close else "")


def svg_commands(svg, s):
    out = []
    for el in ET.fromstring(svg):
        tag = el.tag.split("}")[-1]
        a = {k: float(v) for k, v in el.attrib.items()
             if re.fullmatch(r"-?[\d.]+", v)}
        if tag == "path":
            out += path_commands(el.attrib["d"], s)
        elif tag == "circle":
            out.append(cmd("CIRCLE", a["cx"] * s, a["cy"] * s, a["r"] * s))
        elif tag == "ellipse":
            out.append(cmd("OVAL", a["cx"] * s, a["cy"] * s, a["rx"] * s, a["ry"] * s))
        elif tag == "line":
            out += path_commands(f"M{a['x1']} {a['y1']} L{a['x2']} {a['y2']}", s)
        elif tag in ("polyline", "polygon"):
            out += path_commands(points_path(el.attrib["points"], tag == "polygon"), s)
        elif tag == "rect":
            x, y, w, h = a.get("x", 0), a.get("y", 0), a["width"], a["height"]
            r = a.get("rx", a.get("ry", 0))
            if r:
                out.append(cmd("ROUND_RECT", x * s, y * s, w * s, h * s, r * s))
            else:
                out += path_commands(f"M{x} {y}h{w}v{h}h{-w}Z", s)
        else:
            raise ValueError(f"unsupported SVG element {tag}")
    return out


def lucide(name):
    path = CACHE / f"{name}.svg"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        url = f"https://cdn.jsdelivr.net/npm/lucide-static@{LUCIDE}/icons/{name}.svg"
        with urllib.request.urlopen(url) as r:
            path.write_bytes(r.read())
    return path.read_text()


def render(original, entries):
    lines = original.splitlines()
    canvas_at = next(i for i, l in enumerate(lines) if l.startswith("CANVAS_DIMENSIONS"))
    canvas = float(lines[canvas_at].split(",")[1])
    s = canvas / 24
    head = lines[:canvas_at + 1]
    if "FLIPS_IN_RTL," in lines:
        head.append("FLIPS_IN_RTL,")
    body = [cmd("STROKE", 2 * s)]
    for e in entries:
        body += svg_commands(lucide(e), s) if re.fullmatch(r"[a-z0-9-]+", e) else [e.rstrip(",")]
    return "\n".join(head + [l + "," for l in body[:-1]] + body[-1:]) + "\n"


def test():
    got = path_commands("M3 12a9 9 0 1 0 9-9h2v1zM6 11c1.5 0 3 .5 3 2s1 1 2 0", 16 / 24)
    assert got[:2] == ["MOVE_TO, 2, 8", "ARC_TO, 6, 6, 0, 1, 0, 8, 2"], got
    assert got[2:4] == ["MOVE_TO, 8, 2", "LINE_TO, 9.33, 2"], got
    assert got[6:8] == ["MOVE_TO, 9.33, 2.67", "LINE_TO, 2, 8"], "Z closes back to the subpath start"
    assert got[-1] == "CUBIC_TO, 6, 9.67, 6.67, 9.33, 7.33, 8.67", "S reflects the previous control point"
    assert path_commands("M0 0a1 1 0 011 1", 1)[1] == "ARC_TO, 1, 1, 0, 0, 1, 1, 1", "packed arc flags"
    icon = render("// header\n\nCANVAS_DIMENSIONS, 20,\nFLIPS_IN_RTL,\nCLOSE\n\nCANVAS_DIMENSIONS, 16,\n",
                  ["CIRCLE, 10, 10, 2"])
    assert icon == "// header\n\nCANVAS_DIMENSIONS, 20,\nFLIPS_IN_RTL,\nSTROKE, 1.67,\nCIRCLE, 10, 10, 2\n", icon
    print("ok")


def main(argv):
    if argv == ["--test"]:
        return test()
    src, picks = Path(argv[0]), argv[1:] or list(ICONS)
    for rel in picks:
        f = src / rel
        f.write_text(render(f.read_text(), ICONS[rel]))
        print(rel)


if __name__ == "__main__":
    main(sys.argv[1:])
