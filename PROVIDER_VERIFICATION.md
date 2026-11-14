# Provider profiles and release evidence

All routes in the reference configuration are disabled. Synthetic tests prove adapter behavior against fixtures, not account-level retention, provider availability or real invoices. Clients must include reviewed provider-specific disclosures and pass device checks before offering these routes. A backend source release does not establish an iOS build’s cloud readiness.

## Compiled profiles

| Route | API/model | Generation controls | Input admission | Minimum reservation |
|---|---|---|---|---:|
| `openai-terra-text` | OpenAI Responses / `gpt-5.6-terra` | 1,200 output; reasoning none; storage off; explicit caching without breakpoints | o200k text count + 512 framing reserve, at most 32,768 | 80,000 micro-USD units |
| `claude-sonnet-4-6-text` | Anthropic Messages / `claude-sonnet-4-6` | 1,200 output; thinking disabled; no tools or cache controls | Actual payload text UTF-8 bytes + 1,024 framing reserve, at most 32,768 | 120,000 units |
| `gemini-3-8-flash-low-text` | Google Cloud streamGenerateContent / `gemini-3.8-flash` | 2,400 combined output/thinking; Low thinking; thoughts not exposed; no tools, grounding, caches or continuation | Actual payload text UTF-8 bytes + 1,024 framing reserve, at most 32,768 | 80,000 units |

The byte budgets are conservative local admission estimates, not exact provider token counts. Verify them using approved-project synthetic traffic and invoice parity. Every adapter validates reported serving-model metadata before forwarding text. Incompatible model/cache/usage reports quarantine the affected process and attempt the shared disable switch. No adapter retries or invokes another provider. The dispatcher rechecks availability and target identity before dispatch.

