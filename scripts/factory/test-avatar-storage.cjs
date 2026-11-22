const { createServer } = require("node:http");

const host = "127.0.0.1";
const bucket = "factory-avatar-fixture";
const accessKey = "fixture-avatar-key";
const maxBytes = 16384;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const objectPath =
  /^\/factory-avatar-fixture\/avatars\/[A-Za-z0-9_-]{1,64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/;

function signedPut(request) {
  const authorization = request.headers.authorization || "";
  return (
    authorization.startsWith("AWS4-HMAC-SHA256 Credential=" + accessKey + "/") &&
    /, Signature=[a-f0-9]{64}$/.test(authorization)
  );
}

function signedGet(parameters) {
  return (
    parameters.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
    parameters.get("X-Amz-Credential")?.startsWith(accessKey + "/") &&
    /^[a-f0-9]{64}$/.test(parameters.get("X-Amz-Signature") || "") &&
    parameters.get("X-Amz-Expires") === "60"
  );
}

async function receivePng(request) {
  const size = Number(request.headers["content-length"]);
  if (
    request.headers["content-type"] !== "image/png" ||
    !Number.isSafeInteger(size) ||
    size <= pngSignature.length ||
    size > maxBytes
  )
    return;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (bytes.length === size && bytes.subarray(0, pngSignature.length).equals(pngSignature))
    return bytes;
}

async function startAvatarFixture() {
  const objects = new Map();
  let origin;
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 },
    async (request, response) => {
      const fail = (status) => response.writeHead(status).end();
      try {
        const url = new URL(request.url, origin);
        if (url.origin !== origin || request.headers.host !== url.host) return fail(403);
        if (!objectPath.test(url.pathname)) return fail(404);
        if (request.method === "GET") {
          if (!signedGet(url.searchParams)) return fail(403);
          const image = objects.get(url.pathname);
          if (!image) return fail(404);
          return response
            .writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": image.length,
              "Cache-Control": "no-store",
            })
            .end(image);
        }
        if (request.method !== "PUT") return fail(405);
        // This is an offline protocol fixture for the production adapter, not an S3 auth server.
        if (!signedPut(request) || url.search !== "?x-id=PutObject") return fail(403);
        const image = await receivePng(request);
        if (!image) return fail(400);
        if (objects.size >= 4 && !objects.has(url.pathname)) return fail(507);
        objects.set(url.pathname, image);
        response.writeHead(200, { "Content-Length": 0 }).end();
      } catch {
        if (!response.headersSent && !response.destroyed) fail(400);
      }
    }
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      origin = "http://" + host + ":" + server.address().port;
      resolve();
    });
  });
  let closed;
  function close() {
    if (!closed)
      closed = new Promise((resolve, reject) => {
        server.close((error) => {
          objects.clear();
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    return closed;
  }
  return {
    origin,
    env: {
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: "fixture-avatar-secret",
      AWS_REGION: "us-east-1",
      AWS_ENDPOINT_URL_S3: origin,
      AWS_EC2_METADATA_DISABLED: "true",
      AVATAR_BUCKET: bucket,
    },
    close,
  };
}

module.exports = { startAvatarFixture };
