const { createHash } = require("node:crypto");
const vars = {
  FACTORY_ENABLED: "true",
  FACTORY_MAX_TICKETS_PER_DAY: "2",
  FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "2",
  FACTORY_MAX_REVIEWS_PER_TICKET: "2",
  FACTORY_MAX_AUTOMATIC_RETRIES: "1",
  FACTORY_MAX_CONCURRENT_TICKETS: "1",
  FACTORY_TIMEZONE: "Europe/Bucharest",
  FACTORY_RUN_TIMEOUT_MINUTES: "15",
  FACTORY_MAX_TURNS_PER_RUN: "20",
  FACTORY_APP_URL: "https://haide-software-factory.onrender.com",
};
const head = "a".repeat(40);
const context = {
  repository: "haideearus/cypress-realworld-app",
  actor: "haideearus",
  triggeringActor: "haideearus",
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  runId: "100",
  runAttempt: 1,
  ticket: 10,
  phase: "code",
  slot: "cycle1",
  head,
};
class GitHubFixture {
  constructor() {
    this.head = null;
    this.objects = new Map();
    this.failWrites = false;
    this.calls = [];
    this.sequence = 0;
  }
  object(value) {
    const sha = createHash("sha1")
      .update(`${++this.sequence}:${JSON.stringify(value)}`)
      .digest("hex");
    this.objects.set(sha, value);
    return sha;
  }
  fetch = async (url, options = {}) => {
    const path = new URL(url).pathname.replace("/repos/haideearus/cypress-realworld-app", "");
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    this.calls.push({ url: String(url), method, body });
    const response = (status, data) =>
      new Response(data === null ? null : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (this.failWrites && method !== "GET")
      return response(503, { message: "private fixture failure" });
    if (method === "GET" && path === "/git/ref/heads/factory/state")
      return this.head
        ? response(200, {
            ref: "refs/heads/factory/state",
            object: { sha: this.head, type: "commit" },
          })
        : response(404, { message: "Not Found" });
    if (method === "GET" && path === "/contents/state.json") {
      const ref = new URL(url).searchParams.get("ref");
      const commit = this.objects.get(ref);
      const tree = commit && this.objects.get(commit.tree);
      const entry = tree?.tree.find((x) => x.path === "state.json");
      const blob = entry && this.objects.get(entry.sha);
      return blob
        ? response(200, {
            type: "file",
            path: "state.json",
            sha: entry.sha,
            encoding: "base64",
            content: blob.content,
          })
        : response(404, { message: "Not Found" });
    }
    if (method === "POST" && ["/git/blobs", "/git/trees", "/git/commits"].includes(path))
      return response(201, { sha: this.object(body) });
    if (method === "POST" && path === "/git/refs") {
      if (this.head) return response(422, { message: "Reference already exists" });
      this.head = body.sha;
      return response(201, { ref: body.ref, object: { sha: this.head } });
    }
    if (method === "PATCH" && path === "/git/refs/heads/factory/state") {
      const commit = this.objects.get(body.sha);
      if (body.force !== false || !commit?.parents.includes(this.head))
        return response(422, { message: "Not a fast forward" });
      this.head = body.sha;
      return response(200, { ref: "refs/heads/factory/state", object: { sha: this.head } });
    }
    return response(404, { message: `Unsupported fixture route ${method} ${path}` });
  };
}
class FactoryFixture extends GitHubFixture {
  constructor() {
    super();
    this.branchHeads = new Map([["main", head]]);
    this.prs = [];
    this.runs = [];
    this.checks = [];
    this.objects.set(head, { tree: "b".repeat(40), parents: [] });
    this.issues = new Map([
      [10, { number: 10, title: "Repair demo", body: "Fix the testable bug", state: "open" }],
    ]);
    this.ciConclusion = "success";
    this.prHeadOverride = null;
    this.activeRunStatus = "completed";
    const ledgerFetch = this.fetch;
    this.fetch = async (url, options = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace("/repos/haideearus/cypress-realworld-app", "");
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : null;
      const respond = (status, data) =>
        new Response(data === null ? null : JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      const prData = (p) => ({
        ...p,
        head: {
          ref: p.branch,
          sha: this.prHeadOverride || this.branchHeads.get(p.branch),
          repo: { full_name: "haideearus/cypress-realworld-app" },
        },
        base: { ref: "main", sha: head },
      });
      if (method === "GET" && path.startsWith("/issues/"))
        return respond(200, this.issues.get(Number(path.split("/")[2])) || { state: "closed" });
      if (method === "GET" && path === "/branches/main")
        return respond(200, { name: "main", commit: { sha: head }, protected: true });
      if (method === "GET" && path.startsWith("/git/commits/"))
        return respond(
          200,
          this.objects.get(path.split("/").at(-1)) || { tree: { sha: "b".repeat(40) } }
        );
      if (method === "GET" && path.startsWith("/git/ref/heads/agent/")) {
        const branch = path.slice("/git/ref/heads/".length);
        const sha = this.branchHeads.get(branch);
        return sha ? respond(200, { object: { sha } }) : respond(404, { message: "Not Found" });
      }
      if (method === "POST" && path === "/git/refs" && body.ref.startsWith("refs/heads/agent/")) {
        const branch = body.ref.slice("refs/heads/".length);
        if (this.branchHeads.has(branch)) return respond(422, {});
        this.branchHeads.set(branch, body.sha);
        return respond(201, { object: { sha: body.sha } });
      }
      if (method === "PATCH" && path.startsWith("/git/refs/heads/agent/")) {
        const branch = path.slice("/git/refs/heads/".length);
        const commit = this.objects.get(body.sha);
        if (body.force !== false || !commit?.parents.includes(this.branchHeads.get(branch)))
          return respond(422, {});
        this.branchHeads.set(branch, body.sha);
        return respond(200, { object: { sha: body.sha } });
      }
      if (method === "POST" && path === "/pulls") {
        const p = { number: 20 + this.prs.length, branch: body.head, state: "open", draft: false };
        this.prs.push(p);
        return respond(201, prData(p));
      }
      if (method === "GET" && path === "/pulls") return respond(200, this.prs.map(prData));
      if (method === "GET" && /^\/pulls\/\d+$/.test(path))
        return respond(200, prData(this.prs.find((p) => p.number === Number(path.split("/")[2]))));
      if (method === "POST" && path === "/actions/workflows/factory-ci.yml/dispatches") {
        this.runs.push({
          id: 501 + this.runs.length,
          name: "Factory CI",
          path: ".github/workflows/factory-ci.yml",
          event: "workflow_dispatch",
          head_sha: this.branchHeads.get(body.ref),
          head_branch: body.ref,
          status: "completed",
          conclusion: this.ciConclusion,
        });
        return respond(204, null);
      }
      if (method === "GET" && path === "/actions/workflows/factory-ci.yml/runs")
        return respond(200, { workflow_runs: this.runs });
      if (method === "GET" && /^\/actions\/runs\/\d+\/jobs$/.test(path))
        return respond(200, {
          jobs: [{ name: "verify", status: "completed", conclusion: this.ciConclusion }],
        });
      if (method === "GET" && /^\/actions\/runs\/\d+\/attempts\/\d+$/.test(path))
        return respond(200, { status: this.activeRunStatus });
      if (method === "GET" && /^\/actions\/runs\/\d+$/.test(path))
        return respond(
          200,
          this.runs.find((r) => r.id === Number(path.split("/")[3])) || {
            status: this.activeRunStatus,
          }
        );
      if (method === "POST" && /^\/actions\/runs\/\d+\/cancel$/.test(path)) {
        this.activeRunStatus = "completed";
        return respond(202, {});
      }
      if (method === "POST" && path === "/check-runs") {
        this.checks.push(body);
        return respond(201, { id: this.checks.length, ...body });
      }
      return ledgerFetch(url, options);
    };
  }
}
module.exports = { vars, head, context, GitHubFixture, FactoryFixture };
