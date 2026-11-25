"use strict";
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const files = require("./importfile");
const net = require("./netfetch");
const ARCHIVE = "https://spartacusrex.com/megaarchive/";

function latest(list) {
  const names = Array.from(list.matchAll(/href=["'](minima_megammr_\d{4}_\d{2}_\d{2}\.mmr)["']/gi), match => match[1]).sort();
  if (!names.length) throw Error("No dated snapshot was found on Spartacus Rex.");
  return ARCHIVE + names[names.length - 1];
}
async function response(url) {
  const pin = await net.vetHost(new URL(url).hostname);
  if (!pin) throw Error("The snapshot server could not be reached.");
  return new Promise((resolve, reject) => {
    const req = https.get(url, {lookup: net.connectPin(pin), signal: AbortSignal.timeout(2 * 60 * 60 * 1000)}, res => {
      if (res.statusCode === 200) resolve(res);
      else { res.destroy(); reject(Error("Snapshot server returned HTTP " + res.statusCode)); }
    });
    req.setTimeout(45000, () => req.destroy(Error("The snapshot server stopped responding.")));
    req.on("error", reject);
  });
}
async function download(source, dir, preflight, progress) {
  let url;
  if (source === "spartacus") {
    const res = await response(ARCHIVE);
    let list = "";
    for await (const chunk of res) {
      list += chunk.toString("ascii");
      if (list.length > 512 * 1024) throw Error("The archive listing is too large.");
    }
    url = latest(list);
  } else if (source === "eurobuddha") url = "https://eurobuddha.com/mega.mmr";
  else throw Error("Unknown snapshot source.");
  await fs.promises.mkdir(dir, {recursive:true, mode:0o700});
  const res = await response(url);
  const size = Number(res.headers["content-length"]);
  const file = path.join(dir, "setup.mmr");
  // The setup job owns this directory and runs once at a time. Clear its interrupted download before retry.
  try {
    if (!Number.isSafeInteger(size) || size < 1024 || size > 16 * 1024 ** 3) throw Error("The snapshot has an unexpected size.");
    await fs.promises.rm(file, {force:true});
    const space = await fs.promises.statfs(dir);
    if (space.bavail * space.bsize < size + 512 * 1024 ** 2) throw Error("Make more disk space for the snapshot.");
    preflight(size, url);
    let got = 0, last = 0;
    await pipeline(res, new Transform({ transform(chunk, enc, cb) {
      got += chunk.length;
      if (got > size) return cb(Error("The snapshot size changed."));
      if (Date.now() - last > 500) { progress(got, size); last = Date.now(); }
      cb(null,chunk);
    }}), fs.createWriteStream(file,{flags:"wx",mode:0o600}));
    if (got !== size) throw Error("The snapshot download was interrupted.");
    files.megammrHeader(file,fs);
    return file;
  } catch (error) {
    res.destroy();
    await fs.promises.rm(file,{force:true}).catch(()=>{});
    throw error;
  }
}
module.exports = {latest, download};
