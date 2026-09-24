#!/usr/bin/env bash
# S3 Object Lock COMPLIANCE-mode conformance test for PRYSM evidence storage (ADR-0006, ADR-0011).
#
# Needs: bash, AWS CLI v2, GNU date, sha256sum. Easiest: run inside the amazon/aws-cli image (see README.md).
#   S3_ENDPOINT=http://host:port AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./conformance.sh
# Optional: AWS_REGION (default us-east-1), LOCK_MINUTES (default 10), EXPIRY_SECONDS (default 20).
#
# It creates one new bucket and leaves COMPLIANCE-locked objects behind that become deletable after
# about 1.5 x LOCK_MINUTES. Run it against a disposable store or bucket namespace.
# Exit code 0 only if every REQUIRED check passes. INFO checks are reported but don't affect the result.
set -uo pipefail

EP=${S3_ENDPOINT:?set S3_ENDPOINT}
export AWS_REGION=${AWS_REGION:-us-east-1} AWS_PAGER=""
LOCK_MINUTES=${LOCK_MINUTES:-10}
EXPIRY_SECONDS=${EXPIRY_SECONDS:-20}
B="prysm-olock-$(date +%s)-$RANDOM"
TMP=$(mktemp -d)
pass=0 fail=0

s3() { aws --endpoint-url "$EP" s3api "$@" 2>&1; }
iso() { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }
epoch() { date -u -d "$1" +%s; }
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
ko() { echo "FAIL  $1 -- ${2//$'\n'/ }"; fail=$((fail + 1)); }
info() { echo "INFO  $1"; }

# must_succeed NAME CMD... : the call must succeed.
must_succeed() { local n=$1 out; shift; if out=$(s3 "$@"); then ok "$n"; else ko "$n" "$out"; fi; }
# must_fail NAME CMD... : the call must be rejected.
must_fail() { local n=$1 out; shift; if out=$(s3 "$@"); then ko "$n" "accepted, but must be rejected"; else ok "$n"; fi; }
# intact NAME KEY VERSION SHA : that version must still exist with identical content.
intact() {
  local n=$1 k=$2 v=$3 want=$4 out got
  if out=$(s3 get-object --bucket "$B" --key "$k" --version-id "$v" "$TMP/get"); then
    got=$(sha256sum "$TMP/get" | cut -d' ' -f1)
    [[ $got == "$want" ]] && ok "$n" || ko "$n" "content changed ($got != $want)"
  else ko "$n" "version no longer readable: $out"; fi
}
retention_of() { s3 get-object-retention --bucket "$B" --key "$1" --version-id "$2" --query 'Retention.[Mode,RetainUntilDate]' --output text; }
put() { # put KEY CONTENT [extra args...] -> prints VersionId
  local k=$1 c=$2; shift 2
  printf '%s' "$c" > "$TMP/body"
  s3 put-object --bucket "$B" --key "$k" --body "$TMP/body" --query VersionId --output text "$@"
}
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

UNTIL=$(iso "+${LOCK_MINUTES} minutes")
SHORTER=$(iso "+$((LOCK_MINUTES / 2)) minutes")
LONGER=$(iso "+$((LOCK_MINUTES * 3 / 2)) minutes")
echo "endpoint=$EP bucket=$B lock_until=$UNTIL"

# 1. Bucket with Object Lock
must_succeed "create bucket with object lock enabled" create-bucket --bucket "$B" --object-lock-enabled-for-bucket
[[ $(s3 get-object-lock-configuration --bucket "$B" --query ObjectLockConfiguration.ObjectLockEnabled --output text) == Enabled ]] \
  && ok "object lock reported Enabled" || ko "object lock reported Enabled" "get-object-lock-configuration did not return Enabled"
[[ $(s3 get-bucket-versioning --bucket "$B" --query Status --output text) == Enabled ]] \
  && ok "versioning enabled automatically" || ko "versioning enabled automatically" "get-bucket-versioning is not Enabled"

