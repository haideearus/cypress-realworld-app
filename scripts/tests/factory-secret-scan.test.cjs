const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanFiles, scanText, verifyBinary } = require("../factory/secret-scan.cjs");
const { release } = require("../factory/scanner-release.cjs");
test("scanner refuses an executable with the wrong checksum before running it", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "factory-scanner-test-"));
  const binary = path.join(folder, "fake-scanner");
  fs.writeFileSync(binary, "not a trusted binary");
  assert.throws(() => verifyBinary(binary), /integrity|checksum/i);
});
test("scanner text API stages only bounded data and returns a sanitized finding summary", async () => {
  let received;
  const result = await scanText("Some ordinary task text", {
    run: async (input) => {
      received = input;
      return { status: 0, findings: [] };
    },
  });
  assert.equal(result.clean, true);
  assert.equal(received.files.length, 1);
  assert.equal(received.files[0].content, "Some ordinary task text");
});
test("a detected secret blocks without reflecting raw scanner output", async () => {
  const privateValue = "never-echo-this-private-fixture";
  await assert.rejects(
    () =>
      scanText("input", {
        run: async () => ({
          status: 1,
          findings: [{ RuleID: "generic-api-key", Secret: privateValue, Match: privateValue }],
        }),
      }),
    (error) => !error.message.includes(privateValue) && /secret/i.test(error.message)
  );
});
test("scanner configuration errors and malformed responses fail closed", async () => {
  for (const response of [
    { status: 2, findings: [] },
    { status: 0, findings: {} },
    { status: 0, findings: [{ RuleID: "test" }] },
  ])
    await assert.rejects(() => scanText("input", { run: async () => response }));
});
test("scan input rejects traversal, duplicate paths and oversized records", async () => {
  for (const files of [
    [{ path: "../escape", content: "x" }],
    [
      { path: "a", content: "x" },
      { path: "a", content: "y" },
    ],
    [{ path: "a", content: "x".repeat(2100000) }],
  ])
    await assert.rejects(() =>
      scanFiles(files, { run: async () => ({ status: 0, findings: [] }) })
    );
});

test("scanner rejects Windows alternate streams, device names and normalized path aliases on every host", async () => {
  for (const name of [
    "input.txt:hidden",
    "C:/input.txt",
    "NUL",
    "sub/CON.txt",
    "a./file",
    "sub/file ",
    "sub/aux",
    "sub/a?b",
  ])
    await assert.rejects(
      () =>
        scanFiles([{ path: name, content: "ordinary text" }], {
          run: async () => ({ status: 0, findings: [] }),
        }),
      /path/i
    );
});
test("scanner release pins both supported platforms and a fixed version", () => {
  assert.equal(release.version, "8.30.1");
  for (const platform of ["win32-x64", "linux-x64"]) {
    assert.match(release.platforms[platform].archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(release.platforms[platform].binarySha256, /^[a-f0-9]{64}$/);
  }
});
test(
  "real pinned scanner accepts clean input and blocks seeded provider tokens without echoing them",
  { skip: process.env.FACTORY_SECRET_SCAN_INTEGRATION !== "true" },
  async () => {
    assert.equal((await scanText("Ordinary maintenance acceptance criteria")).clean, true);
    for (const seed of [
      ["sk", "ant", "oat01"].join("-") + "-" + "aB9cD7eF2".repeat(6),
      ["ghp", "_"].join("") + "aB9cD7eF2".repeat(4),
    ]) {
      await assert.rejects(
        () => scanText(`credential = "${seed}"`),
        (error) => /blocked/.test(error.message) && !error.message.includes(seed)
      );
    }
  }
);

test(
  "real scanner cannot skip a plaintext credential because of an ignored source filename",
  { skip: process.env.FACTORY_SECRET_SCAN_INTEGRATION !== "true" },
  async () => {
    const seed = ["sk", "ant", "oat01"].join("-") + "-" + "aB9cD7eF2".repeat(6);
    for (const name of ["gitleaks.toml", ".gitleaks.toml", "image.png"])
      await assert.rejects(
        () => scanFiles([{ path: name, content: `credential = "${seed}"` }]),
        /blocked/i
      );
  }
);
