# ADR-0011: Object storage for evidence payloads

Status: Accepted · 2026-09-24

## Context
Evidence payloads need S3 Object Lock in **COMPLIANCE** mode (ADR-0006). The earlier plan used MinIO for local dev and self-hosted installs, but MinIO's community edition is discontinued: binaries and images stopped in October 2025, the repository was archived in April 2026, and `minio/minio` was removed from Docker Hub on 2026-09-11. We need a replacement, and a repeatable way to prove that any store really enforces COMPLIANCE mode, whether it's ours or a customer's.

## Decision
1. **Production SaaS evidence storage uses the cloud provider's native Object Lock**, never a self-run store: **AWS S3 Object Lock in COMPLIANCE mode** first, then **GCS Bucket Lock** and **Azure immutable blob storage** when those regions/clouds are added. Each gets an `ObjectStore` adapter plus a conformance run of its own before first use.
2. **SeaweedFS is the reference store for local dev, CI, and the self-hosted bundle only** (Apache-2.0, `chrislusf/seaweedfs:4.47`, digest `sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882`).
3. **RustFS 1.0.0 is also supported** for self-hosted, since it passed the same checks. Self-hosted customers may use any S3-compatible store that passes the conformance test. **versitygw 1.8.0 is not supported** (see results).
4. **Conformance is enforced, not assumed.** `infra/objectstore-conformance/conformance.sh` runs:
   - in CI against the compose store on every PR (M0);
   - as a self-hosted **install-time preflight** that customers run against their own storage, where install refuses on failure unless explicitly overridden, and the override is logged as evidence (TRACKING F-39, M11);
   - against each cloud adapter's bucket before it goes live.
5. All storage access goes through the `ObjectStore` interface (put with retention, get, retention status, expire).

## Conformance results (2026-09-24)
Run from `amazon/aws-cli:2.37.1` on a shared Docker network (Docker Desktop 29.8.0, WSL2). 28 required checks cover:
- COMPLIANCE on write
- rejected delete of a locked version, including with `--bypass-governance-retention`
- rejected retention shortening or downgrade to GOVERNANCE
- allowed extension
- overwrites and delete markers never touch the locked version, checked by content hash
- versioning can't be suspended, and a non-empty locked bucket can't be deleted
- default bucket retention
- the lock lifts after expiry

Legal hold is informational only.

| Store | Version / digest | Required checks | Legal hold (info) | Idle memory |
|---|---|---|---|---|
| **SeaweedFS** | 4.47 · `sha256:ce9e796f…6bf882` | **28 / 28** | Enforced | 68 MiB |
| **RustFS** | 1.0.0 · `sha256:8cc98017…58f4d1ff` | **28 / 28** | Enforced | 143 MiB |
| versitygw (posix) | v1.8.0 · `sha256:30292fc2…4b0a2499` | 27 / 28. **Fail:** default bucket retention isn't reported by `GetObjectRetention` for objects written without lock headers. The delete was still rejected, but the retention state is invisible to the API | **Not** enforced | 11 MiB |

We chose SeaweedFS over RustFS for maturity: it has been developed since 2014, while RustFS 1.0.0 was released 2026-09-16. It also uses less memory. Both are Apache-2.0.

## Consequences
- **Self-hosted Object Lock is API-level protection.** It stops PRYSM, and any compromised app credential, from deleting or rewriting evidence through S3. It doesn't stop someone with root access to the storage hosts' filesystems. That residual risk is covered by off-platform anchors (ADR-0006), and the self-hosting guide must say so.
- **The test hasn't been validated against AWS S3 yet** (no AWS account). It must pass against a real S3 COMPLIANCE bucket before the S3 adapter ships. If S3 behaves differently on any check, the check is fixed to match S3's documented semantics.
- The test leaves COMPLIANCE-locked objects that expire after about 1.5 × `LOCK_MINUTES` (default 15 min). It must run against a disposable bucket namespace.

## Alternatives
- **MinIO from source / quay.io leftovers / third-party rebuilds (Chainguard, Minimus):** upstream is archived, so security fixes would depend on a third party or on us. Rejected.
- **versitygw:** smallest footprint, but it failed a required check and doesn't enforce legal hold.
- **Ceph RGW:** full Object Lock support, but far too heavy for dev and small self-hosted installs. Customers who already run Ceph can use it if it passes the preflight.
- **Garage:** no Object Lock support.
