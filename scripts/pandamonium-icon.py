#!/usr/bin/env python3
"""
pandamonium-icon.py — Pandamonium Desktop's app icon, drawn from the Pandamonium APK's own launcher vectors.

  python3 scripts/pandamonium-icon.py [path to apks/base]      (default: ../../apks/base from this repo)

Reads, and only reads, the APK's adaptive icon (apks/base/app/src/main/res/drawable/ic_launcher_{background,foreground}.xml)
and the Pandamonium flavour's pupil colour (app/src/pandamonium/res/values/colors.xml launcher_pupil), and writes
build-pandamonium/icon.icns (macOS, 16-1024 with @2x), icon.ico (Windows, 16-256) and icon.png (Linux, 1024).

Rendered as Android shows it: the background layer full-bleed, the foreground over it, and only the launcher's visible
72 dp of the 108 dp canvas (18..90 dp). On the Mac that 72 dp square fills the standard icon body: an 824 px rounded
square, corner 22.5 %, centred in the 1024 canvas with the 100 px margin, the same shape and margin as build/icon.icns.
Everything is drawn once at 4096 px from the vector geometry and reduced (Lanczos) to every size: no bitmap is upscaled.
Needs Pillow and macOS iconutil.
"""
import os, re, sys, shutil, subprocess, tempfile
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APK = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "..", "..", "apks", "base"))
RES = os.path.join(APK, "app", "src")
OUT = os.path.join(ROOT, "build-pandamonium")
K = 4                                   # supersampling of the 1024 canvas
BODY0, BODY = 100, 824                  # macOS icon grid: margin and body side, in 1024 px
VIS0, VIS = 18.0, 72.0                  # Android adaptive icon: the visible window of the 108 dp canvas

def read(p): return open(os.path.join(RES, p), encoding="utf-8").read()

pupil = re.search(r'name="launcher_pupil">(#[0-9A-Fa-f]{6})<', read("pandamonium/res/values/colors.xml")).group(1)
colour = lambda c: pupil if c == "@color/launcher_pupil" else c

def shapes(xml):
    """(fill, kind, data) in drawing order. Circles are the APK's 'M x,y a r,r 0 1,0 2r,0 ...' paths; the M is a polygon in a group."""
    out, tx, ty, s = [], 0.0, 0.0, 1.0
    for m in re.finditer(r'<group([^>]*)>|</group>|<path[^>]*fillColor="([^"]+)"[^>]*pathData="([^"]+)"', xml):
        if m.group(0).startswith("<group"):
            g = dict(re.findall(r'android:(\w+)="([^"]+)"', m.group(1)))
            tx, ty, s = float(g.get("translateX", 0)), float(g.get("translateY", 0)), float(g.get("scaleX", 1))
        elif m.group(0) == "</group>": tx, ty, s = 0.0, 0.0, 1.0
        else:
            fill, d = colour(m.group(2)), m.group(3)
            c = re.match(r'M([\d.]+),([\d.]+) a([\d.]+),', d)
            if c:
                x, y, r = map(float, c.groups()); out.append((fill, "circle", (x + r, y, r)))
                continue
            pts, x, y = [], 0.0, 0.0
            for cmd, args in re.findall(r'([MLHVhvzZ])([^MLHVhvzZ]*)', d):
                n = [float(v) for v in re.findall(r'-?[\d.]+', args)]
                if cmd in "ML": x, y = n[0], n[1]
                elif cmd == "H": x = n[0]
                elif cmd == "V": y = n[0]
                elif cmd == "h": x += n[0]
                elif cmd == "v": y += n[0]
                else: continue
                pts.append((tx + x * s, ty + y * s))
            out.append((fill, "poly", pts))
    return out

def master():
    """The 1024 icon at K x: the APK's layers in the macOS body, transparent outside it."""
    N, scale = 1024 * K, BODY * K / VIS
    px = lambda v: (BODY0 * K) + (v - VIS0) * scale
    art = Image.new("RGBA", (N, N), (0, 0, 0, 0)); d = ImageDraw.Draw(art)
    for fill, kind, data in shapes(read("main/res/drawable/ic_launcher_background.xml")) + shapes(read("main/res/drawable/ic_launcher_foreground.xml")):
        if kind == "circle":
            x, y, r = data; d.ellipse([px(x - r), px(y - r), px(x + r), px(y + r)], fill=fill)
        else: d.polygon([(px(x), px(y)) for x, y in data], fill=fill)
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([BODY0 * K, BODY0 * K, (BODY0 + BODY) * K - 1, (BODY0 + BODY) * K - 1], radius=round(BODY * K * 0.225), fill=255)
    out = Image.new("RGBA", (N, N), (0, 0, 0, 0)); out.paste(art, (0, 0), mask)
    return out

def main():
    big = master(); at = lambda n: big.resize((n, n), Image.Resampling.LANCZOS)
    os.makedirs(OUT, exist_ok=True)
    at(1024).save(os.path.join(OUT, "icon.png"), optimize=True)
    at(256).save(os.path.join(OUT, "icon.ico"), sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    tmp = tempfile.mkdtemp(); iconset = os.path.join(tmp, "icon.iconset"); os.makedirs(iconset)
    try:
        for n in (16, 32, 128, 256, 512):
            at(n).save(os.path.join(iconset, "icon_%dx%d.png" % (n, n)))
            at(n * 2).save(os.path.join(iconset, "icon_%dx%d@2x.png" % (n, n)))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(OUT, "icon.icns")], check=True)
    finally: shutil.rmtree(tmp)
    print("source : " + APK + "  (pupil " + pupil + ")\nwritten: " + OUT + "/icon.icns, icon.ico, icon.png")

if __name__ == "__main__": main()
