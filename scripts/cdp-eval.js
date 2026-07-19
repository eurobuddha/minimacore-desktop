/*
 * cdp-eval.js — dependency-free CDP client (raw net socket + WS handshake + masked text frames). Connects to
 * the page target on --remote-debugging-port and Runtime.evaluate's the expression passed on argv, awaiting
 * promises and returning by value. Usage: node scripts/cdp-eval.js '<js expression>'
 */
const net = require("net");
const crypto = require("crypto");
const http = require("http");

const PORT = 9333;
const EXPR = process.argv[2] || "1+1";

function targets() {
  return new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:" + PORT + "/json", res => {
      let b = ""; res.on("data", d => b += d); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
function wsEval(wsUrl, expr) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshook = false, buf = Buffer.alloc(0);
    const id = 1;
    function sendFrame(obj) {
      const data = Buffer.from(JSON.stringify(obj));
      const len = data.length;
      let header;
      const mask = crypto.randomBytes(4);
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }
    sock.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        buf = buf.slice(idx + 4); handshook = true;
        sendFrame({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } });
      }
      // parse server frames (unmasked)
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f; let off = 2, plen = len0;
        if (len0 === 126) { if (buf.length < 4) break; plen = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) break; plen = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + plen) break;
        const payload = buf.slice(off, off + plen).toString(); buf = buf.slice(off + plen);
        try { const msg = JSON.parse(payload); if (msg.id === id) { sock.end(); return resolve(msg.result); } } catch (e) {}
      }
    });
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); reject(new Error("CDP eval timeout")); }, 60000);
  });
}
(async () => {
  const t = (await targets()).find(x => x.type === "page");
  if (!t) throw new Error("no page target");
  const r = await wsEval(t.webSocketDebuggerUrl, EXPR);
  if (r && r.result && "value" in r.result) console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value));
  else console.log(JSON.stringify(r));
})().catch(e => { console.error("CDP ERROR:", e.message); process.exit(1); });