# 2. COMPLIANCE retention on write
C1="evidence-payload-v1-$RANDOM"
V1=$(put ev.json "$C1" --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$UNTIL")
[[ -n $V1 && $V1 != None && $V1 != null ]] && ok "put with COMPLIANCE retention returns a version id" \
  || ko "put with COMPLIANCE retention returns a version id" "$V1"
read -r mode until_ret <<<"$(retention_of ev.json "$V1")"
[[ $mode == COMPLIANCE ]] && ok "retention mode is COMPLIANCE" || ko "retention mode is COMPLIANCE" "got '$mode'"
[[ -n ${until_ret:-} && $(epoch "$until_ret") -eq $(epoch "$UNTIL") ]] && ok "retain-until date stored exactly" \
  || ko "retain-until date stored exactly" "got '${until_ret:-}' want '$UNTIL'"

# 3. No deletion or shortening, not even with the governance bypass
must_fail "delete locked version" delete-object --bucket "$B" --key ev.json --version-id "$V1"
intact "locked version intact after delete attempt" ev.json "$V1" "$(sha "$C1")"
must_fail "delete locked version with --bypass-governance-retention" delete-object --bucket "$B" --key ev.json --version-id "$V1" --bypass-governance-retention
intact "locked version intact after bypass attempt" ev.json "$V1" "$(sha "$C1")"
must_fail "shorten COMPLIANCE retention" put-object-retention --bucket "$B" --key ev.json --version-id "$V1" \
  --retention "{\"Mode\":\"COMPLIANCE\",\"RetainUntilDate\":\"$SHORTER\"}"
must_fail "shorten COMPLIANCE retention with bypass" put-object-retention --bucket "$B" --key ev.json --version-id "$V1" \
  --bypass-governance-retention --retention "{\"Mode\":\"COMPLIANCE\",\"RetainUntilDate\":\"$SHORTER\"}"
must_fail "downgrade COMPLIANCE to GOVERNANCE" put-object-retention --bucket "$B" --key ev.json --version-id "$V1" \
  --retention "{\"Mode\":\"GOVERNANCE\",\"RetainUntilDate\":\"$UNTIL\"}"
read -r mode until_ret <<<"$(retention_of ev.json "$V1")"
[[ $mode == COMPLIANCE && $(epoch "${until_ret:-1970-01-01}") -eq $(epoch "$UNTIL") ]] && ok "retention unchanged after rejected changes" \
  || ko "retention unchanged after rejected changes" "now '$mode' '${until_ret:-}'"

# 4. Extending is allowed
must_succeed "extend COMPLIANCE retention" put-object-retention --bucket "$B" --key ev.json --version-id "$V1" \
  --retention "{\"Mode\":\"COMPLIANCE\",\"RetainUntilDate\":\"$LONGER\"}"
read -r mode until_ret <<<"$(retention_of ev.json "$V1")"
[[ $(epoch "${until_ret:-1970-01-01}") -eq $(epoch "$LONGER") ]] && ok "extended date stored" || ko "extended date stored" "got '${until_ret:-}'"

# 5. Overwrite and delete markers never touch the locked version
V2=$(put ev.json "overwrite-attempt-$RANDOM")
[[ -n $V2 && $V2 != "$V1" ]] && ok "overwrite creates a new version" || ko "overwrite creates a new version" "v2='$V2' v1='$V1'"
intact "locked version intact after overwrite" ev.json "$V1" "$(sha "$C1")"
must_succeed "simple delete creates a delete marker" delete-object --bucket "$B" --key ev.json
intact "locked version intact after delete marker" ev.json "$V1" "$(sha "$C1")"

# 6. Bucket-level protections
must_fail "suspend versioning on object-lock bucket" put-bucket-versioning --bucket "$B" --versioning-configuration Status=Suspended
must_fail "delete non-empty locked bucket" delete-bucket --bucket "$B"

# 7. Default retention applies to writes without lock headers
must_succeed "set default COMPLIANCE retention (1 day)" put-object-lock-configuration --bucket "$B" \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":1}}}'
C3="default-retention-$RANDOM"
V3=$(put def.json "$C3")
read -r mode _ <<<"$(retention_of def.json "$V3")"
[[ $mode == COMPLIANCE ]] && ok "default retention applied to plain put" || ko "default retention applied to plain put" "got '$mode'"
must_fail "delete version protected by default retention" delete-object --bucket "$B" --key def.json --version-id "$V3"
intact "default-retention version intact" def.json "$V3" "$(sha "$C3")"

# 8. Retention expiry lifts the lock (required by the retention.expired job)
C4="expiring-$RANDOM"
V4=$(put exp.json "$C4" --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$(iso "+${EXPIRY_SECONDS} seconds")")
must_fail "delete before expiry" delete-object --bucket "$B" --key exp.json --version-id "$V4"
sleep $((EXPIRY_SECONDS + 5))
must_succeed "delete after expiry" delete-object --bucket "$B" --key exp.json --version-id "$V4"

# INFO: legal hold (not required by PRYSM today)
C5="legal-hold-$RANDOM"
V5=$(put hold.json "$C5" --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$(iso "+${EXPIRY_SECONDS} seconds")" --object-lock-legal-hold-status ON)
sleep $((EXPIRY_SECONDS + 5))
if s3 delete-object --bucket "$B" --key hold.json --version-id "$V5" >/dev/null; then info "legal hold NOT enforced after retention expiry"
else info "legal hold enforced after retention expiry"; fi
s3 put-object-legal-hold --bucket "$B" --key hold.json --version-id "$V5" --legal-hold Status=OFF >/dev/null
if s3 delete-object --bucket "$B" --key hold.json --version-id "$V5" >/dev/null; then info "delete allowed after legal hold released"
else info "delete still rejected after legal hold released"; fi

rm -rf "$TMP"
echo "RESULT pass=$pass fail=$fail bucket=$B"
[[ $fail -eq 0 ]]
