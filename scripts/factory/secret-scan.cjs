const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  ensureScanner,
  verifyBinary,
  safeEnvironment,
  removeOwned,
} = require("./scanner-install.cjs");
function validName(value) {
  return (
    typeof value === "string" &&
    value.length <= 240 &&
    !/[\\\x00-\x1f<>:"|?*]/.test(value) &&
    !path.posix.isAbsolute(value) &&
    !value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  );
}
async function runScanner({ files }) {
  const binary = verifyBinary(await ensureScanner());
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "haide-scanner-input-"));
  try {
    const source = path.join(folder, "source");
    fs.mkdirSync(source);
    for (const [index, file] of files.entries()) {
      // Default Gitleaks filename exclusions must not suppress submitted content.
      // Paths are validated separately; the scanner sees only generated text names.
      const destination = path.join(source, `content-${index}.txt`);
      fs.writeFileSync(destination, file.content, { flag: "wx", mode: 0o600 });
    }
    const ignore = path.join(folder, "empty-ignore");
    fs.writeFileSync(ignore, "");
    const report = path.join(folder, "redacted-findings.json");
    const result = spawnSync(
      binary,
      [
        "dir",
        source,
        "--config",
        path.join(__dirname, "gitleaks.toml"),
        "--redact=100",
        "--no-banner",
        "--no-color",
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path",
        ignore,
        "--report-format",
        "json",
        "--report-path",
        report,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 2000000,
        stdio: "pipe",
        windowsHide: true,
        env: safeEnvironment(),
      }
    );
    if (result.error || ![0, 1].includes(result.status) || !fs.existsSync(report))
      return { status: 2, findings: [] };
    const stat = fs.lstatSync(report);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000)
      return { status: 2, findings: [] };
    const findings = JSON.parse(fs.readFileSync(report, "utf8"));
    return { status: result.status, findings };
  } finally {
    removeOwned(folder);
  }
}
async function scanFiles(files, { run = runScanner } = {}) {
  if (!Array.isArray(files) || files.length > 10000) throw new Error("Invalid scanner input size");
  let total = 0;
  const names = new Set();
  for (const file of files) {
    if (
      !validName(file.path) ||
      names.has(file.path.toLowerCase()) ||
      !(typeof file.content === "string" || Buffer.isBuffer(file.content))
    )
      throw new Error("Invalid scanner input path or data");
    names.add(file.path.toLowerCase());
    const size = Buffer.byteLength(file.content);
    total += size;
    if (size > 2000000 || total > 32000000) throw new Error("Scanner input exceeds safe size");
  }
  if (!files.length) return { clean: true, files: 0 };
  const result = await run({ files });
  if (
    ![0, 1].includes(result?.status) ||
    !Array.isArray(result.findings) ||
    (result.status === 0 && result.findings.length)
  )
    throw new Error("Secret scanner failed closed; no raw findings are logged");
  if (result.status !== 0 || result.findings.length) {
    const rules = [
      ...new Set(
        result.findings
          .map((item) => item.RuleID)
          .filter((id) => typeof id === "string" && /^[a-z0-9-]{1,100}$/.test(id))
      ),
    ].slice(0, 20);
    throw new Error(
      `Secret scanner blocked ${result.findings.length} finding(s); rules=${rules.join(",") || "unavailable"}. Values and locations are redacted.`
    );
  }
  return { clean: true, files: files.length };
}
const scanText = (text, options) => scanFiles([{ path: "input.txt", content: text }], options);
function sourceFiles(cwd) {
  const files = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 2000000,
    stdio: "pipe",
    env: safeEnvironment(),
  })
    .split("\0")
    .filter(Boolean);
  if (files.length > 10000) throw new Error("Tracked source exceeds scanner file bound");
  let total = 0;
  return files.map((name) => {
    if (!validName(name)) throw new Error("Unsafe tracked scanner path");
    const filename = path.join(cwd, ...name.split("/"));
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000)
      throw new Error("Scanner requires bounded regular tracked files");
    total += stat.size;
    if (total > 32000000) throw new Error("Tracked source exceeds scanner byte bound");
    return { path: name, content: fs.readFileSync(filename) };
  });
}
async function main(env = process.env, args = process.argv.slice(2)) {
  let files;
  if (args.length === 1 && args[0] === "source")
    files = sourceFiles(env.GITHUB_WORKSPACE || process.cwd());
  else if (args.length === 2 && args[0] === "file") {
    const stat = fs.lstatSync(args[1]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000)
      throw new Error("Unsafe scanner input file");
    files = [{ path: "input.json", content: fs.readFileSync(args[1]) }];
  } else throw new Error("Usage: secret-scan.cjs source | file PATH");
  const result = await scanFiles(files);
  console.log(
    `Secret scan passed for ${result.files} staged file(s); scanner values are never logged.`
  );
  return result;
}
if (require.main === module)
  main().catch((error) => {
    console.error(
      /^Secret scanner /.test(error.message)
        ? error.message
        : "Secret scan failed closed; inspect trusted scanner configuration"
    );
    process.exitCode = 1;
  });
module.exports = { scanFiles, scanText, verifyBinary, sourceFiles, main };
