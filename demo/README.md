# demo/ (DEMO-ONLY)

The Meta Global AI Developer Hackathon slice of PRYSM. Everything here is **DEMO-ONLY**: it is built to show the
idea in two days, single-tenant, with synthetic data. It is not part of the product build and nothing in
`apps/` or `packages/` depends on it yet. Shortcuts carry a `DEMO-ONLY` label in the code and a `TODO(T-###)`
entry in `docs/TRACKING.md` §4.

Principles that still hold: a model never makes the final decision (code and humans do), rules cite only the
IDs and sources the operator supplies in the policy file, wording is "control status" and "evidence of", no
secrets in git, and no PII or keys in logs.
