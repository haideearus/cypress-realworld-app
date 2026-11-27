# Factory reliability implementation plan

**Goal** Recover the verified work for #299 and make subsequent holds visible without consuming the worker indefinitely. Tracking issue #311 records the acceptance criteria.

- [ ] Add an old-event regression for the required `Factory review gate`. Resolve trusted `main` at execution, verify the same repository and exact PR head, and preserve the native GitHub check and issuer. Test invalid and unreadable ledgers as well as old valid receipts.
- [ ] Reuse the dependency merge-only path for one eligible saved review after a verified controller upgrade. Check the current dependency evidence and base before claiming the retry. When an old workflow needs a fresh PR event, verify the resulting native run before creating a merge intent. Exercise the #299 hold, duplicate claims, candidate drift, and a lost response.
- [ ] Reconcile bounded retained wakes with trusted origin and receiver evidence. Test missed delivery, an occupied or stopped worker, an unresolved merge intent, and an uncertain dispatch. Keep dispatch and recovery model-free unless the next eligible ticket requires its normal work.
- [ ] Publish an update to the verified tracking issue for a persistent hold and consolidate recurring shared faults. Test duplicate requests, stale evidence, transient failures, and an unavailable ledger. Keep the worker state independent from reporting.
- [ ] Compact existing ledger writes, preserve meaning and limits, and warn before the byte ceiling. Test that the serialized ledger round-trips and that the hard cap and non-force ref update still protect writes.
- [ ] Run the regression suite without model calls, verify the protected checks and deployment approval are intact, and open one draft PR.
