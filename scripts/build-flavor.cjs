#!/usr/bin/env node
/*
 * build-flavor.cjs — build ANOTHER APP from this source tree (main/flavor.js): `node scripts/build-flavor.cjs <id>`.
 *
 *   --jars <dir>   copy <dir>/minima*.jar and <dir>/parlons-node*.jar into the flavour's own resources folder first
 *   --stage-only   stop after the jars are staged and checked (nothing is built)
 *   --adhoc        sign ad hoc (no certificate), when the Developer ID identity cannot be used
 *
 * What it does, and nothing else: checks the flavour is a whole separate identity (flavor.resolve), checks the
 * flavour's two node jars against the sha256 pinned for it in package.json (a jar that differs is a refusal), and
 * runs electron-builder with a config derived from package.json "build": the flavour's name, bundle id and artifact
 * names, its own app icons (package.json flavors.<id>.icons), `"flavor": "<id>"` written into the PACKAGED package.json (extraMetadata; the source file is not touched),
 * the flavour's jars as resources/minima.jar and resources/parlons-node.jar, and NO notarization.
 *
 * It downloads nothing: Electron comes from node_modules/electron/dist, native modules are not rebuilt, and nothing is
 * published. The released app's build (`npm run dist:mac:signed`) and its jar pins are not touched by any of this.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), pkg = require(path.join(ROOT, "package.json"));
const stop = (why) => { console.error("REFUSED: " + why + "\nNothing was built."); process.exit(2); };
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** The electron-builder config of a flavour, from package.json "build". Pure (scripts/flavor-test.cjs). */
function builderConfig(pkg, id, opts = {}) {
  const F = require(path.join(ROOT, "main", "flavor.js")).resolve({ flavor: id, flavors: pkg.flavors }), J = (pkg.flavors[id] || {}).jars || {};
  if (!F.id) throw new Error("name a flavour: the released app is built with npm run dist:mac:signed");
  if (!J.dir || !/^resources-[a-z0-9-]+$/.test(J.dir)) throw new Error("flavour '" + id + "' has no jars.dir (resources-<name>)");
  const cfg = JSON.parse(JSON.stringify(pkg.build));
  cfg.appId = F.appId; cfg.productName = F.productName;
  cfg.extraMetadata = { flavor: id, productName: F.productName };
  cfg.directories = { output: "dist" };
  cfg.electronDist = "node_modules/electron/dist";   // the Electron already installed: nothing is downloaded
  cfg.npmRebuild = false;
  cfg.publish = null;
  cfg.mac = Object.assign({}, cfg.mac, { notarize: false, bundleShortVersion: pkg.version, bundleVersion: pkg.version, artifactName: F.artifact + "-" + pkg.version + "-${arch}.${ext}" });
  // the questions macOS asks for the camera and the microphone name the app that asks, not the released one
  const released = require(path.join(ROOT, "main", "flavor.js")).RELEASED.windowTitle;
  for (const [k, v] of Object.entries(cfg.mac.extendInfo || {})) if (typeof v === "string") cfg.mac.extendInfo[k] = v.split(released).join(F.productName);
  if (opts.adhoc) cfg.mac.identity = "-";
  cfg.win = Object.assign({}, cfg.win, { artifactName: F.artifact + "-${version}-x64.${ext}" });
  cfg.linux = Object.assign({}, cfg.linux, { artifactName: F.artifact + "-${version}-x64.${ext}" });
  // the flavour's own app icon on all three (the Dock and the DMG's volume icon take mac): never the released app's build/icon.*
  const I = (pkg.flavors[id] || {}).icons || {};
  if (!I.mac || !I.win || !I.linux) throw new Error("flavour '" + id + "' has no icons { mac, win, linux }");
  cfg.mac.icon = I.mac; cfg.win.icon = I.win; cfg.linux.icon = I.linux;
  cfg.extraResources = cfg.extraResources.map(r => (r.to === "minima.jar" ? { from: J.dir + "/minima.jar", to: "minima.jar" } : r.to === "parlons-node.jar" ? { from: J.dir + "/parlons-node.jar", to: "parlons-node.jar" } : r));
  return { F, J, cfg };
}
/** Why the flavour's staged jars may not be packaged ("" = they may): each must be there and be the pinned bytes. */
function jarProblem(dir, J) {
  for (const [file, pin] of [["minima.jar", J.minimaSha256], ["parlons-node.jar", J.parlonsNodeSha256]]) {
    const f = path.join(dir, file);
    if (!/^[0-9a-f]{64}$/.test(String(pin || ""))) return "package.json pins no sha256 for this flavour's " + file;
    if (!fs.existsSync(f)) return f + " is missing. Stage the jars with --jars <dir>.";
    const got = sha(f);
    if (got !== pin) return f + " is not the pinned jar: sha256 " + got + ", package.json pins " + pin;
  }
  return "";
}

