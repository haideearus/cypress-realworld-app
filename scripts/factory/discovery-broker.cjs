const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const c = require("./discovery-contract.cjs");
const s = require("./discovery-sandbox.cjs");
const e = require("./discovery-evidence.cjs");
const functional = require("./discovery-functional.cjs");
const { secretLike } = require("./artifacts.cjs");
function plain(text, max = 50000) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > max ||
    text.includes("\0") ||
    secretLike(text)
  )
    throw Error("Invalid bounded discovery text");
  return text;
}
function createBroker({ root, source, output, manifest, identity, charter, execute }) {
  functional.assertCharter(charter);
  const sourceFiles = Object.keys(manifest).filter((name) =>
    functional.sourceAllowed(charter, name)
  );
  fs.mkdirSync(path.join(output, "tests"), { recursive: true });
  const budget = new s.BatchBudget(async (request, number) => {
    const test = fs.readFileSync(s.regularProposal(output, "tests/" + request.file), "utf8");
    functional.verifyProposal(charter, test);
    // Reserve durably before execution. Restarts and concurrent broker instances
    // cannot refund an interrupted batch or execute beyond the four retained slots.
    let slot = null;
    for (let n = 1; n <= 4; n++) {
      try {
        fs.writeFileSync(
          path.join(root, `batch-intent-${n}.json`),
          JSON.stringify({ number: n, ...request, testHash: c.digest(test) }),
          { flag: "wx", mode: 0o600 }
        );
        slot = n;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (slot === null) throw Error("Discovery batch limit reached");
    number = slot;
    const result = await execute(request);
    const receipt = { number, ...request, test, testHash: c.digest(test), result };
    fs.writeFileSync(path.join(root, `batch-${number}.json`), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    return { number, ...result };
  });
  return {
    async call(tool, input) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Error("Invalid tool input");
      if (tool === "list_source") {
        c.exact(input, ["prefix"]);
        plain(input.prefix, 200);
        if (input.prefix.includes("..") || input.prefix.startsWith("/"))
          throw Error("Invalid source prefix");
        return {
          files: sourceFiles.filter((n) => n.startsWith(input.prefix)),
        };
      }
      if (tool === "read_source") {
        c.exact(input, ["path"]);
        if (!sourceFiles.includes(input.path)) throw Error("Source path outside the charter");
        const file = path.join(source, ...input.path.split("/"));
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 2000000)
          throw Error("Invalid source file");
        const text = fs.readFileSync(file, "utf8");
        if (c.digest(text) !== manifest[input.path]) throw Error("Source changed");
        return { text: plain(text.slice(0, 50000)), truncated: text.length > 50000 };
      }
      if (tool === "write_test") {
        c.exact(input, ["file", "oracle"]);
        s.validateRequest({ file: input.file, mode: "api" });
        const content = functional.proposal(charter, input.oracle);
        if (
          fs.readdirSync(path.join(output, "tests")).length >= 8 &&
          !fs.existsSync(path.join(output, "tests", input.file))
        )
          throw Error("Proposal count exceeded");
        const target = path.join(output, "tests", input.file);
        try {
          fs.writeFileSync(target, content, { flag: "wx", mode: 0o644 });
        } catch (error) {
          if (
            error.code !== "EEXIST" ||
            fs.readFileSync(s.regularProposal(output, "tests/" + input.file), "utf8") !== content
          )
            throw error;
        }
        return { saved: input.file };
      }
      if (tool === "run_batch") {
        s.validateRequest(input);
        if (input.mode !== "api") throw Error("Functional discovery uses fixed API proposals");
        s.regularProposal(output, "tests/" + input.file);
        return budget.run(input);
      }
      if (tool === "read_result") {
        c.exact(input, ["number"]);
        if (!Number.isInteger(input.number) || input.number < 1 || input.number > 4)
          throw Error("Invalid batch result");
        return JSON.parse(fs.readFileSync(path.join(root, `batch-${input.number}.json`), "utf8"));
      }
      if (tool === "write_report") {
        e.validateCandidateReport(input, identity);
        const report = {
          ...input,
          findings: input.findings.map((finding) => functional.describeFinding(charter, finding)),
        };
        fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report), { mode: 0o644 });
        return { saved: "report.json" };
      }
      throw Error("Unknown discovery tool");
    },
  };
}
const props = {
  path: { type: "string" },
  prefix: { type: "string" },
  file: { type: "string" },
  oracle: {
    type: "object",
    properties: {
      kind: { enum: ["feed-pagination", "unexpected-server-error", "notification-list"] },
      route: { enum: ["/transactions/public", "/users/search", "/notifications"] },
      authenticated: { const: true },
      query: { type: "object" },
    },
    required: ["kind", "route", "authenticated", "query"],
    additionalProperties: false,
  },
  number: { type: "integer" },
  mode: { const: "api" },
};
const schemas = {
  list_source: ["prefix"],
  read_source: ["path"],
  write_test: ["file", "oracle"],
  run_batch: ["mode", "file"],
  read_result: ["number"],
};
function tools() {
  return [
    ...Object.entries(schemas).map(([name, keys]) => ({
      name,
      description: `Bounded discovery operation: ${name}`,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, props[k]])),
        required: keys,
        additionalProperties: false,
      },
    })),
    {
      name: "write_report",
      description:
        "Save candidate report with the exact executed functional scenario for every finding. The broker supplies the finding title and summary. This never publishes an issue.",
      inputSchema: {
        type: "object",
        properties: {
          version: { const: 1 },
          head: { type: "string" },
          grantId: { type: "string" },
          checked: { type: "array", items: { type: "string" } },
          skipped: { type: "array", items: { type: "string" } },
          findings: { type: "array", maxItems: 2, items: { type: "object" } },
        },
        required: ["version", "head", "grantId", "checked", "skipped", "findings"],
        additionalProperties: false,
      },
    },
  ];
}
async function serve() {
  const root = process.argv[2];
  const pin = process.argv[3];
  if (!root || c.digest(fs.readFileSync(__filename, "utf8")) !== pin)
    throw Error("Trusted broker checksum mismatch");
  // No provider/GitHub/deployment/database/proxy credential survives into tools.
  for (const key of Object.keys(process.env))
    if (!["PATH", "SystemRoot", "WINDIR"].includes(key)) delete process.env[key];
  const setup = JSON.parse(fs.readFileSync(path.join(root, "setup.json"), "utf8"));
  for (const [file, hash] of Object.entries(setup.helperHashes))
    if (c.digest(fs.readFileSync(path.join(__dirname, file), "utf8")) !== hash)
      throw Error("Trusted helper changed");
  const broker = createBroker({
    ...setup,
    root,
    execute: (request) =>
      s.sandbox({ image: setup.image, request, tests: path.join(setup.output, "tests") }),
  });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 100000) throw Error("Oversized MCP request");
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.id === undefined) continue;
    try {
      let result;
      if (r.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "factory-discovery", version: "1.0.0" },
        };
      else if (r.method === "ping") result = {};
      else if (r.method === "tools/list") result = { tools: tools() };
      else if (r.method === "tools/call")
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify(await broker.call(r.params.name, r.params.arguments || {})),
            },
          ],
        };
      else throw Error("Unsupported MCP method");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n");
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: r.id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "Discovery request rejected or held; use only the bounded contract.",
              },
            ],
          },
        }) + "\n"
      );
    }
  }
}
if (require.main === module)
  serve().catch(() => {
    process.stderr.write("Discovery broker failed closed.\n");
    process.exitCode = 1;
  });
module.exports = { createBroker, tools };
