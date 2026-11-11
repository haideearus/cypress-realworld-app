# Neon PostgreSQL and Object Storage

The user supplied the exact Neon organization/project/production branch and
requested CLI initialization, service deployment, application wiring, an npm
build, and end-to-end proof for both services. This extends the existing
production preparation; it does not change the zero-additional-spend constraint.

Use `org-summer-mouse-60284532` / `purple-flower-40328107`, branch `production`.
Keep the existing `pg` pool and PostgreSQL state/session implementation for the
long-running Express runtime. Consult the installed Neon skills before changing
driver or storage configuration. Provision only Postgres and a private object
storage bucket; no auth replacement, AI gateway, functions, or paid upgrades.

The implementation choice for real object-storage use is profile-picture
uploads, building on the existing user avatar field. Credentials remain on the
server. Uploads are authenticated, bounded images; storage operations never
mutate lowdb state after awaiting remote I/O. The UI saves the returned avatar
URL in a separate synchronous user update. New uploads use unique keys so a
failed profile save cannot silently replace the previous picture. Downloads are
authenticated. A temporary live test object may be deleted after verification;
existing cloud data is not reset or removed.

Neon CLI writes managed variables to `.env` when it exists. Preserve the tracked
upstream defaults and move generated private values to ignored `.env.local`.
The app must load `.env.local` before defaults, while explicit process variables
retain precedence. No secrets may enter browser code, commits, logs, or reports.

Use the CLI's generated config and dependencies, preserving the repository's
Yarn lockfile/package manager. Pin added package versions after resolving them.
`npm run build` is explicitly required, plus the full production artifact and
local regression checks appropriate to modified behavior. The live proof must
exercise a real Neon-backed app, persist a synthetic change across restart,
upload/read image bytes from the declared bucket, and report actual outcomes.

`neon deploy` provisions backend services. The public website host is still a
separate deployment step and must not be claimed complete from Neon provisioning.
