const path = require("path");
const { execFile } = require("child_process");
const { childEnv } = require("./keymode");

function run(request) {
  const { app } = require("electron");
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
  const jars = ["classic-webwallet.jar", "minima.jar"].map(name => path.join(resources, name));
  const java = require("./node-manager").javaPath();
  return new Promise((resolve, reject) => {
    const failure = () => reject(new Error("The local Web Wallet could not " +
      ({derive:"derive this address.",addresses:"derive the address book.",summary:"read the wallet totals.",plan:"plan these transactions.",sign:"sign this payment."}[request.action] || "complete the request.")));
    const child = execFile(java, ["-Xmx192m", "-XX:-CreateCoredumpOnCrash", "-cp",
      jars.join(path.delimiter), "ClassicWebWallet"], {
      env: childEnv(process.env), windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      if (error) return failure();
      try { resolve(JSON.parse(stdout)); } catch { failure(); }
    });
    child.stdin.on("error", failure);
    child.stdin.end(JSON.stringify(request));
  });
}

module.exports = { run };
