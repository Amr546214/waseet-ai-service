# Strict service authentication and truthful inline evidence

This fix is stacked on `feat/nadeem-ai-qa-fixes` (PR #1). It changes neither live configuration nor credentials and does not deploy anything.

## Authentication

Protected service routes now accept only the existing signed, expiring actor-bound token. The legacy bearer branch and its default hard-coded credential are removed; setting `WASEET_AI_LEGACY_DEV_TOKEN` no longer enables it in any environment. Client bootstrap secrets are accepted only by the existing `/v1/auth/token` exchange, not as bearer access tokens. Signature, expiry, tenant/environment, actor and revocation checks remain.

Before rollout, ensure each calling backend uses the signed exchange and matching client identity, bootstrap secret and environment. Waseet platform backend has this path in `WaseetServiceTokenBroker`; its configuration selects signed mode with `WASEET_AI_AUTH_MODE=signed` and the required server-only credential fields. The source review and four local broker tests establish code support, not the deployed configuration.

Deploying the strict code stops acceptance of the old bearer credential on protected routes. Remove retired legacy configuration from deployments and consumers, and verify old credentials are refused after rollout. No live credential was rotated, deployment changed or production log queried by this PR. Previously issued valid signed tokens retain their normal expiry/revocation semantics.

## Inline evidence

- Metadata-only/unsupported binaries keep `contentRead: false`, an empty excerpt and a useful unreadable-source marker. Size, MIME and hash are not content evidence.
- Real text, DOCX, PDF and archive extraction continues through the existing bounded parser. Extracting text is not code execution or ownership verification.
- Inline input must be well formed and fit the existing 512 KiB decoded limit. Oversized input is refused rather than silently parsing a truncated prefix; malformed/empty input and parse errors are recorded explicitly.
- Each inline input gets a distinct opaque source. Diagnostic failures do not echo document/base64 payloads. Cancellation still throws rather than returning a successful inspection.
- Aggregate `inspected: true` continues to mean at least one item was readable; callers must consult each evidence item's `contentRead` and `unavailable` for mixed/partial results.
- Unreadable accreditation remains `UNVERIFIED`, with null scores and an explicit Arabic explanation. Portfolio prompting receives the unreadable state and cannot use invented binary metadata as an evidence excerpt. The existing advisory/manual-review workflow is preserved.

## Verification

- Full service suite: **160/160 passed**, including **16 new regression tests**.
- `npm run build`: passed.
- Platform backend signed-token broker tests: **4/4 passed**, no backend source changes.
- Tests use local Fastify injection, test-only signing credentials, bounded document workers and mocked AI transport. No live provider, production token, email, migration or deployment was used.
