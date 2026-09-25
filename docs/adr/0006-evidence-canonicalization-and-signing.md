# ADR-0006: Evidence canonicalization, chaining and signing

Status: Accepted · 2026-09-24

## Context

Evidence must be append-only, tamper-evident, verifiable offline by a third party, and able to survive payload expiry and crypto-shredding. A hash chain held only by PRYSM doesn't stop PRYSM itself, or an attacker holding both the DB and the signing key, from rewriting history. Anchors therefore have to leave our control.

## Decision

### Record

```
EvidenceEnvelope {
  v: 1, tenant_id, seq (uint64, gapless per tenant), prev_hash (hex),
  record_type, occurred_at, recorded_at (RFC 3339 UTC, ms),
  subject: { application_id?, asset_id?, control_id?, policy_hash?, evaluation_id?, finding_id? },
  payload_hash (hex|null), payload_ref (object key|null), retention_mode: full|redacted|metadata,
  meta (small JSON, no sensitive data)
}
record_hash = SHA-256( "prysm.evidence.v1\n" || JCS(envelope) )     // RFC 8785
payload_hash = SHA-256( "prysm.payload.v1\n" || JCS(payload) )      // payload includes a 128-bit random `nonce`
genesis prev_hash = SHA-256( "prysm.genesis.v1\n" || tenant_id )
```

- The `nonce` inside the payload stops anyone from brute-forcing low-entropy content (a PAN, an Aadhaar number) out of `payload_hash`.
- `payload_hash` covers the **plaintext** canonical payload. The stored object is encrypted with the tenant DEK (AES-256-GCM). Audit packs include the decrypted in-scope payloads so they can be verified offline. Deleting a tenant's DEK (crypto-shredding at offboarding) leaves the chain verifiable while the content is unreadable.

### Append

There is a single writer per tenant (ADR-0004 shards). Each batch runs in one transaction: `SELECT … FROM evidence_chain_head WHERE tenant_id=$1 FOR UPDATE`, compute the hashes in memory, bulk insert, update the head. `UNIQUE(tenant_id, seq)` and `UNIQUE(tenant_id, prev_hash)` are hard backstops against forks.

### Anchors

Anchoring happens per tenant, every 10 minutes or every 10,000 records, whichever comes first, and only if there are new records.

- The Merkle tree over `record_hash[from_seq..to_seq]` follows the RFC 6962 construction: leaf = `H(0x00 ‖ x)`, node = `H(0x01 ‖ l ‖ r)`.
- `AnchorBody { tenant_id, from_seq, to_seq, chain_head, merkle_root, prev_anchor_hash, created_at, key_id }` → JCS → **Ed25519** signature.
- Signing keys are per region and live in KMS where the provider supports Ed25519. Otherwise the key is wrapped by KMS and used only inside the anchoring worker. Rotation is documented in a runbook, and old public keys stay published.
- **Off-platform delivery:** every anchor is pushed to at least one destination outside the primary platform's control. The options are a customer webhook, a customer-owned S3 bucket, or email digests. **At least one destination is mandatory for production tenants.** To keep onboarding unblocked, PRYSM provides a managed default: an Object Lock (COMPLIANCE) bucket in a **separate cloud account** with separate credentials, write-only from the anchoring worker. Customers can add their own destinations. The managed default protects against a compromised primary platform, but not against a PRYSM-wide insider, so the console encourages adding a customer-owned destination.
- **Public transparency log (optional, per tenant):** an `AnchorDestination` implementation for **Sigstore Rekor**, using the current Rekor API at implementation time. Only an opaque entry is published: the SHA-256 of `JCS(AnchorBody)` plus its Ed25519 signature by the region key, as a hashed-record entry. `tenant_id`, sequence ranges and record counts are **never** published. Public logs are permanent and world-readable, so the entry must reveal nothing beyond "PRYSM region X signed some digest at time T". The returned inclusion proof, checkpoint and entry timestamp are stored with the anchor and included in audit packs. The verifier checks them offline against a pinned Rekor log public key. This makes rewriting history detectable without trusting either PRYSM or the customer's own storage. Anchors still also go to the mandatory destination. Rekor is an external service, and the adapter ships in M11 alongside the TSA (TRACKING E-13). The `AnchorDestination` interface itself ships in M2.
- **Timestamping:** M2 ships a `TimestampAuthority` adapter interface. The anchor schema and verifier already handle optional `tsr/` tokens. The real RFC 3161 integration (choice of TSA, an external service) is deferred to M11 (TRACKING E-04).

### Storage and immutability

- Payload objects go to `tenants/{tenant_id}/evidence/{yyyy}/{mm}/{payload_hash}` with **Object Lock COMPLIANCE**, retention = the tenant's policy at write time.
- Postgres: `prysm_app` gets `INSERT, SELECT` only on `evidence_records` and `evidence_anchors`. A `BEFORE UPDATE OR DELETE` trigger raises an exception unless the role is `prysm_platform` _and_ the operation is retention expiry, which may only null out `payload_ref`. Rows are never deleted.
- **Retention expiry** is a worker job. It removes expired payload objects after the lock lapses, sets `payload_ref = null`, and appends a `retention.expired` record listing the affected `payload_hash`es.

### Verifier

`apps/verifier-cli` is written in **Go** as a static binary with no network access. Input is an audit pack: `manifest.json`, `records.jsonl`, `anchors.jsonl`, `payloads/`, `keys/`, and optionally `tsr/`. It checks JCS and hashes, chain continuity, Merkle inclusion and roots, Ed25519 signatures against pinned keys, RFC 3161 tokens, Rekor inclusion proofs (when present), and that every payload's hash matches. Output is human-readable plus `--json`, and a non-zero exit on any failure.

**Why Go:** auditors get a single dependency-free binary, and a second, independent implementation of canonicalization and hashing catches bugs the TS writer and a TS verifier would share. Shared test vectors (`packages/evidence/test-vectors/`, including mutation cases) must pass in both implementations in CI.

## Consequences

- Adds a third language, confined to about 1–2k lines.
- JCS number handling is subtle. Payloads avoid non-integer numbers where possible (amounts as strings), and the test vectors cover edge cases.

## Alternatives

- **Per-batch Merkle blocks without record-level chaining:** better write scalability, but the brief asks for a per-tenant hash chain, and the single-writer design handles the target load.
- **Transparency log as the _only_ anchor target:** rejected. Rekor is adopted as an optional _additional_ destination (above), not a replacement for customer-held or managed destinations.
- **ECDSA P-256:** broader KMS support, but non-deterministic signatures, and Ed25519 is simpler to verify offline.