if (require.main === module) {
  const args = process.argv.slice(2), id = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--jars") || "";
  const jarsFrom = args.includes("--jars") ? args[args.indexOf("--jars") + 1] : "";
  let built; try { built = builderConfig(pkg, id, { adhoc: args.includes("--adhoc") }); } catch (e) { stop(e.message); }
  const { F, J, cfg } = built, dir = path.join(ROOT, J.dir);
  if (jarsFrom) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [stem, dest] of [["minima", "minima.jar"], ["parlons-node", "parlons-node.jar"]]) {
      const found = fs.readdirSync(jarsFrom).filter(n => n.startsWith(stem) && n.endsWith(".jar"));
      if (found.length !== 1) stop("--jars: expected exactly one " + stem + "*.jar in " + jarsFrom + ", found " + found.length);
      fs.copyFileSync(path.join(jarsFrom, found[0]), path.join(dir, dest));
      console.log("staged " + path.join(jarsFrom, found[0]) + " -> " + path.join(J.dir, dest));
    }
  }
  const bad = jarProblem(dir, J); if (bad) stop(bad);
  for (const need of ["resources/jre/bin/java", "resources/keets-sidecar/index.js", "resources/keets-sidecar/node_modules", "node_modules/electron/dist", "node_modules/electron-builder/cli.js"])
    if (!fs.existsSync(path.join(ROOT, need))) stop(need + " is missing. It is copied from the released app's tree, never downloaded: see docs/DEV_RUN.md (Another app from this tree).");
  console.log("flavour      : " + F.id + " = " + F.productName + " (" + F.appId + ")");
  console.log("data folder  : <application data>/" + F.userData + "    keychain service: " + F.keychainService);
  console.log("base port    : " + F.basePort + "    updates: " + (F.updates ? "on" : "OFF") + "    open at login: " + (F.loginItem ? "allowed" : "OFF"));
  console.log("node jars    : minima " + J.minima + " sha256 " + J.minimaSha256 + "\n               parlons-node " + J.parlonsNode + " sha256 " + J.parlonsNodeSha256);
  if (args.includes("--stage-only")) { console.log("staged and checked. Nothing was built (--stage-only)."); process.exit(0); }
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  const file = path.join(ROOT, "dist", "flavor-" + F.id + ".builder.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const env = Object.assign({}, process.env, { CSC_IDENTITY_AUTO_DISCOVERY: args.includes("--adhoc") ? "false" : "true" });
  delete env.APPLE_KEYCHAIN_PROFILE; delete env.APPLE_ID; delete env.APPLE_APP_SPECIFIC_PASSWORD; delete env.APPLE_API_KEY;   // never notarized from here
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "electron-builder", "cli.js"), "--mac", "--arm64", "--config", file, "--publish", "never"], { cwd: ROOT, stdio: "inherit", env });
  process.exit(r.status == null ? 1 : r.status);
}

module.exports = { builderConfig, jarProblem };
