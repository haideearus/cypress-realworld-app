# Implementation plan: automatic pickup and merging

1. Add trusted scheduled authorization, optional strict automatic config/provenance and runtime fields; RED/GREEN security/legacy tests.
2. Add repository-scoped App token composite and optional trusted publisher integration without changing model permissions; credential-boundary tests.
3. Add durable expected-head merge controller and native status refresh/reconciliation; RED/GREEN stale/foreign/duplicate/uncertain tests.
4. Add nonmutating preview, bounded eligible-issue selection and same-run admission/merge coordinator; race and limits tests.
5. Wire five reusable cycles in the new disabled scheduled workflow, document installation and remaining factory stages.
6. Run appropriate complete verification, create one PR under #26 and obtain genuine Claude Pro review before rollout. Leave live flags false.

Parallel ownership: security agent owns policy/controller runtime+admission+security tests; App agent owns token/controller composites and cycle workflow+boundary tests; merge agent owns merge controller+merge tests; parent owns queue coordinator, new entry workflow, docs and integration. No external model runs or production actions during implementation.

Local implementation evidence on 2026-11-13: factory suite 212 passed/one existing Windows symlink skip; app units 53 passed/10 existing skips; types, lint, targeted formatting, all factory actionlint checks and whitespace validation passed. Both model roles produce byte-for-byte unchanged CLI arguments at an unchanged configured turn limit. Security, App boundary, queue, merge scope/lock/uncertain-response and workflow tests were run RED before their changes, then GREEN. A peer review found and regression-tested an additional pending-merge admission race before handoff. Genuine Claude Pro review, App installation, live preview/trial and final enabling remain pending.
