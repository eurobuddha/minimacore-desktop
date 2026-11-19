/*
 * dexicon-room.js — serves the Dexicon page to its hidden frame as dxroom://exchange/… (from DexiconPro's
 * main/rooms.js). A separate origin from the app's file:// pages, and the frame is sandboxed (opaque origin), so the
 * page cannot reach window.mcd: it has only the postMessage bridge of renderer/dexicon/mds.js.
 *
 * Served: renderer/dexicon/ (the page: verbatim from mds/dexicon, pinned by scripts/dexicon-page.manifest.json, plus
 * this app's mds.js) and the engine files the page loads from main/dexicon/{lib,resting,crypto,vendor}/ (verbatim,
 * pinned by scripts/dexicon-parity.manifest.json). Nothing else. doors/ and lib/door.js are in neither place, so the
 * page's AtomiX doors cannot load. The frame has NO network of its own (connect-src 'none'): relay traffic goes
 * through the bridge, where main/dexicon.js allows the engine's current relays only.
 */
const fs = require("fs");
const path = require("path");

const PAGE_DIR = path.join(__dirname, "..", "renderer", "dexicon");
const ENGINE_DIR = path.join(__dirname, "dexicon");
const ENGINE_FILE = /^(lib|resting|crypto|vendor)\/[A-Za-z0-9_.-]+\.js$/;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ttf": "font/ttf" };
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";   // 'unsafe-inline': the page's own onclick attributes

/** The file a dxroom:// URL names, or null. Plain relative paths only; the page's folder first, then the engine's. */
function roomFile(host, pathname) {
  if (host !== "exchange") return null;
  let rel; try { rel = decodeURIComponent(String(pathname)).replace(/^\/+/, ""); } catch (e) { return null; }
  if (!/^[A-Za-z0-9_./-]+$/.test(rel) || rel.split("/").some(p => p === "" || p === "." || p === "..") || !TYPES[path.extname(rel)]) return null;
  const page = path.join(PAGE_DIR, rel);
  if (fs.existsSync(page) && fs.statSync(page).isFile()) return page;
  if (ENGINE_FILE.test(rel)) { const eng = path.join(ENGINE_DIR, rel); if (fs.existsSync(eng) && fs.statSync(eng).isFile()) return eng; }
  return null;
}

/** Call before app "ready" (a scheme is registered as privileged only then). */
function register(electron) {
  const { protocol, app } = electron;
  protocol.registerSchemesAsPrivileged([{ scheme: "dxroom", privileges: { standard: true, secure: true } }]);
  app.whenReady().then(() => protocol.handle("dxroom", async (req) => {
    const u = new URL(req.url), file = req.method === "GET" ? roomFile(u.host, u.pathname) : null;
    if (!file) return new Response("not found", { status: 404, headers: { "content-security-policy": CSP } });
    return new Response(await fs.promises.readFile(file), { status: 200, headers: { "content-type": TYPES[path.extname(file)], "content-security-policy": CSP,
      "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "cache-control": "no-store" } });   // the CORS header: fonts in an opaque-origin frame
  }));
}

module.exports = { register, roomFile, CSP };
