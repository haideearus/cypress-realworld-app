const { MetadataStore } = require("./metadata-store.cjs");
const { ROOT } = require("./github.cjs");
const { HASH, SHA, exact } = require("./wake-contract.cjs");
const { emptyActivity, validateActivity } = require("./activity-contract.cjs");

const receiptPath = (id) => `published/${id.slice(0, 2)}/${id}.json`;

class ActivityStore extends MetadataStore {
  constructor(api) {
    super(api, "activity", emptyActivity, validateActivity);
  }

  async published(commit, id) {
    if (!SHA.test(commit || "") || !HASH.test(id || ""))
      throw Error("Invalid archived activity lookup");
    let file;
    try {
      file = await this.api.request("GET", `${ROOT}/contents/${receiptPath(id)}?ref=${commit}`);
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    if (
      file.type !== "file" ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      file.content.length > 256
    )
      throw Error("Invalid archived activity file");
    const receipt = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    if (
      !exact(receipt, "id,commentId") ||
      receipt.id !== id ||
      !Number.isSafeInteger(receipt.commentId) ||
      receipt.commentId < 1
    )
      throw Error("Invalid archived activity receipt");
    return { status: "published", commentId: receipt.commentId };
  }

  async save(state, parent) {
    const active = {};
    const published = {};
    for (const [id, receipt] of Object.entries(state.events)) {
      const target = receipt.status === "published" ? published : active;
      target[id] = receipt;
    }
    validateActivity({ ...state, events: published });
    // Keep each published identity available without loading the entire archive. Full events
    // remain in the original Git history and their acknowledged journal comments.
    const archive = Object.entries(published).map(([id, { commentId }]) => ({
      path: receiptPath(id),
      mode: "100644",
      type: "blob",
      content: JSON.stringify({ id, commentId }) + "\n",
    }));
    return super.save({ ...state, version: 2, events: active }, parent, archive);
  }
}

module.exports = { ActivityStore };
