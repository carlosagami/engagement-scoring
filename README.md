# PowerEmail Open Intelligence

PowerEmail Open Intelligence is the tenant-aware replacement for the legacy Smartlead-era engagement tracker.

## Scope of v1

- Public `GET /o/:token.gif` endpoint using opaque message tokens.
- Raw fetch persistence in `engagement.open_events`.
- Conservative classifications: `security_fetch`, `proxy_fetch`, `probable_human_open`, and `unknown_fetch`.
- Classification history with versioning.
- Message-level timing using `sent_at` and `delivered_at` rather than lead-level `last_sent` state.
- No scoring, suppression, unsubscribe, routing, or sender changes.
- No public lead-export endpoints and no Smartlead webhook.

## Required environment

- `DATABASE_URL` preferred, or standard `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGPORT`.
- `PORT` supplied by Railway.
- `CLASSIFIER_VERSION` optional, default `oi-v1-observe`.
- `IP_HASH_SALT` strongly recommended before production telemetry.
- `PGPOOL_MAX` optional, default `10`.

## Public endpoints

- `GET /health`
- `GET /o/:token.gif`

The pixel endpoint always returns the GIF even if lookup or persistence fails. Analytics failure must not break message rendering.

## Database

The initial schema is captured in `migrations/001_open_intelligence_core.sql`. Tracking remains disabled by default at both tenant and domain level.

## Deployment model

Deploy this branch as a new Railway service such as `poweremail-open-intelligence`. Do not replace the legacy `engagement-scoring` service until the new service has passed pilot validation.

Expected public tracking hosts will eventually be domain-aligned, for example `o.servireselcamino.com`, and should be fronted by Cloudflare before activation.
