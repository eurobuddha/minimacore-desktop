/*
 * parlons.js — the Parlons account that the Parlons Node (nodeKind "parlons") hosts under this node's seed.
 *
 * The account serves its own web panel on 127.0.0.1:<basePort+586> (ParlonsLocal in the maxima repo). A
 * browser gets in with a ONE-TIME ticket the account keeps in <data>/panel-ticket.txt (owner-only file; it
 * writes the next one as soon as one is used). This module reads that file for the in-app Parlons tab and
 * for "Open in browser", and reads account.txt / invite.txt for the native strip above the panel. Nothing
 * here talks to the account over the network; the renderer's <webview> does, same-origin, cookie-bound.
 */
const { shell } = require("electron");
const fs = require("fs");
const path = require("path");
const node = require("./node-manager");

function readTrim(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch (e) { return ""; }
}

/** The unused one-time panel link, or "" (account not up yet / not the Parlons kind). */
function ticketUrl() {
  if (node.kind() !== "parlons") return "";
  const url = readTrim(path.join(node.dataDir(), "panel-ticket.txt"));
  return url.startsWith("http://127.0.0.1:" + node.panelPort() + "/open?ticket=") ? url : "";
}

function status() {
  const dir = node.dataDir();
  const snap = node.snapshot();
  return {
    kind: snap.kind,
    ready: !!(snap.parlons && snap.parlons.ready),
    error: (snap.parlons && snap.parlons.error) || "",
    version: (snap.parlons && snap.parlons.version) || "",
    cape: !!(snap.parlons && snap.parlons.cape),
    panelPort: node.panelPort(),
    capePort: node.capePort(),
    address: node.kind() === "parlons" ? readTrim(path.join(dir, "account.txt")) : "",   // the permanent MAX#… (whole)
    invite: node.kind() === "parlons" ? readTrim(path.join(dir, "invite.txt")) : "",     // MAX#…?code=… while a code is outstanding
    hasTicket: !!ticketUrl(),
    blocker: node.parlonsBlocker()
  };
}

/** Open the panel in the user's browser with a fresh one-time link. Only ever the loopback panel origin. */
function openExternal() {
  const url = ticketUrl();
  if (!url) return false;
  shell.openExternal(url);
  return true;
}

module.exports = { ticketUrl, status, openExternal };
