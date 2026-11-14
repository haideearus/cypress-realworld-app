# Secret scanning and direct stop control

Implementation ticket: #39. Owner requested the next harness step after the
course requirement audit. Prepare a draft PR; no live stop/resume, model call,
deployment, protection change or variable change is part of implementation.

## Design and choices

Use Gitleaks CLI 8.30.1 with both archive and executable SHA-256 pins. This avoids
a paid scanning service or licensing a separate action. Scan the tracked source
snapshot in required CI, and trusted staged prompt/output files around model
invocations. Never print raw scanner findings or permit an untrusted ignore file.
Known public synthetic fixtures may have exact, documented exceptions only.

An owner command runs directly from the existing checkout, using existing GitHub
authentication. Default is read-only preview. `--execute` records a durable stop
marker before cancelling agent workflows and setting the three agent switches
false. Current reservation/preflight/publication/merge paths honor the marker
even if workflow variables were snapshotted. Preserve counts, approvals and locks
until cancellation is confirmed. Measure a 55-second deadline and report failure
honestly if GitHub does not stop execution in time. Do not claim a platform SLA.

Explicit owner resume restores the recorded three switches only after confirming
terminal agent runs and no active reservation; it never resets usage or retries.
Monitoring and human-approved deployments are outside the agent stop target.

## Tasks

- [x] Pin/install scanner; add failure-first tests for integrity, secret detection,
      sanitized failures, clean snapshots and narrowly scoped public fixtures.
- [x] Add CI and worker input/output scanning without exposing OAuth credentials
      to scanner processes or running post-model Git inspection for drill collection.
- [x] Add stop marker validation and refusal tests in current policy, worker,
      publication and merge paths; leave legacy ledgers compatible.
- [x] Add dry-run/default direct stop/resume commands, owner checks, cancellation
      deadline, audit and conservative lock cleanup; test fake GitHub transports.
- [x] Run factory tests, real local scanner self-tests, lint/types/actionlint and
      a fresh independent local review. Open draft PR; genuine Claude Pro review and
      timed cloud cancellation demonstration remain explicit later stages.

## Evidence boundaries

The existing 60-second claim is a coursework target. Passing simulated deadlines
does not prove a real model job stopped. The runbook must retain that distinction,
especially after observed GitHub queue/cancellation failures. No existing scanner
can guarantee that arbitrary secrets are always detected; combine provider rules,
custom app-secret patterns, least privilege and redacted logging.
