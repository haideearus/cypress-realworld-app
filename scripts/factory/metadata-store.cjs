const { ROOT } = require("./github.cjs");
const SHA = /^[a-f0-9]{40}$/;
// Dedicated metadata namespaces. Never aliases the usage, monitor or grant ledger.
class MetadataStore {
  constructor(api, namespace, empty, validate) {
    if (!["wakes", "activity", "discovery", "findings", "dependency-alerts"].includes(namespace))
      throw Error("Invalid metadata namespace");
    Object.assign(this, {
      api,
      branch: `factory/${namespace}`,
      file: `${namespace}.json`,
      empty,
      validate,
    });
  }
  async read() {
    const ref = await this.api.request("GET", `${ROOT}/git/ref/heads/${this.branch}`);
    const commit = ref.object?.sha;
    if (!SHA.test(commit || "")) throw Error("Invalid metadata commit");
    const file = await this.api.request("GET", `${ROOT}/contents/${this.file}?ref=${commit}`);
    if (
      file.type !== "file" ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      file.content.length > 1400000
    )
      throw Error("Invalid metadata file");
    return {
      state: this.validate(JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))),
      commit,
    };
  }
  async save(state, parent) {
    this.validate(state);
    if (parent !== null && !SHA.test(parent || "")) throw Error("Invalid metadata parent");
    const content = JSON.stringify(state, null, 2) + "\n";
    if (Buffer.byteLength(content) > 1000000)
      throw Error("Metadata registry full; owner maintenance required");
    const blob = await this.api.request("POST", `${ROOT}/git/blobs`, {
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });
    const tree = await this.api.request("POST", `${ROOT}/git/trees`, {
      tree: [{ path: this.file, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const c = await this.api.request("POST", `${ROOT}/git/commits`, {
      message: `Record factory ${this.file} metadata`,
      tree: tree.sha,
      parents: parent ? [parent] : [],
    });
    if (!SHA.test(c.sha || "")) throw Error("Invalid metadata write response");
    const saved = parent
      ? await this.api.request("PATCH", `${ROOT}/git/refs/heads/${this.branch}`, {
          sha: c.sha,
          force: false,
        })
      : await this.api.request("POST", `${ROOT}/git/refs`, {
          ref: `refs/heads/${this.branch}`,
          sha: c.sha,
        });
    if (saved.object?.sha !== c.sha) throw Error("Metadata write was not acknowledged");
    return c.sha;
  }
  async initialize() {
    try {
      await this.read();
    } catch (e) {
      if (e.status === 404) return this.save(this.empty(), null);
      throw e;
    }
    throw Error("Metadata already initialized");
  }
  async update(fn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state, commit } = await this.read();
      const result = await fn(state);
      if (!result?.state) throw Error("Metadata mutation must return state");
      try {
        return { ...result, commit: await this.save(result.state, commit) };
      } catch (e) {
        if (![409, 422].includes(e.status) || attempt === 2) throw e;
      }
    }
  }
}
module.exports = { MetadataStore };
