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
      (request.action === "derive" ? "derive this address." : "sign this payment.")));
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
