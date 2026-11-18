const { createHash, timingSafeEqual } = require("node:crypto");
const { inflateRawSync, crc32 } = require("node:zlib");
const { ROOT } = require("./github.cjs");

const LIMIT = 4 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function validMember(member) {
  if (member !== "bundle.json" && member !== "evidence.json")
    throw new Error("Unsupported archive member");
}

function zipCheck(condition, message) {
  if (!condition) throw new Error(`Invalid ZIP archive: ${message}`);
}

function extraFields(bytes, start, length) {
  const end = start + length;
  zipCheck(end <= bytes.length, "extra field bounds");
  while (start < end) {
    zipCheck(start + 4 <= end, "extra field header");
    const id = bytes.readUInt16LE(start);
    const size = bytes.readUInt16LE(start + 2);
    zipCheck(id !== 1, "ZIP64 is unsupported");
    start += 4 + size;
    zipCheck(start <= end, "extra field size");
  }
}

// Parse in memory only. A single member and contiguous records rule out hidden
// local entries and ambiguous layouts; no filesystem or archive executable runs.
function decodeArchive(bytes, member = "bundle.json") {
  validMember(member);
  zipCheck(Buffer.isBuffer(bytes) && bytes.length >= 22, "missing end record");
  zipCheck(bytes.length <= LIMIT, "compressed size limit");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  zipCheck(end >= 0, "missing end record or trailing bytes");
  zipCheck(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, "disk spanning");
  zipCheck(
    bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1,
    "expected exactly one entry"
  );
  const directorySize = bytes.readUInt32LE(end + 12);
  const directory = bytes.readUInt32LE(end + 16);
  zipCheck(directorySize >= 46 && directory + directorySize === end, "central directory bounds");
  zipCheck(directory + 46 <= end && bytes.readUInt32LE(directory) === 0x02014b50, "central header");
  const flags = bytes.readUInt16LE(directory + 8);
  const method = bytes.readUInt16LE(directory + 10);
  const checksum = bytes.readUInt32LE(directory + 16);
  const compressed = bytes.readUInt32LE(directory + 20);
  const expanded = bytes.readUInt32LE(directory + 24);
  const nameSize = bytes.readUInt16LE(directory + 28);
  const extraSize = bytes.readUInt16LE(directory + 30);
  const commentSize = bytes.readUInt16LE(directory + 32);
  const attrs = bytes.readUInt32LE(directory + 38);
  const fileType = (attrs >>> 16) & 0xf000;
  zipCheck(bytes.readUInt16LE(directory + 6) <= 20, "unsupported version or ZIP64");
  zipCheck((flags & ~0x080e) === 0, "encrypted or unsupported flags");
  zipCheck(method === 0 || method === 8, "unsupported compression method");
  zipCheck(method === 8 || (flags & 6) === 0, "invalid store flags");
  zipCheck(
    (fileType === 0 || fileType === 0x8000) && (attrs & 0x10) === 0,
    "symlink or non-file member"
  );
  zipCheck(bytes.readUInt16LE(directory + 34) === 0, "disk spanning");
  zipCheck(bytes.readUInt32LE(directory + 42) === 0, "local offset must be zero");
  zipCheck(compressed <= LIMIT && expanded <= LIMIT, "member size limit or ZIP64");
  zipCheck(46 + nameSize + extraSize + commentSize === directorySize, "central entry bounds");
  const filename = Buffer.from(member);
  zipCheck(
    nameSize === filename.length &&
      bytes.subarray(directory + 46, directory + 46 + nameSize).equals(filename),
    "unexpected member name"
  );
  extraFields(bytes, directory + 46 + nameSize, extraSize);

  zipCheck(directory >= 30 && bytes.readUInt32LE(0) === 0x04034b50, "local header");
  zipCheck(bytes.readUInt16LE(4) === bytes.readUInt16LE(directory + 6), "local version mismatch");
  zipCheck(
    bytes.readUInt16LE(6) === flags && bytes.readUInt16LE(8) === method,
    "local flags or method mismatch"
  );
  const localName = bytes.readUInt16LE(26);
  const localExtra = bytes.readUInt16LE(28);
  const dataStart = 30 + localName + localExtra;
  const dataEnd = dataStart + compressed;
  zipCheck(localName === nameSize && dataEnd <= directory, "local member bounds");
  zipCheck(bytes.subarray(30, 30 + localName).equals(filename), "local member name mismatch");
  extraFields(bytes, 30 + localName, localExtra);
  const localCrc = bytes.readUInt32LE(14);
  const localCompressed = bytes.readUInt32LE(18);
  const localExpanded = bytes.readUInt32LE(22);
  if (flags & 8) {
    zipCheck(
      (localCrc === 0 || localCrc === checksum) &&
        (localCompressed === 0 || localCompressed === compressed) &&
        (localExpanded === 0 || localExpanded === expanded),
      "local descriptor fields mismatch"
    );
    const descriptorSize = directory - dataEnd;
    zipCheck(descriptorSize === 12 || descriptorSize === 16, "data descriptor bounds");
    const descriptor = dataEnd + (descriptorSize === 16 ? 4 : 0);
    if (descriptorSize === 16)
      zipCheck(bytes.readUInt32LE(dataEnd) === 0x08074b50, "data descriptor signature");
    zipCheck(
      bytes.readUInt32LE(descriptor) === checksum &&
        bytes.readUInt32LE(descriptor + 4) === compressed &&
        bytes.readUInt32LE(descriptor + 8) === expanded,
      "data descriptor mismatch"
    );
  } else {
    zipCheck(dataEnd === directory, "unexpected records between local and central entry");
    zipCheck(
      localCrc === checksum && localCompressed === compressed && localExpanded === expanded,
      "local CRC or size mismatch"
    );
  }
  const payload = bytes.subarray(dataStart, dataEnd);
  let json;
  if (method === 0) {
    zipCheck(compressed === expanded, "stored size mismatch");
    json = payload;
  } else {
    let result;
    try {
      result = inflateRawSync(payload, { maxOutputLength: LIMIT, info: true });
    } catch {
      throw new Error("Invalid ZIP deflate data or expanded size limit");
    }
    zipCheck(result.engine.bytesWritten === compressed, "trailing deflate data");
    json = result.buffer;
  }
  zipCheck(json.length === expanded, "expanded size mismatch");
  zipCheck(crc32(json) === checksum, "CRC checksum mismatch");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    throw new Error("Invalid archive JSON or UTF-8 encoding");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Archive JSON must be an object");
  return value;
}

