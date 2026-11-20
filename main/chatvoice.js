/*
 * chatvoice.js — the pure rules of a KeetChat voice note, the CommonJS twin of the phone's
 *   apks/base app/.../chat/VoiceNote.java (limits, container), VoiceRecordDialog.java (fmtSecs, 100 ms sampling),
 *   WaveformView.java (summarise / encode / decode) and ChatThreadActivity.sendAudio (path, caption, message).
 *
 * A note is NOT embedded: its bytes are published on the sender's keets drive
 * (`keets action:publish path:/chat/vn-<ms><ext> file:<tmp>`) and the chat message is
 *   { application:"maxima_chat_v1", id:"kc-...", body:"M:SS|<32 hex nibbles>", name, ts, ref:"keets://...", state:"audio" }
 * The receiver fetches the ref with `keets action:fetch url:<ref> file:<cache>` and plays the file.
 * No Electron, no DOM: recording itself (MediaRecorder) lives in the renderer.
 */
"use strict";

const MAX_SECONDS = 60;          // VoiceNote.java:20
const BAR_COUNT = 32;            // WaveformView.java:20
const MAX_WAVE_CHARS = 64;       // WaveformView.java:98
const SAMPLE_MS = 100;           // VoiceRecordDialog.java:92 (one amplitude per 100 ms)
const MAX_AMPLITUDE = 32767;     // MediaRecorder.getMaxAmplitude
const BITRATE = 16000;           // VoiceNote.java:47 (16 kbps)
const SAMPLE_RATE = 16000;       // VoiceNote.java:48
const CHANNELS = 1;              // VoiceNote.java:49

/** 75 -> "1:15" */
function fmtSecs(secs) {
  secs = Math.trunc(secs);
  return Math.trunc(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
}
/** One live amplitude (0..32767) -> a bar level 1..15 (WaveformView.append). */
function level(amplitude) {
  return 1 + Math.min(14, Math.trunc(Math.sqrt(Math.min(MAX_AMPLITUDE, Math.max(0, amplitude)) / MAX_AMPLITUDE) * 14));
}
/** Recorded amplitudes (any non-negative scale) -> BAR_COUNT levels 1..15, max-pooled and normalised to the peak. */
function summarise(samples) {
  const out = new Array(BAR_COUNT);
  if (!samples || samples.length === 0) return out.fill(4);
  const n = samples.length;
  let peak = 1;
  for (const v of samples) peak = Math.max(peak, Math.trunc(v));
  for (let i = 0; i < BAR_COUNT; i++) {
    const a = Math.trunc(i * n / BAR_COUNT), b = Math.max(a + 1, Math.trunc((i + 1) * n / BAR_COUNT));
    let m = 0;
    for (let j = a; j < b && j < n; j++) m = Math.max(m, Math.trunc(samples[j]));
    out[i] = 1 + Math.min(14, Math.trunc(Math.sqrt(m / peak) * 14));
  }
  return out;
}
/** Levels -> one hex nibble per bar. */
function encode(levels) {
  let s = "";
  for (const v of levels) s += Math.max(0, Math.min(15, Math.trunc(v))).toString(16);
  return s;
}
/** Hex -> levels; null when the string is not a waveform (empty, over 64 chars, or not hex). */
function decode(hex) {
  if (typeof hex !== "string" || hex === "" || hex.length > MAX_WAVE_CHARS || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  return Array.from(hex, (c) => parseInt(c, 16));
}
/** The message body: "M:SS|waveformhex" (or just "M:SS" with no waveform). */
function buildBody(secs, waveHex) {
  return fmtSecs(secs) + (waveHex ? "|" + waveHex : "");
}
/** Body -> { duration, waveHex, levels }. levels is null when there is no (valid) waveform; the phone then draws 32 flat bars. */
function parseBody(body) {
  body = typeof body === "string" ? body : "";
  const bar = body.indexOf("|");
  const duration = bar > 0 ? body.slice(0, bar) : body, waveHex = bar > 0 ? body.slice(bar + 1) : "";
  return { duration, waveHex, levels: waveHex ? decode(waveHex) : null };
}
/** A recording is sendable when it has bytes and lasted at least one whole second (VoiceRecordDialog.java:125). */
function sendable(byteLength, secs) { return byteLength > 0 && secs >= 1; }
function clampSecs(secs) { return Math.min(MAX_SECONDS, Math.max(0, Math.trunc(secs))); }
/**
 * The published file's extension. The phone's own rule (ChatThreadActivity.java:448) is: mime contains "ogg" -> ".ogg",
 * anything else -> ".m4a". ".webm" is a DESKTOP extension for Chromium's MediaRecorder output: the phone plays by
 * content (it caches every note as <hash>.bin), but a desktop older than the one that ships this maps an unknown
 * extension to image/jpeg in main/chat.js fetchMedia, so fetchMedia's allowlist must gain "webm" in the same release.
 */
function extFor(mime) {
  const m = ("" + (mime || "")).toLowerCase();
  return m.includes("ogg") ? ".ogg" : m.includes("webm") ? ".webm" : ".m4a";
}
/** `keets action:publish path:` for a note recorded now. */
function publishPath(mime, now) { return "/chat/vn-" + (now === undefined ? Date.now() : now) + extFor(mime); }
/** The mime to play a fetched note with, from its ref's extension (query string ignored). "" = unknown. */
function mimeForRef(ref) {
  const m = /\.(ogg|m4a|webm|wav)$/.exec(("" + (ref || "")).split("?")[0].toLowerCase());
  return !m ? "" : m[1] === "ogg" ? "audio/ogg" : m[1] === "m4a" ? "audio/mp4" : m[1] === "webm" ? "audio/webm" : "audio/wav";
}

module.exports = { MAX_SECONDS, BAR_COUNT, MAX_WAVE_CHARS, SAMPLE_MS, MAX_AMPLITUDE, BITRATE, SAMPLE_RATE, CHANNELS,
  fmtSecs, level, summarise, encode, decode, buildBody, parseBody, sendable, clampSecs, extFor, publishPath, mimeForRef };
