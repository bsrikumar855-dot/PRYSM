# Object Lock conformance test

This checks that an S3-compatible store enforces **COMPLIANCE-mode Object Lock** the way PRYSM's evidence vault needs (ADR-0006, ADR-0011). It exits `0` only if every required check passes.

Run it against any endpoint with Docker only:

```sh
docker run --rm --network <network-with-your-store> \
  -v "$PWD/infra/objectstore-conformance:/c:ro" \
  -e S3_ENDPOINT=http://<host>:<port> -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... \
  --entrypoint bash amazon/aws-cli:2.37.1 /c/conformance.sh
```

Optional: `AWS_REGION` (default `us-east-1`), `LOCK_MINUTES` (default 10), `EXPIRY_SECONDS` (default 20).

**It leaves COMPLIANCE-locked test objects** in a new `prysm-olock-*` bucket. They become deletable after about 1.5 × `LOCK_MINUTES`, so point it at a disposable store or a bucket namespace you can clean up later.

`candidates.compose.yml` starts the stores evaluated for ADR-0011 (local evaluation only).
