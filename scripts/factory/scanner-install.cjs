const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { release } = require("./scanner-release.cjs");
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function platformPin() {
  const pin = release.platforms[`${process.platform}-${process.arch}`];
  if (!pin) throw new Error("Scanner platform is unsupported");
  return pin;
}
function verifyBinary(file) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 30000000 ||
    digest(file) !== platformPin().binarySha256
  )
    throw new Error("Scanner executable integrity checksum failed");
  return file;
}
function safeEnvironment() {
  return Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
}
function removeOwned(folder) {
  const resolved = path.resolve(folder);
  const parent = path.resolve(os.tmpdir());
  if (
    path.dirname(resolved) !== parent ||
    !path.basename(resolved).startsWith("haide-scanner-") ||
    fs.lstatSync(resolved).isSymbolicLink()
  )
    throw new Error("Unsafe scanner cleanup target");
  fs.rmSync(resolved, { recursive: true, force: true });
}
async function ensureScanner() {
  const pin = platformPin();
  const folder = path.join(os.tmpdir(), `haide-gitleaks-${release.version}`);
  fs.mkdirSync(folder, { recursive: true });
  if (fs.lstatSync(folder).isSymbolicLink()) throw new Error("Unsafe scanner cache directory");
  const executable = path.join(folder, pin.executable);
  if (fs.existsSync(executable)) return verifyBinary(executable);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "haide-scanner-install-"));
  try {
    let url = new URL(
      `https://github.com/gitleaks/gitleaks/releases/download/v${release.version}/${pin.archive}`
    );
    let response;
    for (let n = 0; n < 4; n++) {
      if (
        url.protocol !== "https:" ||
        ![
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
        ].includes(url.hostname)
      )
        throw new Error("Untrusted scanner download destination");
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      url = new URL(response.headers.get("location"), url);
    }
    if (!response?.ok || Number(response.headers.get("content-length")) > 30000000)
      throw new Error("Scanner download failed");
    const chunks = [];
    let downloaded = 0;
    for await (const chunk of response.body) {
      downloaded += chunk.byteLength;
      if (downloaded > 30000000) throw new Error("Scanner download exceeds safety bound");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== pin.archiveSha256)
      throw new Error("Scanner archive integrity checksum failed");
    const archive = path.join(staging, pin.archive);
    fs.writeFileSync(archive, bytes);
    execFileSync("tar", ["-xf", archive, "-C", staging, pin.executable], {
      stdio: "pipe",
      timeout: 15000,
      env: safeEnvironment(),
      windowsHide: true,
    });
    const extracted = verifyBinary(path.join(staging, pin.executable));
    const temporary = path.join(folder, `${pin.executable}.${randomUUID()}`);
    fs.copyFileSync(extracted, temporary, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, executable);
    return verifyBinary(executable);
  } finally {
    removeOwned(staging);
  }
}
if (require.main === module)
  ensureScanner()
    .then((file) =>
      console.log(`Pinned Gitleaks ${release.version} installed: ${path.basename(file)}`)
    )
    .catch(() => {
      console.error("Pinned scanner installation failed");
      process.exitCode = 1;
    });
module.exports = { ensureScanner, verifyBinary, safeEnvironment, removeOwned };
