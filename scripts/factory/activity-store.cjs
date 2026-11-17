const { MetadataStore } = require("./metadata-store.cjs");
const { emptyActivity, validateActivity } = require("./activity-contract.cjs");
class ActivityStore extends MetadataStore {
  constructor(api) {
    super(api, "activity", emptyActivity, validateActivity);
  }
}
module.exports = { ActivityStore };
