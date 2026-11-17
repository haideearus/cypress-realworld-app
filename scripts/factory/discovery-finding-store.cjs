const { MetadataStore } = require("./metadata-store.cjs");
const c = require("./discovery-finding-contract.cjs");
class FindingStore extends MetadataStore {
  constructor(api) {
    super(api, "findings", c.emptyFindings, c.validateFindings);
  }
}
module.exports = { FindingStore };
