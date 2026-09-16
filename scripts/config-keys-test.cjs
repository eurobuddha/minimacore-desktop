/*
 * config-keys-test.cjs — every key the renderer persists must be declared in main/config.js DEFAULTS.
 *
 * THE BUG THIS EXISTS FOR (0.16.97 → 0.16.99). config.save() gained an allowlist that drops any key not in
 * DEFAULTS. `casinoDollar` had lived in the renderer since 0.16.37 and was never mirrored into DEFAULTS, so
 * the Casino MINIMA↔MxUSD toggle went dead: the patch was dropped, save() returned the UNCHANGED config, the
 * renderer reassigned CFG from that return value (wiping its optimistic flip) and repainted the old label.
 * Nothing threw, nothing logged — a config bug that looked exactly like a broken button.
 *
 * The allowlist is worth keeping (it coerces types and range-checks basePort/heapMb), but it is only safe if
 * it is COMPLETE. This test keeps it complete by construction rather than by memory.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const configSrc = fs.readFileSync(path.join(ROOT, 'main/config.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

/** The DEFAULTS object literal in main/config.js → its top-level key names. */
function defaultsKeys() {
  const start = configSrc.indexOf('const DEFAULTS');
  assert.ok(start >= 0, 'main/config.js must declare const DEFAULTS');
  const open = configSrc.indexOf('{', start);
  return new Set(topLevelKeys(braceBlock(configSrc, open)));
}

/** From the '{' at `open`, return the balanced block including both braces. */
function braceBlock(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error('unbalanced braces from offset ' + open);
}

/** Top-level `name:` keys of an object-literal block, ignoring nested objects, comments and strings. */
function topLevelKeys(block) {
  const body = block.slice(1, -1);
  const keys = [];
  let depth = 0, i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '/' && body[i + 1] === '/') { const nl = body.indexOf('\n', i); i = nl < 0 ? body.length : nl; continue; }
    if (c === '/' && body[i + 1] === '*') { const end = body.indexOf('*/', i); i = end < 0 ? body.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; } i++; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (m) { keys.push(m[1]); i += m[0].length; continue; }
    }
    i++;
  }
  return keys;
}

/**
 * Every key renderer/app.js tries to persist, across the three shapes actually in use:
 *   api.saveConfig({ … })       — object literal, the common case
 *   const patch = { … } … saveConfig(patch)   — the first-run wizard
 *   CFG.<key> = …               — the optimistic local flip that precedes a save (this is what catches
 *                                 casinoDollar, whose saveConfig literal names it too, but which would be
 *                                 caught here even if the call site were indirect)
 */
function rendererKeys() {
  const keys = new Set();

  for (const m of rendererSrc.matchAll(/saveConfig\(\s*/g)) {
    const at = m.index + m[0].length;
    if (rendererSrc[at] === '{') { topLevelKeys(braceBlock(rendererSrc, at)).forEach(k => keys.add(k)); continue; }
    const id = /^([A-Za-z_$][\w$]*)/.exec(rendererSrc.slice(at));
    if (!id) continue;
    // an identifier: find the nearest preceding `const <id> = {` and read that literal
    const decl = rendererSrc.lastIndexOf('const ' + id[1] + ' = {', at);
    if (decl < 0) continue;
    topLevelKeys(braceBlock(rendererSrc, rendererSrc.indexOf('{', decl))).forEach(k => keys.add(k));
  }

  for (const m of rendererSrc.matchAll(/\bCFG\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) keys.add(m[1]);

  return keys;
}

test('every config key the renderer persists is declared in DEFAULTS', () => {
  const defaults = defaultsKeys();
  const used = rendererKeys();

  assert.ok(defaults.size > 10, 'sanity: DEFAULTS parsed (' + defaults.size + ' keys)');
  assert.ok(used.size > 5, 'sanity: renderer keys parsed (' + used.size + ' keys)');

  const missing = [...used].filter(k => !defaults.has(k)).sort();
  assert.deepStrictEqual(missing, [],
    'These keys are written by renderer/app.js but are NOT in main/config.js DEFAULTS, so config.save() ' +
    'silently DROPS them and the setting can never persist: ' + missing.join(', ') +
    '\nAdd each to DEFAULTS (that is the whole fix — see the 0.16.99 casinoDollar regression).');
});

test('the keys this regression was about are present', () => {
  const defaults = defaultsKeys();
  // Named explicitly so a future tidy-up of DEFAULTS cannot quietly drop the one that broke.
  for (const k of ['casinoDollar', 'casinoEnabled', 'casinoAgeCertified', 'theme', 'labels']) {
    assert.ok(defaults.has(k), 'DEFAULTS must declare ' + k);
  }
});
