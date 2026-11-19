/* zip.js — a minimal, dependency-free ZIP writer, so the trade export leaves as ONE archive.
 *
 * WHY THIS EXISTS. Native hands you a single `pandadex-trades-<date>.zip` containing four files
 * (TradeExportWriter.zip, java.util.zip). The MiniDapp fired four separate browser downloads
 * instead — four "keep/discard" prompts, four files loose in Downloads, and an export whose parts
 * can be separated from each other. The reconciliation CSV only means anything alongside the
 * summary that states the window and balances it reconciles against, so splitting them is not a
 * cosmetic difference.
 *
 * There is no ZIP library in the page and no CDN to pull one from (the MiniDapp is served from the
 * node and must be self-contained), so the format is written directly. That is far less alarming
 * than it sounds for this job:
 *
 *   - Entries are STORED (method 0), not deflated. The whole compression half of the format is
 *     therefore not implemented at all. An export is a few KB of CSV; the only thing compression
 *     would buy is the very complexity that would make this worth avoiding.
 *   - No ZIP64. Guarded, not assumed: build() refuses over 4GB rather than emitting an archive
 *     with silently truncated offsets. An export of every trade you will ever make is nowhere near.
 *
 * PURE: no DOM, no clock of its own — the timestamp is passed in, so the same rows and the same
 * export time always produce byte-identical output, and the tests can unzip the result with the
 * system `unzip` to prove the archive is real rather than merely plausible.
 */
var PandaZip = PandaZip || {};
(function (Z) {

  Z.MAX_BYTES = 4294967295;   /* ZIP64 begins here; we refuse rather than overflow the offsets */

  var TABLE = null;

  function crcTable() {
    var c, n, k, t;
    if (TABLE) return TABLE;
    t = [];
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    TABLE = t;
    return t;
  }

  Z.crc32 = function (bytes) {
    var t = crcTable(), c = 0xFFFFFFFF, i;
    for (i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  /* Hand-rolled rather than TextEncoder: this file has to be provably the same in the page and in
     `node test.js`, and a lone surrogate must produce U+FFFD rather than a malformed byte that
     makes the whole archive unreadable. */
  Z.utf8 = function (str) {
    var out = [], i, c, lo;
    str = String(str === undefined || str === null ? "" : str);
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); continue; }
      if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); continue; }
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        lo = str.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
          i++;
          out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
          continue;
        }
      }
      if (c >= 0xD800 && c <= 0xDFFF) { out.push(0xEF, 0xBF, 0xBD); continue; }
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  };

  function u16(out, v) { out.push(v & 0xFF, (v >>> 8) & 0xFF); }
  function u32(out, v) { out.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
  function bytes(out, arr) { var i; for (i = 0; i < arr.length; i++) out.push(arr[i]); }

  /* MS-DOS packed date/time, in UTC. Pre-1980 cannot be represented and clamps to 1980-01-01 —
     a clockless device must not emit a date field that unzip rejects. */
  Z.dosTime = function (d) {
    return ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) & 0xFFFF;
  };
  Z.dosDate = function (d) {
    var y = d.getUTCFullYear();
    if (y < 1980) return (1 << 5) | 1;
    return ((((y - 1980) & 0x7F) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xFFFF;
  };

  /* files: [{name, text}] — returns the archive bytes. */
  Z.build = function (files, atMs) {
    var out = [], central = [], when = new Date(Number(atMs) || 0),
        time = Z.dosTime(when), date = Z.dosDate(when),
        i, f, name, data, crc, offset, total, cdOffset, cdSize;

    files = files || [];
    for (i = 0; i < files.length; i++) {
      f = files[i] || {};
      name = Z.utf8(f.name);
      data = Z.utf8(f.text);
      crc = Z.crc32(data);
      offset = out.length;
      if (offset + data.length + name.length + 30 > Z.MAX_BYTES)
        throw new Error("Export is too large for a plain ZIP (over 4GB)");

      u32(out, 0x04034B50);      /* local file header */
      u16(out, 20);              /* version needed: 2.0, the floor for a stored entry */
      u16(out, 0x0800);          /* bit 11: names are UTF-8 */
      u16(out, 0);               /* method 0 = stored */
      u16(out, time); u16(out, date);
      u32(out, crc);
      u32(out, data.length);     /* compressed size == uncompressed size when stored */
      u32(out, data.length);
      u16(out, name.length);
      u16(out, 0);               /* no extra field */
      bytes(out, name);
      bytes(out, data);

      u32(central, 0x02014B50);  /* central directory record */
      u16(central, 20);          /* version made by */
      u16(central, 20);
      u16(central, 0x0800);
      u16(central, 0);
      u16(central, time); u16(central, date);
      u32(central, crc);
      u32(central, data.length);
      u32(central, data.length);
      u16(central, name.length);
      u16(central, 0);           /* extra */
      u16(central, 0);           /* comment */
      u16(central, 0);           /* disk number */
      u16(central, 0);           /* internal attrs */
      u32(central, 0);           /* external attrs */
      u32(central, offset);
      bytes(central, name);
    }

    cdOffset = out.length;
    cdSize = central.length;
    bytes(out, central);

    u32(out, 0x06054B50);        /* end of central directory */
    u16(out, 0); u16(out, 0);    /* single-disk archive */
    u16(out, files.length);
    u16(out, files.length);
    u32(out, cdSize);
    u32(out, cdOffset);
    u16(out, 0);                 /* no archive comment */

    total = out.length;
    if (total > Z.MAX_BYTES) throw new Error("Export is too large for a plain ZIP (over 4GB)");
    return typeof Uint8Array === "function" ? new Uint8Array(out) : out;
  };

})(PandaZip);
