// These are public proof digests, not credentials. Derive identifiers rather
// than embedding high-entropy literals in fields named `key` in scanned JSON.
const c = require("../../factory/discovery-contract.cjs");
const fixture = require("./finding96-blocked.json");
const candidate = fixture.record.candidate;
const source = candidate.source;
const key = c.digest([source.grantId, candidate.findingHash]);
// Receipt digests preserve JSON member order as well as values.
const insertKey = (value, after, digest) =>
  Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) =>
      name === after
        ? [
            [name, item],
            ["key", digest],
          ]
        : [[name, item]]
    )
  );
candidate.source = insertKey(
  source,
  "ciRunId",
  c.sweepKey(source.head, source.charter, source.day)
);
fixture.record.candidate = { key, ...candidate };
fixture.ticket.finding.origin = insertKey(fixture.ticket.finding.origin, "version", key);
fixture.ticket.finding.intake = insertKey(fixture.ticket.finding.intake, "id", key);
fixture.record.intake = insertKey(fixture.record.intake, "id", key);
module.exports = fixture;
