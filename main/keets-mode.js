"use strict";

/** MinimaFlags.tokenise of the Parlons Node, ported: what the jar makes of its one -Dparlons.node.args string. */
function tokeniseParlons(raw) {
  const out = []; let cur = "", quote = "", have = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && i + 1 < raw.length && quote === '"') cur += raw[++i];
      else cur += c;
      have = true;
    } else if (c === "'" || c === '"') { quote = c; have = true; }
    else if (c === "\\" && i + 1 < raw.length) { cur += raw[++i]; have = true; }
    else if (/\s/.test(c)) { if (have) { out.push(cur); cur = ""; have = false; } }
    else { cur += c; have = true; }
  }
  if (have) out.push(cur);
  return out;
}
/** Every token the node's own parser is handed by a finished java argv, for either node kind. */
function nodeTokens(argv) {
  const out = [];
  for (const a of argv.map(String)) {
    if (a.startsWith("-Dparlons.node.args=")) out.push(...tokeniseParlons(a.slice("-Dparlons.node.args=".length)));
    else out.push(a);
  }
  return out;
}

// ParamConfigurer.usingProgramArgs uses the last -keets and its optional value.
function enabledInArgs(argv) {
  const tokens = nodeTokens(argv);
  const pos = tokens.lastIndexOf("-keets");
  if (pos < 0) return false;
  const value = tokens[pos + 1];
  return value === undefined || value.startsWith("-") || value === "true";
}
module.exports = { enabledInArgs };
