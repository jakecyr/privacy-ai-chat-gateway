# Private AI Chat gateway

Apache-2.0 backend source for an attested streaming gateway and a separate Apple-verified subscription voucher issuer. This source does not include the private iOS app, hosted credentials, account IDs or production release evidence. Production deployment and provider approval remain unfinished.

## Local mock

Use Node 22 or later. Run `npm ci`, `npm test`, then `npm start`. The mock binds only to `127.0.0.1:8787`; it calls no provider. Pipe a synthetic prompt to `node cli.mjs` to see bounded SSE. The production Dockerfile launches `runtime.js`, never the mock. The billing Dockerfile launches `billing-runtime.js` in a separate project.

The CLI reads prompts from stdin rather than command arguments. For a self-hosted HTTPS service, set `CHAT_ORIGIN`, eligible `CHAT_ROUTE`, fresh `CHAT_APP_CHECK_TOKEN`, and `CHAT_VOUCHER` in your private environment. Public sample clients receive no access to the hosted app's service.

## Protocol and enforcement

`GET /v1/models` returns a configuration version and eligible public routes. `POST /v1/chat/stream` accepts `route`, `disclosureVersion`, `messages` and `memory` only. It requires a consumed limited-use App Check token and a signed one-use route-bound voucher. Messages contain role/text, number 1–24, and end in a user turn. The entire UTF-8 JSON body is at most 32 KiB. At most three memory snippets share a 750-byte limit. `protocol.schema.json` documents object shapes; byte, sequence and cryptographic checks remain runtime responsibilities.

Admission verifies the route and voucher before reserving fleet capacity and atomically spending the voucher. Failed and interrupted attempts can consume allowance. SSE returns meta, bounded deltas and one done/error event. Dependencies, body reads and provider iteration are bounded by a 60-second application deadline; disconnects propagate cancellation. Error bodies contain allowlisted codes, not provider response bodies or identifiers.

The launch adapter fixes OpenAI's endpoint and model, storage disabled, reasoning disabled, output cap 1,200, and explicit caching with zero breakpoints. It validates serving-model metadata before forwarding text and never retries. A route needs independently verified project-level ZDR and logging evidence before enablement. Source code alone does not prove hosted retention behavior.

## Separate billing issuer

`POST /v1/access/issue` accepts only an Apple-signed transaction, route and count. Apple signature/chain, bundle/product/environment and current subscription status are verified before a shared monthly weighted allowance is reserved. Ed25519 vouchers contain issuer/audience/route/time/random nonce, with no transaction or device ID. The gateway retains only expiring spent-nonce hashes. The billing ledger uses an HMAC of the original transaction ID and lives in a separate project with separate IAM and secrets.

`POST /v1/apple/notifications` verifies Apple's outer and nested signatures. Hashed receipt IDs deduplicate deliveries; older signals do not replace newer ones. Notifications never grant entitlement: issuance reconciles current Apple state every time. Configure TTL as described in the infrastructure guide. The app may use RevenueCat for purchase UI; client entitlement flags and unverified webhooks cannot authorize inference.

Model weights, actual token-cost bounds, free-tier identity/abuse controls and operating budgets require deployment-specific configuration and validation. This implementation does not promise one free allowance per person based on App Check alone.

## Release verification

The test suite exercises payload allowlists, UTF-8/CRLF streaming, route evidence expiry, configuration freshness, quota concurrency/rollover, voucher replay and credit exhaustion, Apple renewal/grace/revocation, duplicate/out-of-order notifications, dependency deadlines and disconnects. Hosted release additionally requires real-device attestation, sandbox purchases, a full sink/export inventory, positive-control scanner and synthetic marker/request-row checks after delivery lag. Keep live traffic disabled until those gates pass.

Deployment templates and verification tools in the extracted source distribution use placeholders and explicit environment inputs. Their presence is not a claim that any particular deployment passed its gates. Source snapshots include a file manifest and dependency inventory; published deployment evidence must separately identify the image digest, revision, configuration hash and audit scope.
