const { MetadataStore } = require("./metadata-store.cjs");
const { emptyDiscovery, validateDiscovery } = require("./discovery-contract.cjs");
class DiscoveryStore extends MetadataStore {
  constructor(api) {
    super(api, "discovery", emptyDiscovery, validateDiscovery);
  }
}
module.exports = { DiscoveryStore };
