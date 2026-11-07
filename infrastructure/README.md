# Hosted deployment

Keep rendered configuration, account IDs, keys, audit output and Terraform state outside a public checkout. `gateway.service.yaml` is a reference template, not a ready deployment. Cloud Run's YAML fields are documented at https://docs.cloud.google.com/run/docs/reference/yaml/v1 . Replace every uppercase placeholder, pin the image digest and numeric secret versions, and review the rendered service before applying it.

Use separate inference environments and a fourth billing project. Create a dedicated runtime service account in each project. The inference account needs App Check Token Verifier and access to its operational Firestore database, its named provider key, and voucher public keys. It must have no access to Apple credentials, voucher private keys, HMAC keys or the billing database. The issuer needs the production App Check verifier role in the inference project and access to its own Firestore database and named Apple/voucher/HMAC secrets. Do not grant project Editor, Logging Writer or broad Secret Manager access. Deploy Firestore rules denying every mobile read and write. Configure TTL on `spentVouchers.expiresAt`, `notificationReceipts.expiresAt`, and `entitlementSignals.expiresAt`; code enforces expiry before TTL cleanup.

Create Firestore `runtime/gateway` from `route-disabled.json`. Leave it disabled until dated provider approval, exact model/payload checks, release App Attest replay tests and the complete logging audit pass. Runtime reads coalesce and expire after 15 seconds. `/v1/models` exposes only eligible public route metadata. Changes take effect after the cache interval; in-flight calls are cancelled by their deadline, not migrated to another provider.

The billing container uses `Dockerfile.billing` and the separate `billing.service.yaml` reference service. Its origin must match the voucher issuer, and its audience must match the gateway origin. Keep sandbox and production issuers, databases, keys and Apple environments isolated. The template is not a deployment or a billing authorization. Mount `APPLE_CONFIGURATION_FILE`, `APPLE_SIGNING_KEY_FILE`, `VOUCHER_SIGNING_KEY_FILE`, and `LEDGER_HMAC_KEY_FILE`. Set `APP_CHECK_PROJECT_ID`, `APP_CHECK_APP_IDS`, `VOUCHER_KEY_ID`, `VOUCHER_ISSUER`, and `VOUCHER_AUDIENCE`. The Apple configuration supplies root certificate paths, environment, bundle ID, numeric app Apple ID, key/issuer IDs, product IDs, route credit weights and monthly units. Root certificates must come from Apple's PKI, not a transaction's untrusted certificate chain. The template mounts a verified Apple root at `/secrets/apple-root/root.cer`; reference that path in `rootCertificateFiles` and add separately pinned mounts if multiple Apple roots are required. Use an isolated sandbox issuer for sandbox purchases; never silently fall back between Apple environments.

Point App Store Server Notifications V2 to the issuer's `/v1/apple/notifications`. It verifies the outer notification and nested transaction. Duplicate receipt hashes are idempotent, and older notifications cannot overwrite newer signals. Notifications never authorize access: every issuance reconciles with the current App Store Server API. Do not configure RevenueCat webhooks as an entitlement authority for chat; the SDK provides purchase UI while Apple-verified issuance enforces access.

## Logging release gate

Before live content, inventory project, ancestor folder and organization sinks, destinations, buckets, exports, Trace, Error Reporting, CI and any network proxy in the path. Exclude all `cloud_run_revision` logs for **both** services at every operator-controlled sink that could route them. A project `_Default` exclusion does not cover ancestor sinks. Preserve required administrative audit logging. Google describes the routing boundaries at https://docs.cloud.google.com/logging/docs/routing/overview .

Use the exact service filter below as a sink exclusion, without sampling:

```text
resource.type="cloud_run_revision"
(resource.labels.service_name="private-chat-gateway" OR resource.labels.service_name="private-chat-billing")
```

Record inaccessible destinations as a failed gate. First prove the scanner can detect a synthetic marker in an isolated positive-control sink. Then exercise synthetic success, malformed bodies, consumed attestation replay, quota exhaustion, provider refusal/error, stalls, disconnect and forced crash. After delivery/export lag, search unique synthetic prompt/reply/memory/error markers and independently search for request rows by service/revision/time. Do not interpret an empty query without inventory and positive control as proof of absence.

Save only content-free release evidence: app build, image digest, revision, config hash, provider approval reference, tested destinations, time window, lag allowance and pass/fail. Re-run after routing, sink, SDK, IAM, model or retention changes. Real-device App Attest, purchases, restore, refund/grace, lock/passcode and app-switcher checks remain mandatory.

The backend source distribution includes `tools/inventory-logging.py` for read-only project/ancestor sink inventory and `tools/log-positive-control.mjs` for an isolated synthetic control in a known default bucket. The latter writes one synthetic global-resource entry; it does not send user content or prove chat-service exclusions. Both tools keep their reports private and explicitly leave the full logging release gate false.
