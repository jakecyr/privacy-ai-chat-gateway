# Hosted deployment

Keep rendered configuration, account IDs, keys, audit output and Terraform state outside a public checkout. `gateway.service.yaml` is a reference template, not a ready deployment. Cloud Run's YAML fields are documented at https://docs.cloud.google.com/run/docs/reference/yaml/v1 . Replace every uppercase placeholder, pin the image digest and numeric secret versions, and review the rendered service before applying it.

## Internal OpenAI TestFlight beta

Build 9 uses the dedicated `private-chat-openai-beta` Cloud Run service in the production Firebase project. This temporary mode uses OpenAI’s standard API retention terms and a new app disclosure version. The production Zero Data Retention and paid-access gates below apply to the full product.

Deploy the normal gateway image by digest. Set `OPENAI_TESTFLIGHT_BETA=true`, `GOOGLE_CLOUD_PROJECT`, the exact release `APP_CHECK_APP_IDS`, and `OPENAI_BETA_EXPIRES_AT` (an ISO 8601 date within 30 days). Mount a pinned Secret Manager version at `OPENAI_KEY_FILE`. Give the dedicated runtime account the App Check Token Verifier role, Firestore access in this project and access to that one secret. Exclude the exact beta service from request log sinks before serving. The iOS Release settings pin this service as `PRIVATE_CHAT_GATEWAY_ORIGIN`.

The beta accepts only GPT-6.1 Terra. It verifies App Check and atomically reserves a worst-case OpenAI charge before dispatch. The fleet shares a $5 lifetime reservation cap in `generationQuotas/openai-testflight-v1`. Revisions and restarts share that ledger. To turn replies off, set `disabled: true` on that document. The ledger holds aggregate data and the beta takes no StoreKit receipt. Replay protection stores only token digests and expirations in `betaAppCheckTokens`. Enable Firestore TTL on `expiresAt` for that collection group. All these operational documents are private.

Use separate inference environments and a fourth billing project. Create a dedicated runtime service account in each project. The inference account needs App Check Token Verifier and access to its operational Firestore database, its named provider key, and voucher public keys. It must have no access to Apple credentials, voucher private keys, HMAC keys or the billing database. The issuer needs the production App Check verifier role in the inference project and access to its own Firestore database and named Apple/voucher/HMAC secrets. Do not grant project Editor, Logging Writer or broad Secret Manager access. Deploy Firestore rules denying every mobile read and write. Configure TTL on `spentVouchers.expiresAt`, `notificationReceipts.expiresAt`, and `entitlementSignals.expiresAt`; code enforces expiry before TTL cleanup.

Enable the Firebase App Check API in both the inference and billing projects. Cross-project issuer verification also requires the API in the issuer's own project. Configure TTL on `appCheckTokens.expiresAt` in each runtime database. The runtime stores token digests to enforce one-use admission when a verified token type omits replay state.

Clients that support multiple standard-retention OpenAI models send `X-PrivateChat-Model-Policy: 2` when loading model discovery and reading or using the allowance policy. Policy ETags bind the selected representation. Requests from older clients receive their compatible Terra routes.

Create Firestore `runtime/gateway` from `route-disabled.json`. Leave it disabled until dated provider approval, exact model/payload checks, release App Attest replay tests and the complete logging audit pass. Runtime reads coalesce and expire after 15 seconds. `/v1/models` exposes only eligible public route metadata. Changes take effect after the cache interval; in-flight calls are cancelled by their deadline, not migrated to another provider.

The billing container uses `Dockerfile.billing` and the separate `billing.service.yaml` reference service. Its origin must match the voucher issuer, and its audience must match the gateway origin. Keep sandbox and production issuers, databases, keys and Apple environments isolated. The template is not a deployment or a billing authorization. Mount `APPLE_CONFIGURATION_FILE`, `APPLE_SIGNING_KEY_FILE`, `VOUCHER_SIGNING_KEY_FILE`, and `LEDGER_HMAC_KEY_FILE`. Set `APP_CHECK_PROJECT_ID`, `APP_CHECK_APP_IDS`, `VOUCHER_KEY_ID`, `VOUCHER_ISSUER`, and `VOUCHER_AUDIENCE`. The Apple configuration supplies root certificate paths, environment, bundle ID, numeric app Apple ID, key/issuer IDs, product IDs, route credit weights and per-renewal-period units (the configuration field is named `monthlyUnits`). The implemented Terra route needs at least 80,000 micro-USD reservation units per attempt; the current draft $1 provider budget is `monthlyUnits: 1000000`. This is an internal allowance, not cash or a tested pricing guarantee. Recheck provider rates and local-versus-provider framing before enabling purchases. Root certificates must come from Apple's PKI, not a transaction's untrusted certificate chain. The template mounts a verified Apple root at `/secrets/apple-root/root.cer`; reference that path in `rootCertificateFiles` and add separately pinned mounts if multiple Apple roots are required. Use an isolated sandbox issuer for sandbox purchases; never silently fall back between Apple environments.

Use the RevenueCat Apple notification endpoint for this app’s production and sandbox URLs. The issuer can also receive original Apple V2 payloads at `/v1/apple/notifications` when the routing preserves the environment. It verifies the outer notification and nested transaction. Duplicate receipt hashes are idempotent, and older notifications cannot overwrite newer signals. Every issuance reconciles with the current App Store Server API, so the notification path and RevenueCat are independent of voucher authorization.

Set `BILLING_DATABASE_ID` to the sandbox Firestore database for a sandbox issuer. The production issuer defaults to `(default)`. Give each issuer its own service identity, voucher key and ledger HMAC, and scope Firestore access to its database. The Apple key authenticates requests to both Apple environments.

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

## Attestation-only release verification

Before mounting any provider credentials, render `attestation.service.yaml` with the pinned gateway image, target project and release Firebase app ID. It uses the same service name as the logging exclusions and explicitly sets `ATTESTATION_CHECK_ONLY=true`. This mode needs only the App Check Token Verifier role in its own project; it does not create or access Firestore, mount secrets, load provider registrations, or enable inference. A process-level test boots it without provider, voucher or database configuration. The normal runtime still fails closed on missing provider configuration; it never silently chooses this mode. Unset the flag and deploy the reviewed full service only after all inference gates pass.

The manual native connection check requires a configured HTTPS `GatewayOrigin` but does not require `CloudInferenceReady`. It sends an empty object and one limited-use token twice; success requires acceptance followed by a consumed-token rejection. Configure the correct Firebase plist for the same environment. Continue to verify cross-project, expired, invalid and concurrent replay tokens separately. This check never establishes provider retention, vault/device behavior or the full logging audit. No diagnostic-only service has been deployed yet.
