# Upstream workflow reference

The original Cypress workflows are preserved here for attribution and comparison.
GitHub runs only files directly under `.github/workflows`. These originals depend
on upstream project boards, cloud recording secrets, or branches that this fork
does not maintain. Ticket #2 replaces their execution with `factory-ci.yml`, one
read-only verification job with a disposable PostgreSQL service and no paid API.

Required branch checks and production environment approvals must still be
configured separately. A workflow file alone does not enforce either policy.