function redirectTarget(location) {
  let target;
  try {
    target = new URL(location);
  } catch {
    throw new Error("Invalid artifact redirect");
  }
  if (
    target.protocol !== "https:" ||
    target.port ||
    target.username ||
    target.password ||
    ![".blob.core.windows.net", ".actions.githubusercontent.com"].some((suffix) =>
      target.hostname.endsWith(suffix)
    )
  )
    throw new Error("Unsafe artifact redirect");
  return target;
}

function discard(body) {
  // A hostile/misbehaving transport must not make cancellation block the deadline.
  try {
    Promise.resolve(body?.cancel()).catch(() => {});
  } catch {
    /* best effort */
  }
}

async function downloadJsonArtifact(api, metadata, member = "bundle.json") {
  validMember(member);
  if (
    !Number.isSafeInteger(metadata?.id) ||
    metadata.id <= 0 ||
    !Number.isSafeInteger(metadata?.size_in_bytes) ||
    metadata.size_in_bytes < 1 ||
    metadata.size_in_bytes > LIMIT ||
    typeof metadata?.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/i.test(metadata.digest)
  )
    throw new Error("Invalid artifact metadata id, digest or size");
  if (!api?.token || typeof api.fetch !== "function")
    throw new Error("Artifact API credentials are required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Artifact download timed out")), 30000);
  // Remove the listener after every read; racing each chunk against one pending
  // deadline promise would accumulate handlers for the entire download.
  const within = (promise) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) return abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          controller.signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          controller.signal.removeEventListener("abort", abort);
          reject(error);
        }
      );
    });
  let response;
  let reader;
  let complete = false;
  try {
    response = await within(
      api.fetch(`https://api.github.com${ROOT}/actions/artifacts/${metadata.id}/zip`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${api.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "haide-software-factory",
        },
      })
    );
    if (REDIRECTS.has(response.status)) {
      discard(response.body);
      const target = redirectTarget(response.headers.get("location"));
      // Never copy API headers to the signed storage URL, including Authorization.
      response = await within(
        api.fetch(target, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {},
        })
      );
    }
    if (response.status !== 200)
      throw new Error("Artifact download response must be 200; redirect chains are forbidden");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== metadata.size_in_bytes))
      throw new Error("Artifact download size header mismatch");
    if (!response.body || typeof response.body.getReader !== "function")
      throw new Error("Missing artifact download body");
    reader = response.body.getReader();
    // Preallocate once so tiny/empty stream chunks cannot amplify memory use.
    const bytes = Buffer.allocUnsafe(metadata.size_in_bytes);
    let total = 0;
    while (true) {
      const { done, value } = await within(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid artifact download bytes");
      total += value.byteLength;
      if (total > LIMIT || total > metadata.size_in_bytes)
        throw new Error("Artifact download size limit exceeded");
      bytes.set(value, total - value.byteLength);
    }
    complete = true;
    if (total !== metadata.size_in_bytes) throw new Error("Artifact download size mismatch");
    const actual = createHash("sha256").update(bytes).digest();
    const expected = Buffer.from(metadata.digest.slice(7), "hex");
    if (!timingSafeEqual(actual, expected)) throw new Error("Artifact ZIP digest mismatch");
    return decodeArchive(bytes, member);
  } finally {
    clearTimeout(timer);
    if (!complete) {
      controller.abort();
      if (reader) discard(reader);
      else discard(response?.body);
    }
  }
}

module.exports = { downloadJsonArtifact, decodeArchive };