Claude Sonnet 4.6 is used because it supports thinking disabled. Current [Claude model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations) must be checked before deployment; newer models are not automatically substituted. [Claude API retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) requires an eligible agreement and feature set; flagged content may be retained for up to two years, and legal exceptions apply. Some [Covered Models](https://support.claude.com/en/articles/15425996-data-retention-practices-for-covered-models) require additional retention. Check the exact deployed model and agreement; another model's approval does not transfer to this route. If an account requires a persistent end-user identifier, this integration is ineligible until the design and disclosures change. The adapter supplies no `user_id`, user profile, tools or stateful features.

Gemini 3.8 [rejects `candidateCount`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash); the adapter omits it and rejects streams with multiple candidates. It uses a selected `global`, `us` or `eu` endpoint and workload OAuth credentials. The provider project is also explicitly the quota project. Grant the runtime identity only the needed prediction permissions and `serviceusage.services.use` in that dedicated project; do not provision a long-lived service-account JSON key.

For [Google Cloud zero retention](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention), save evidence that abuse-monitoring prompt logging is not enabled for this exact project under its effective agreement, turn off request/response logging, and read back project `cacheConfig.disableCache: true`. This disables both in-memory and durable caching. Omitting `cachedContent` from the payload alone is insufficient. The adapter uses no Interactions API, resumption or continuation state, and drops thought signatures rather than persisting them.

Reservations use checked November 7, 2026 rates: [Claude Sonnet 4.6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview) at $3/$15 per million input/output tokens, and [Gemini 3.8 Flash](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) at standard non-global $1.65/$8.25 rates without relying on promotional credits. These remain estimates pending actual project/region billing verification. A different model, effort, region, rate or feature set needs a new reviewed profile and adequate weight.

## Explicit operator evidence

Each route needs `enabled: true`, `retentionProfile: "zdr"`, a future `verifiedUntil`, a matching `targetDigest`, and a `verification` object with a dated `reviewedAt`, private evidence-file SHA-256 `evidenceDigest`, and all flags below true:

- `agreementApproved`
- `payloadVerified`
- `cacheDisabled`
- `loggingDisabled`
- `abuseMonitoringApproved`
- `persistentUserIDNotRequired`
- `pricingVerified`

These are operator attestations, not a way for code to establish a legal approval. Keep actual approvals, account/project identifiers, settings readbacks, dated terms/exceptions, synthetic stream results, invoice comparisons and logging audits private. A digest or a checkbox without that evidence is not a completed release gate. Never fabricate passing values to make a route visible.

`targetDigest` is produced by `providerTargetDigest` in `route-specs.js`. For OpenAI and Claude, its target is `{credentialSHA256: sha256(trimmed API key)}`. For Gemini it is `{projectID, location}`. It includes the compiled provider/model and canonical target keys. A changed key, project or region removes the route from discovery until that exact target has been reviewed again. Do not publish real target or credential fingerprints in release artifacts.

## Runtime configuration

Set only the credentials for providers actually configured. The gateway needs at least one registered provider plus voucher public keys. Missing registrations, mismatched fingerprints and unhealthy adapters are removed from discovery even when a Firestore record says enabled.

- OpenAI: `OPENAI_KEY_FILE`, containing the dedicated approved project key.
- Claude: `CLAUDE_KEY_FILE`, containing a dedicated eligible workspace key.
- Gemini: `GEMINI_CONFIGURATION_FILE`, a private JSON object with only `projectID` and `location`; workload credentials come from the runtime identity through Application Default Credentials. No Gemini API key is used.

Mount these through named, numerically pinned Secret Manager versions. Optional provider mounts are intentionally absent from the basic gateway template; render them privately only after their independent evidence and IAM checks pass. An old deployment needs the new explicit evidence fields and target digest before enabling any route with this version. No paid ledger migration is performed by changing a provider profile.

The billing issuer may configure any subset of the three known route IDs at or above their compiled minimum weights. All weights share the verified Apple renewal-period allowance. The client must disclose fixed reservation costs and the reset date before purchase; short or failed responses do not currently refund a reservation. Real StoreKit, App Attest, logging and provider account checks remain mandatory.

## Current catalog profiles

The catalog additionally supports operator-configured model IDs within compiled text-only profiles. The initial current-model metadata is GPT-6.1 Terra, Claude Sonnet 5.5 and Gemini 4 Argon. Each model/reasoning pair gets a hash-derived route ID and a fresh target fingerprint. Retention, payload/cache behavior, usage, pricing and credential evidence remain mandatory; changing public metadata does not enable inference. Input is bounded at 32,768 estimated tokens/bytes and output at 1,200–8,192 total tokens including reasoning. Rates are operator-reviewed input/output micro-USD per token; weighted reservations round up, and the issuer rejects inadequate weights.

The paid `text-openai-standard-v1` profile is limited to GPT-6.1 Terra. It uses disclosure version 3 and a `standard-` route prefix. Requests still disable response storage and prompt caching. OpenAI’s standard abuse-monitoring retention applies. Evidence must confirm `standardRetentionDisclosed` for this profile. Sandbox deployments use a separate route registry and a cap of 20 reserved attempts per day.

OpenAI uses Responses with store false, no persistence/tools and explicit zero-breakpoint caching. Reasoning effort follows the validated configured level. Anthropic adaptive profiles use thinking adaptive and output_config.effort; thinking and signature blocks are bounded and discarded, never forwarded or persisted. Gemini uses the fixed project/region host and configured safe model path with LOW/MEDIUM/HIGH and includeThoughts false. Model changes require renewed native permission for that model even when the provider profile remains unchanged. Unsupported providers, profiles or API features require a code/disclosure review. Production approvals and live checks remain absent.

The draft launch commercial policy allows at most $1 model reservations per $9.99 renewal and reserves $0.25 per subscriber for additional variable-cost planning. Runtime rejects configurations below a 5× net-revenue/cost target using a conservative 30% Apple fee scenario. This validates stated assumptions, not actual invoices. Reconcile US store pricing and measured infrastructure/RevenueCat/tax costs before activating purchases. The disabled free campaign cap is $200. No profit guarantee follows from configuration alone.
