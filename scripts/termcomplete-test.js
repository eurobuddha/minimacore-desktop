/* Headless test for the terminal autocomplete engine (renderer/termcomplete.js).
 * No electron, no node connection — pure string logic. Run: npm run test:termcomplete */
const path = require("path");
global.TERM_HELP = require(path.join(__dirname, "..", "renderer", "termhelp.js"));
const TC = require(path.join(__dirname, "..", "renderer", "termcomplete.js"));

let fails = 0, checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { fails++; console.error("FAIL: " + msg); }
}
function labels(res) { return res.items.map((i) => i.label); }

// 1. Empty input -> quiet.
{
  const r = TC.suggest("", 0);
  ok(r.items.length === 0 && r.paramHint === null, "empty input suggests nothing");
}

// 2. "me" -> prefix matches before substring matches; command inserts end with a space.
{
  const r = TC.suggest("me", 2);
  const ls = labels(r);
  ok(ls.includes("megammr") && ls.includes("mempool"), "'me' offers megammr/mempool, got: " + ls.join(","));
  const lastPrefix = ls.map((l) => l.startsWith("me")).lastIndexOf(true);
  const firstSub = ls.map((l) => !l.startsWith("me")).indexOf(true);
  ok(firstSub === -1 || firstSub > lastPrefix, "prefix matches come before substring matches");
  ok(r.items.every((i) => i.kind !== TC.KIND_COMMAND || i.insert.endsWith(" ")), "command inserts end with a space");
}

// 3. Exact command, no trailing space: hint set, its params FIRST, then sibling commands.
{
  const r = TC.suggest("send", 4);
  ok(r.paramHint && r.paramHint.startsWith("send"), "paramHint is send's usage line");
  ok(r.items.length > 0 && r.items[0].kind === TC.KIND_PARAM, "send's params come first");
  ok(r.items[0].insert.startsWith(" "), "param insert after bare command starts with a space");
  ok(labels(r).includes("sendpoll"), "sibling commands (sendpoll) still offered after params");
}

// 4. "send " -> params only (send's help marks every param optional).
{
  const r = TC.suggest("send ", 5);
  ok(r.items.every((i) => i.kind === TC.KIND_PARAM), "'send ' offers only params");
  const ls = labels(r);
  ok(ls.includes("address:") && ls.includes("amount:"), "address:/amount: offered");
  ok(r.items.some((i) => i.desc), "params carry descriptions from help");
}

// 4b. Required params (tokencreate: name/amount unmarked among optional siblings) first and flagged.
{
  const r = TC.suggest("tokencreate ", 12);
  const req = r.items.filter((i) => i.required).map((i) => i.label);
  ok(req.includes("name:") && req.includes("amount:"), "tokencreate name:/amount: flagged required, got: " + req.join(","));
  const lastReq = r.items.map((i) => i.required).lastIndexOf(true);
  const firstOpt = r.items.map((i) => !i.required).indexOf(true);
  ok(firstOpt === -1 || firstOpt > lastReq, "required params sorted first");
}

// 5. Used params are skipped.
{
  const r = TC.suggest("send amount:1 ", 14);
  ok(!labels(r).includes("amount:"), "amount: not re-offered once used");
  ok(labels(r).includes("address:"), "unused params still offered");
}

// 6. Value completion: coins order: -> exactly asc,desc.
{
  const r = TC.suggest("coins order:", 12);
  ok(labels(r).join(",") === "asc,desc", "coins order: -> asc,desc, got: " + labels(r).join(","));
  ok(r.items[0].insert === "order:asc ", "value insert is 'order:asc ', got: " + r.items[0].insert);
}

// 7. help command:<x> completes command names with briefs.
{
  const r = TC.suggest("help command:me", 15);
  const ls = labels(r);
  ok(ls.includes("megammr") && ls.includes("mempool"), "help command:me offers command names");
  ok(r.items.some((i) => i.desc), "help command values carry command briefs");
}

// 8. Unclosed quote -> quiet.
{
  const t = 'newscript script:"hello wo';
  const r = TC.suggest(t, t.length);
  ok(r.items.length === 0, "unclosed quote suppresses suggestions");
  const t2 = 'newscript script:"hello world" ';
  ok(TC.suggest(t2, t2.length).items.length > 0, "closed quote resumes suggestions");
}

// 9. ; chains: complete the second segment; apply splices after the ';'.
{
  const t = "status; coi";
  const r = TC.suggest(t, t.length);
  ok(labels(r).includes("coins"), "second segment completes commands");
  const it = r.items.find((i) => i.label === "coins");
  ok(TC.apply(t, t.length, it) === "status; coins ", "apply keeps text before the ';'");
}

// 10. Mid-line caret: splice does not clobber trailing text.
{
  const t = "coins  depth:4";
  const r = TC.suggest(t, 6); // caret right after "coins "
  ok(r.items.length > 0 && r.items.every((i) => i.kind === TC.KIND_PARAM), "mid-line caret offers params");
  const it = r.items.find((i) => i.label === "order:");
  ok(TC.apply(t, 6, it) === "coins order: depth:4", "mid-line apply preserves trailing text, got: " + TC.apply(t, 6, it));
}

// 11. applyCaret lands right after the inserted text.
{
  const t = "coins order:";
  const r = TC.suggest(t, t.length);
  const it = r.items[0]; // order:asc
  const nt = TC.apply(t, t.length, it);
  ok(nt === "coins order:asc ", "value accept text, got: " + nt);
  ok(TC.applyCaret(t, t.length, it) === nt.length, "caret lands after inserted trailing space");
}

// 12. Registry sanity.
{
  ok(TC.suggest("s", 1).items.length > 0, "registry parsed and serving");
  ok(TC.usage("coins").includes("order:asc|desc"), "usage('coins') carries value lists, got: " + TC.usage("coins"));
  ok(TC.usage("quit") === "quit  compact:true|false", "usage('quit'), got: " + TC.usage("quit"));
  ok(TC.usage("mmrproof").startsWith("mmrproof"), "last registry line (mmrproof) parsed");
}

if (fails) { console.error(`termcomplete-test: ${fails}/${checks} checks FAILED`); process.exit(1); }
console.log(`termcomplete-test: all ${checks} checks passed`);
