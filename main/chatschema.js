/* KeetChat wire schema — Parlons-native compatible (maxima_chat_v1 field names).
 *
 * Payload sent as the keets message body (UTF8 JSON):
 *   { "application":"maxima_chat_v1", "id":"<sender uuid>", "body":"<text>",
 *     "name":"<sender display name>", "ref":"<optional keets:// media url>", "ts":<ms> }
 *
 * The field names match Parlons' native ChatMessage (maxima repo,
 * core/.../chat/ChatMessage.java), so Parlons peers parse KeetChat messages
 * unchanged the moment parlons-node gains the keets transport. Legacy plain-text
 * payloads (KeetChat 0.1.0) are still accepted on receive.
 * Canonical copy: mds/keetchat/chatschema.js (this is the CommonJS twin for the
 * desktop main process — keep them in sync).
 */

var CHAT_APPLICATION = "maxima_chat_v1";

function chatEncode(name, body, ref) {
    var m = {
        application: CHAT_APPLICATION,
        id: "kc-" + Date.now() + "-" + Math.floor(Math.random() * 1e9),
        body: "" + body,
        name: "" + (name || ""),
        ts: Date.now()
    };
    if (ref) { m.ref = "" + ref; }
    return JSON.stringify(m);
}

/* Typed/control payload builder: extra = {state, addr, amt, tok, tokname, txid, ref}.
 * Field names are Parlons-native (ChatMessage) — see chatEncode. */
function chatEncodeTyped(name, body, extra) {
    var m = JSON.parse(chatEncode(name, body, extra && extra.ref));
    var keys = ["state", "addr", "amt", "tok", "tokname", "txid"];
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (extra && typeof extra[k] === "string" && extra[k] !== "") { m[k] = extra[k]; }
    }
    return JSON.stringify(m);
}

/* raw = the decoded utf8 payload text. Returns
 * { id|null, body, name|"", ref|"", ts|null, legacy:bool } — never throws. */
function chatDecode(raw) {
    try {
        var m = JSON.parse(raw);
        if (m && typeof m === "object" && typeof m.body === "string") {
            return {
                id: (typeof m.id === "string" && m.id.length <= 80) ? m.id : null,
                body: m.body,
                name: typeof m.name === "string" ? m.name : "",
                ref: typeof m.ref === "string" ? m.ref : "",
                ts: typeof m.ts === "number" ? m.ts : null,
                state: typeof m.state === "string" ? m.state : "",
                addr: typeof m.addr === "string" ? m.addr : "",
                amt: typeof m.amt === "string" ? m.amt : "",
                tok: typeof m.tok === "string" ? m.tok : "",
                tokname: typeof m.tokname === "string" ? m.tokname : "",
                txid: typeof m.txid === "string" ? m.txid : "",
                legacy: false
            };
        }
    } catch (e) { /* not schema JSON — legacy plain text */ }
    return { id: null, body: "" + raw, name: "", ref: "", ts: null,
        state: "", addr: "", amt: "", tok: "", tokname: "", txid: "", legacy: true };
}

module.exports = { CHAT_APPLICATION, chatEncode, chatEncodeTyped, chatDecode };
