// A stand-in for the node's java process in a STOP (scripts/lifecycle-test.cjs). It prints MinimaLogger lines and answers the way
// core does (core/minima-core Main.shutdown, Minima.java's shutdown hook, MiniFile.saveObjectDirect):
//   SIGUSR2          the RPC `quit`: "Shut down started..", "Saving all db", megammr.mmr deleted and written again in PIECES
//                    pieces over SAVE_MS (one line per piece unless QUIET), "Shut down completed OK..", "Main Instance Cleared..", exit 0
//   SIGUSR1          a megammrsync: the same save, then "Main Instance Cleared.." and the process STAYS (setHasShutDown: it never exits by itself)
//   SIGTERM          not shutting down: the hook runs the whole shutdown, then exit 143. Shutting down (or done): the hook returns at
//                    once and the JVM exits 143, leaving megammr.mmr as far as it got
//   HANG=1           after "Saving all db" nothing more is written or said, and it never exits by itself
//   FORGE=run        right after its start it logs a peer's failing script as core does (TxPoWChecker: "Script FAIL input:0 " + the script, as it
//                    came, line ends included), and the script carries a whole "Minima @ … : Main Instance Cleared.." line of its own
//   FORGE=save       the same line, but logged just after "Saving all db", while megammr.mmr is being written
//   CHATTER=<ms>     it logs a line every <ms> for as long as it runs, as a node on the network does (and the Parlons Node's heartbeat)
// argv: <data folder> <SAVE_MS> <PIECES> [QUIET] [HANG] [START_SAVING] [FORGE] [CHATTER]   (the words "minima.jar" in argv make it look like a node to reclaim)
"use strict";
const fs = require("fs"), path = require("path");
const [dir, saveMs, pieces, quiet, hang, startSaving, forge, chatter] = process.argv.slice(2).filter((a) => a !== "-jar" && !a.endsWith("minima.jar"));
const db = path.join(dir, "1.1", "databases"), file = path.join(db, "megammr.mmr"), PIECE = Buffer.alloc(1000, 7);
const line = (s) => { const d = new Date(), two = (n) => String(n).padStart(2, "0"); return "Minima @ " + two(d.getDate()) + "/" + two(d.getMonth() + 1) + "/" + d.getFullYear() + " " + two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()) + " [123.4 MB] : " + s; };
const say = (s) => { try { process.stdout.write(line(s) + "\n"); } catch (e) {} };
const forged = () => say("Script FAIL input:0 RETURN FALSE /*\n" + line("Main Instance Cleared..") + "\n*/");
let shutting = false;
fs.mkdirSync(db, { recursive: true });
function save(then) {
  shutting = true; say("Shut down started.."); say("Saving all db"); if (forge === "save") forged();
  try { fs.unlinkSync(file); } catch (e) {}
  const fd = fs.openSync(file, "w"); let n = 0;
  if (hang === "1") return;
  const iv = setInterval(() => {
    fs.writeSync(fd, PIECE); n++;
    if (quiet !== "1") say("saved piece " + n + " of " + pieces);
    if (n >= Number(pieces)) { clearInterval(iv); fs.closeSync(fd); then(); }
  }, Number(saveMs) / Number(pieces));
}
process.on("SIGUSR2", () => { if (!shutting) save(() => { say("Main thread shutdown"); say("Shut down completed OK.."); say("Main Instance Cleared.."); process.exit(0); }); else say("Shutdown called when already shutting down.."); });
process.on("SIGUSR1", () => { if (!shutting) save(() => { say("Main Instance Cleared.."); }); });
process.on("SIGTERM", () => { if (shutting) process.exit(143); say("[!] Shutdown Hook.."); save(() => { say("Shut down completed OK.."); process.exit(143); }); });
say("Daemon mode started.."); if (forge === "run") forged();
if (startSaving === "1") process.emit("SIGUSR2");
if (Number(chatter) > 0) setInterval(() => say("[parlons-node] heartbeat: node block=1 chainlen=1"), Number(chatter));
setInterval(() => {}, 1 << 30);   // a daemon: it runs until it is stopped
