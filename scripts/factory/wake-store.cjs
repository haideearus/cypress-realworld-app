const { MetadataStore } = require("./metadata-store.cjs");
const { emptyWakes, validateWakes } = require("./wake-contract.cjs");
class WakeStore extends MetadataStore {
  constructor(api) {
    super(api, "wakes", emptyWakes, validateWakes);
  }
}
module.exports = { WakeStore };
