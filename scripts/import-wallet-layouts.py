"""Compile the integrated APKs' XML widget trees into Electron DOM templates."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as XML

root = Path(__file__).resolve().parents[1]
base = root.parent.parent / "apks/base"
android = "{http://schemas.android.com/apk/res/android}"
layouts, words = {}, {}
for module in ("wallet", "NFTwallet"):
    for f in sorted((base / "integrated" / module / "src/main/res/layout").glob("*.xml")):
        def widget(node):
            attrs = {k[len(android):]: v for k, v in node.attrib.items() if k.startswith(android)}
            attrs.pop("tag", None)
            for value in attrs.values():
                if value.startswith("@string/"):
                    words[value[8:]] = {}
            return [node.tag.split(".")[-1], attrs, [widget(child) for child in node]]
        layouts[f.stem] = widget(XML.parse(f).getroot())
for code, folder in (("en","values"), ("ru","values-ru"), ("uk","values-uk"), ("zh","values-b+zh+Hans")):
    strings = XML.parse(base / "localization/src/main/res" / folder / "bear_strings.xml")
    for node in strings.getroot():
        key = node.get("name")
        if key.startswith(("l10n_sweep_", "l10n_wallet_", "l10n_nft_", "l10n_utxo_")):
            words.setdefault(key, {})
        if key in words:
            words[key][code] = "".join(node.itertext()).strip('"').replace("\\'", "'").replace('\\"', '"')
target = root / "renderer/apk-wallet-layouts.js"
target.write_text("// Generated from the original Android wallet layouts by scripts/import-wallet-layouts.py.\n" +
                  "const WALLET_LAYOUTS = " + json.dumps(layouts, ensure_ascii=False, separators=(",", ":")) +
                  ";\nconst WALLET_STRINGS = " + json.dumps(words, ensure_ascii=False, separators=(",", ":")) + ";\n")

