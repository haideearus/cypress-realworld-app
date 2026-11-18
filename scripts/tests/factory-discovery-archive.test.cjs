const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { deflateRawSync, crc32 } = require("node:zlib");
const { ROOT } = require("../factory/github.cjs");
let archive = {};
try {
  archive = require("../factory/discovery-archive.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

const LIMIT = 4 * 1024 * 1024;
// Tiny, in-memory ZIPs keep every network and archive test entirely offline.
function zip({
  name = "bundle.json",
  text = '{"saved":true}',
  method = 8,
  descriptor = false,
  signature = true,
  flags = 0,
  attrs = 0,
} = {}) {
  const bytes = Buffer.from(text);
  const filename = Buffer.from(name);
  const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags | (descriptor ? 8 : 0), 6);
  local.writeUInt16LE(method, 8);
  if (!descriptor) {
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
  }
  local.writeUInt16LE(filename.length, 26);
  const trailer = Buffer.alloc(descriptor ? (signature ? 16 : 12) : 0);
  if (descriptor) {
    const offset = signature ? 4 : 0;
    if (signature) trailer.writeUInt32LE(0x08074b50);
    trailer.writeUInt32LE(checksum, offset);
    trailer.writeUInt32LE(compressed.length, offset + 4);
    trailer.writeUInt32LE(bytes.length, offset + 8);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags | (descriptor ? 8 : 0), 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(attrs, 38);
  const prefix = Buffer.concat([local, filename, compressed, trailer]);
  const directory = Buffer.concat([central, filename]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(prefix.length, 16);
  return Buffer.concat([prefix, directory, end]);
}
function metadata(bytes) {
  return {
    id: 123,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size_in_bytes: bytes.length,
  };
}
function setup(bytes = zip(), responses) {
  const calls = [];
  const queue = responses || [new Response(bytes)];
  const api = {
    token: "offline-secret",
    fetch: async (url, options) => {
      calls.push({ url: String(url), ...options });
      assert.ok(queue.length, "unexpected external request");
      const next = queue.shift();
      return typeof next === "function" ? next(url, options) : next;
    },
  };
  return { api, calls, metadata: metadata(bytes) };
}
function centralOffset(bytes) {
  return bytes.readUInt32LE(bytes.length - 6);
}
function mutate(bytes, change) {
  const copy = Buffer.from(bytes);
  change(copy, centralOffset(copy));
  return copy;
}

test("archive downloader and bounded decoder are available", () => {
  assert.equal(
    typeof archive.downloadJsonArtifact,
    "function",
    "missing trusted archive downloader"
  );
  assert.equal(typeof archive.decodeArchive, "function");
});

for (const options of [
  { method: 0 },
  { method: 8 },
  { descriptor: true },
  { descriptor: true, signature: false },
  { name: "evidence.json" },
]) {
  test(`reads exactly one JSON member: ${JSON.stringify(options)}`, () => {
    assert.deepEqual(archive.decodeArchive(zip(options), options.name || "bundle.json"), {
      saved: true,
    });
  });
}

test("downloads from the fixed repository with manual redirects and a deadline", async () => {
  const fixture = setup();
  assert.deepEqual(await archive.downloadJsonArtifact(fixture.api, fixture.metadata), {
    saved: true,
  });
  assert.equal(fixture.calls[0].url, `https://api.github.com${ROOT}/actions/artifacts/123/zip`);
  assert.equal(fixture.calls[0].method, "GET");
  assert.equal(fixture.calls[0].redirect, "manual");
  assert.equal(fixture.calls[0].headers.Authorization, "Bearer offline-secret");
  assert.ok(fixture.calls[0].signal instanceof AbortSignal);
});

for (const location of [
  "https://example.blob.core.windows.net/artifact?sig=fixture",
  "https://production.actions.githubusercontent.com/artifact?jwt=fixture",
]) {
  test(`strips all credentials from signed redirect to ${new URL(location).hostname}`, async () => {
    const bytes = zip();
    const fixture = setup(bytes, [
      new Response(null, { status: 302, headers: { location } }),
      new Response(bytes),
    ]);
    assert.deepEqual(await archive.downloadJsonArtifact(fixture.api, fixture.metadata), {
      saved: true,
    });
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[1].url, location);
    assert.deepEqual(fixture.calls[1].headers || {}, {});
    assert.equal(fixture.calls[1].redirect, "manual");
    assert.equal(fixture.calls[1].signal, fixture.calls[0].signal);
  });
}

test("rejects unsafe signed destinations before making another request", async () => {
  for (const location of [
    "http://a.blob.core.windows.net/x",
    "https://a.blob.core.windows.net:444/x",
    "https://user:password@a.blob.core.windows.net/x",
    "https://a.blob.core.windows.net.evil.invalid/x",
    "https://evil.invalid/x",
    "/relative",
    "https://blob.core.windows.net/x",
    "https://actions.githubusercontent.com/x",
  ]) {
    const fixture = setup(zip(), [new Response(null, { status: 302, headers: { location } })]);
    await assert.rejects(archive.downloadJsonArtifact(fixture.api, fixture.metadata), /redirect/i);
    assert.equal(fixture.calls.length, 1);
  }
});

test("rejects redirect chains, missing locations and unsuccessful downloads", async () => {
  for (const responses of [
    [new Response(null, { status: 302 })],
    [new Response(null, { status: 403 })],
    [
      new Response(null, {
        status: 302,
        headers: { location: "https://a.blob.core.windows.net/x?sig=fixture" },
      }),
      new Response(null, {
        status: 302,
        headers: { location: "https://b.blob.core.windows.net/x" },
      }),
    ],
  ]) {
    const fixture = setup(zip(), responses);
    await assert.rejects(
      archive.downloadJsonArtifact(fixture.api, fixture.metadata),
      /redirect|download|response/i
    );
    assert.ok(fixture.calls.length <= 2);
  }
});

test("validates metadata and permitted member before sending credentials", async () => {
  for (const patch of [
    { id: 0 },
    { id: "123" },
    { id: 1.2 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { digest: "sha256:abc" },
    { digest: "a".repeat(64) },
    { size_in_bytes: 0 },
    { size_in_bytes: LIMIT + 1 },
    { size_in_bytes: 1.5 },
  ]) {
    const fixture = setup();
    await assert.rejects(
      archive.downloadJsonArtifact(fixture.api, { ...fixture.metadata, ...patch }),
      /metadata|digest|size|id/i
    );
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = setup();
  await assert.rejects(
    archive.downloadJsonArtifact(fixture.api, fixture.metadata, "../bundle.json"),
    /member/i
  );
  assert.equal(fixture.calls.length, 0);
});

test("verifies the complete ZIP digest and exact size before JSON decoding", async () => {
  for (const patch of [
    { digest: `sha256:${"0".repeat(64)}` },
    { size_in_bytes: zip().length + 1 },
    { size_in_bytes: zip().length - 1 },
  ]) {
    const fixture = setup();
    await assert.rejects(
      archive.downloadJsonArtifact(fixture.api, { ...fixture.metadata, ...patch }),
      /digest|size/i
    );
  }
  const bytes = zip();
  const changed = Buffer.from(bytes);
  changed[10] ^= 1; // ZIP timestamp, ignored by JSON decoding but covered by archive hash.
  const fixture = setup(bytes, [new Response(changed)]);
  await assert.rejects(archive.downloadJsonArtifact(fixture.api, fixture.metadata), /digest/i);
});

test("bounds bytes read even if Content-Length is absent or dishonest", async () => {
  for (const headers of [{}, { "Content-Length": "1" }, { "Content-Length": String(LIMIT + 1) }]) {
    let canceled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    const fixture = setup(zip(), [new Response(body, { headers })]);
    await assert.rejects(
      archive.downloadJsonArtifact(fixture.api, fixture.metadata),
      /size|limit/i
    );
    assert.ok(canceled);
  }
});

test("one deadline bounds uncooperative fetch and stalled body reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetchFixture = setup(zip(), [() => new Promise(() => {})]);
  const fetchResult = assert.rejects(
    archive.downloadJsonArtifact(fetchFixture.api, fetchFixture.metadata),
    /time|abort/i
  );
  t.mock.timers.tick(30001);
  await fetchResult;
  assert.ok(fetchFixture.calls[0].signal.aborted);
  const body = new ReadableStream({ start() {} });
  const bodyFixture = setup(zip(), [new Response(body)]);
  const bodyResult = assert.rejects(
    archive.downloadJsonArtifact(bodyFixture.api, bodyFixture.metadata),
    /time|abort/i
  );
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(30001);
  await bodyResult;
});

test("redirect and body share the original download deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let deliverRedirect;
  const body = new ReadableStream({ start() {} });
  const fixture = setup(zip(), [
    () =>
      new Promise((resolve) => {
        deliverRedirect = resolve;
      }),
    new Response(body),
  ]);
  const result = assert.rejects(
    archive.downloadJsonArtifact(fixture.api, fixture.metadata),
    /time|abort/i
  );
  t.mock.timers.tick(20000);
  deliverRedirect(
    new Response(null, {
      status: 302,
      headers: { location: "https://a.blob.core.windows.net/x?sig=fixture" },
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.length, 2);
  t.mock.timers.tick(10001);
  await result;
});

test("rejects unexpected paths, members, duplicate entries and trailing records", () => {
  for (const name of [
    "../bundle.json",
    "/bundle.json",
    "a/bundle.json",
    "a\\bundle.json",
    "evidence.json",
    "bundle.json\0",
  ])
    assert.throws(() => archive.decodeArchive(zip({ name })), /member|ZIP/i);
  const bytes = zip();
  assert.throws(
    () =>
      archive.decodeArchive(
        mutate(bytes, (b) => {
          b.writeUInt16LE(2, b.length - 14);
          b.writeUInt16LE(2, b.length - 12);
        })
      ),
    /entry|member|ZIP/i
  );
  assert.throws(() => archive.decodeArchive(Buffer.concat([bytes, Buffer.from("extra")])), /ZIP/i);
  assert.throws(() => archive.decodeArchive(bytes, "other.json"), /member/i);
});

test("rejects malformed headers, disk spanning, ZIP64, encryption and symlinks", () => {
  const bytes = zip();
  const changes = [
    (b) => b.writeUInt32LE(0, 0),
    (b, c) => b.writeUInt32LE(0, c),
    (b) => b.writeUInt16LE(1, b.length - 18),
    (b, c) => b.writeUInt16LE(1, c + 34),
    (b, c) => b.writeUInt32LE(0xffffffff, c + 20),
    (b, c) => b.writeUInt32LE(0xffffffff, c + 42),
    (b, c) => b.writeUInt32LE(c + 1, c + 42),
    (b) => b.writeUInt32LE(0xffffffff, b.length - 6),
    (b) => b.writeUInt16LE(65535, 28),
    (b, c) => b.writeUInt16LE(65535, c + 30),
    (b, c) => b.writeUInt16LE(99, c + 10),
    (b) => b.writeUInt16LE(0x800, 6),
  ];
  for (const change of changes)
    assert.throws(() => archive.decodeArchive(mutate(bytes, change)), /ZIP|archive/i);
  for (const options of [{ flags: 1 }, { flags: 64 }, { attrs: 0xa1ff0000 }, { method: 99 }])
    assert.throws(() => archive.decodeArchive(zip(options)), /ZIP|archive/i);
  for (const length of [0, 21, 60, bytes.length - 1])
    assert.throws(() => archive.decodeArchive(bytes.subarray(0, length)), /ZIP|archive/i);
});

test("rejects CRC mismatches, descriptor mismatches and invalid deflate streams", () => {
  const bytes = zip();
  assert.throws(
    () =>
      archive.decodeArchive(
        mutate(bytes, (b, c) => {
          b.writeUInt32LE(0, 14);
          b.writeUInt32LE(0, c + 16);
        })
      ),
    /CRC|checksum/i
  );
  const described = zip({ descriptor: true });
  assert.throws(
    () => archive.decodeArchive(mutate(described, (b, c) => b.writeUInt32LE(0, c - 12))),
    /descriptor|ZIP/i
  );
  assert.throws(
    () => archive.decodeArchive(mutate(bytes, (b) => b.fill(0xff, 41, 45))),
    /deflate|ZIP|archive/i
  );
});

test("limits expanded bytes and refuses primitive, invalid JSON and invalid UTF-8", () => {
  assert.throws(
    () => archive.decodeArchive(zip({ text: JSON.stringify({ text: "a".repeat(LIMIT) }) })),
    /size|limit/i
  );
  const lying = zip({ text: JSON.stringify({ text: "a".repeat(LIMIT) }) });
  assert.throws(
    () =>
      archive.decodeArchive(
        mutate(lying, (b, c) => {
          b.writeUInt32LE(2, 22);
          b.writeUInt32LE(2, c + 24);
        })
      ),
    /size|limit|deflate|ZIP/i
  );
  for (const text of ["null", "[]", "1", '"text"', "bad json"])
    assert.throws(() => archive.decodeArchive(zip({ text })), /JSON|object/i);
  assert.throws(
    () =>
      archive.decodeArchive(
        zip({ method: 0, text: Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]) })
      ),
    /UTF|JSON|encoding/i
  );
});
test("rate-aware recovery client downloads the signed ZIP with no credential forwarding", async () => {
  const bytes = zip(),
    calls = [];
  const responses = [
    new Response(null, {
      status: 302,
      headers: { location: "https://fixture.blob.core.windows.net/archive" },
    }),
    new Response(bytes),
  ];
  const { RecoveryGitHub } = require("../factory/recovery-github.cjs");
  const api = new RecoveryGitHub({
    token: "offline-secret",
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.ok(responses.length);
      return responses.shift();
    },
  });
  assert.deepEqual(await archive.downloadJsonArtifact(api, metadata(bytes)), { saved: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer offline-secret");
  assert.deepEqual(calls[1].options.headers, {});
});
