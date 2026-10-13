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
                legacy: false
            };
        }
    } catch (e) { /* not schema JSON — legacy plain text */ }
    return { id: null, body: "" + raw, name: "", ref: "", ts: null, legacy: true };
}

module.exports = { CHAT_APPLICATION, chatEncode, chatDecode };
