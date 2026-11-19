#!/usr/bin/env python3
"""Print the horizontal edges down one column of a capture, in dp. Used to compare a preview shot with a
phone capture: edges.py <png> <x in dp> [px per dp = 2.625] [top offset in px = 0]"""
import sys
from PIL import Image
f, xdp = sys.argv[1], float(sys.argv[2]); k = float(sys.argv[3]) if len(sys.argv) > 3 else 2.625; top = int(sys.argv[4]) if len(sys.argv) > 4 else 0
im = Image.open(f).convert("RGB"); x = int(xdp * k); prev = None
for y in range(top, im.size[1]):
    c = im.getpixel((x, y))
    if prev and sum(abs(a - b) for a, b in zip(c, prev)) > 6: print("%7.1f  #%02X%02X%02X -> #%02X%02X%02X" % (((y - top) / k,) + prev + c))
    prev = c
