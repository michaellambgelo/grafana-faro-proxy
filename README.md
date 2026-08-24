# Grafana Faro Proxy

[![Status](https://status.michaellamb.dev/api/badge/14/status)](https://status.michaellamb.dev)
[![Uptime 30d](https://status.michaellamb.dev/api/badge/14/uptime/720?style=flat)](https://status.michaellamb.dev)

A Cloudflare Worker that proxies Real User Monitoring (RUM) data from web applications to Grafana Cloud's Faro collector.

## Overview

This proxy service allows multiple web applications to send telemetry data to Grafana Cloud while:

- Enforcing CORS policies
- Filtering out bot traffic
- Routing different applications to different Grafana ingest tokens
- Enriching requests with client IP and protocol information

## How It Works

The worker acts as a middleware between your web applications and Grafana Cloud:

1. Client applications `POST` telemetry to `/faro-proxy?app=<name>`. The `app` query parameter is **required** — unknown or missing apps return `400 Bad Request`.
2. The app name is resolved to an ingest token (`*_INGEST_TOKEN` secret) via the map in `worker.js` (`TOKEN_ENV_BY_APP`).
3. The `Origin` header is validated against `ALLOWED_ORIGINS` with exact protocol+host match. Disallowed origins receive `403` with no CORS headers.
4. Bot user-agents are rejected with `403`.
5. The request is forwarded to Grafana Cloud; upstream 2xx/4xx pass through, upstream network failures surface as `502 Bad Gateway`.

## Configuration

### Environment variables (in `wrangler.toml`)

| Variable | Description | Example |
|----------|-------------|---------|
| `GRAFANA_COLLECTOR_HOST` | Grafana Faro collector hostname | `faro-collector-prod-us-east-0.grafana.net` |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins (exact protocol+host match, default-deny when unset) | `https://michaellamb.dev,https://blog.michaellamb.dev` |

### Secrets (set via `wrangler secret put`)

| Secret | App name |
|--------|----------|
| `BLOG_INGEST_TOKEN` | `blog` |
| `LETTERBOXD_INGEST_TOKEN` | `letterboxd-viewer` |
| `LANDING_INGEST_TOKEN` | `landing` |
| `EMBED_BUILDER_INGEST_TOKEN` | `discord-embed-builder` |
| `EMBED_BUILDER_SLASH_INGEST_TOKEN` | `discord-embed-builder-slash` (server-to-server) |
| `BOXD_CARD_INGEST_TOKEN` | `boxd-card` |
| `FERTILE_GROUND_EVENTS_INGEST_TOKEN` | `fertile-ground-events` |

### Adding a new app

1. **Provision the Grafana Cloud app** and copy its ingest token.
2. **Register the app name** by adding an entry to `TOKEN_ENV_BY_APP` in `worker.js` (e.g. `'subscribe': 'SUBSCRIBE_INGEST_TOKEN'`).
3. **Set the secret** on the worker: `npx wrangler secret put SUBSCRIBE_INGEST_TOKEN`.
4. **Allow the origin** by adding it to `ALLOWED_ORIGINS` in `wrangler.toml`.
5. **Wire up the client** by copying `client/faro-init.js` into the consuming site and setting `APP_NAME` to the value you registered in step 2.
6. **Deploy** the worker; verify in Grafana Cloud Faro explorer that events for the new `app.name` are arriving.

## Supported Applications

- `blog` — `blog.michaellamb.dev` (Jekyll)
- `letterboxd-viewer` — `letterboxd.michaellamb.dev` (static dashboard)
- `landing` — `michaellamb.dev` (landing page)
- `discord-embed-builder` — `embed-builder.michaellamb.dev` (Discord embed builder, browser RUM; **its origin is not yet in `ALLOWED_ORIGINS`** — see Architecture)
- `discord-embed-builder-slash` — server-to-server telemetry from the embed-builder Worker (`X-Server-Token` bypass; not a separate Faro app)
- `boxd-card` — `boxd-card.com` / `boxd-card.michaellamb.dev` (hero + web app; segmented by `surface` event attribute)
- `fertile-ground-events` — `fertile-ground-events.pages.dev` (trivia-scorer SPA; admin + public segmented by `surface` session attribute)

## Architecture: why this proxy exists

Two invariants define the whole design. Everything else is plumbing.

### 1. The proxy owns the ingest tokens — the browser never sees one

Grafana Cloud authenticates ingest by putting the token **in the collector URL**:
`https://<collector>/collect/<INGEST_TOKEN>`. A browser that posted directly would have to carry
that token in its bundle, which publishes it — anyone reading the JS could then write arbitrary
telemetry into that Grafana stack.

So the browser never holds one. It posts to this Worker with nothing but `?app=<name>`. The Worker
resolves the name through `TOKEN_ENV_BY_APP`, reads the matching `*_INGEST_TOKEN` **secret from its
own environment**, and constructs the collector URL server-side.

Consequences worth knowing:

- **Tokens exist only as secrets on this Worker.** Not in any app's repo, bundle, or build config.
- **Rotating a token is `wrangler secret put` here — no app rebuild, no redeploy of the app.**
- **A missing or malformed token fails closed** with `500 Configuration Error: no ingest token`.
  Tokens must match `^[a-zA-Z0-9]{32,64}$`; failures log prefix and length only, never the value.

### 2. CORS binds each app's telemetry to the origin it is actually deployed at

`?app=` is caller-controlled — anyone can send any app name. The token alone therefore proves
*which* monitor is being written to, not *who* may write to it. **The Origin allowlist supplies the
second half.**

`ALLOWED_ORIGINS` is compared as an exact `protocol://host` match, substrings are not accepted, and
an unset value is **default-deny**. A disallowed origin gets `403` with **no CORS headers at all**,
so the browser discards the response even if it were to succeed.

Together: **the token says which Grafana monitor; the origin says that the caller is the real
deployed app.** Neither is sufficient alone, and that is the point.

The practical rule that follows:

> **An app served from a new domain must be added to `ALLOWED_ORIGINS`, or its RUM is rejected —
> even though its ingest token is set correctly.** The failure looks nothing like a token problem.

Two deliberate exceptions:

- **Server-to-server callers** cannot present a browser `Origin` and would trip the bot filter, so
  they authenticate with `X-Server-Token` matching `SERVER_SHARED_SECRET`, which bypasses both
  gates. `discord-embed-builder-slash` is the only current user.
- **`GET /health`** is ungated so uptime monitors can reach it.

`Origin` is set by the user agent and cannot be forged *from a browser*. It is not a defence against
`curl`, and is not meant to be — that is what the bot-UA filter and the per-app token scoping cover.

### Origin ↔ deployed app

Every row here must match the app's real serving origin, not where it used to live.

| App (`?app=`) | Actual serving origin | In `ALLOWED_ORIGINS`? |
|---|---|---|
| `blog` | `blog.michaellamb.dev` | yes |
| `letterboxd-viewer` | `letterboxd.michaellamb.dev` | yes |
| `landing` | `michaellamb.dev` | yes |
| `discord-embed-builder` | **`embed-builder.michaellamb.dev`** (see `public/CNAME`) | **NO — see below** |
| `boxd-card` | `boxd-card.com`, `boxd-card.michaellamb.dev` | yes |
| `fertile-ground-events` | `fertile-ground-events.pages.dev` | yes |

> **Known gap (2026-08-23).** `ALLOWED_ORIGINS` lists `https://michaellambgelo.github.io` for
> `discord-embed-builder`, but that app is served from its custom domain
> `embed-builder.michaellamb.dev`. Verified: `Origin: https://embed-builder.michaellamb.dev` →
> **`403`, no `access-control-allow-origin`**, while allowed origins return `405`. Its ingest token
> is set correctly and its browser RUM is still rejected — exactly the failure mode described above.
> Fix by adding `https://embed-builder.michaellamb.dev` (and the admin origin, if it emits RUM) to
> `ALLOWED_ORIGINS` and redeploying.

## Security Features

- **Exact-host origin validation** — `ALLOWED_ORIGINS` is parsed and compared against the request `Origin` URL's `protocol://host`. Substring matches are **not** permitted. Default-deny when the env var is unset.
- **Bot filtering** — common bot user-agents are rejected with `403`.
- **Token redaction** — ingest tokens never appear in logs (prefix + length only on validation failure).
- **Upstream failure isolation** — network errors to Grafana return `502`, distinct from `500` config errors and pass-through upstream 4xx/5xx.

## Observability

- **`GET /health`** — returns `{ ok, apps, version, collector }` for uptime checks. No CORS/origin requirement.
- **Structured request logs** — one JSON line per request via `console.log`, with `ts`, `method`, `path`, `origin`, `app`, `status`, `upstream_status`, `outcome`, `duration_ms`. Visible via `wrangler tail` or shippable to Loki through Cloudflare Logpush. The `outcome` field is one of: `proxied_ok`, `upstream_error`, `upstream_fetch_failed`, `unknown_app`, `missing_token`, `bot_blocked`, `origin_denied`, `preflight`, `health`, `not_found`, `proxy_exception`.
### Verifying routing is alive

The health signal is **`GET /faro-proxy?app=<known-app>` → `405`**.

`405` means the route matched and the app was recognised, and the method was
rejected — which is exactly what a `GET` on an ingest endpoint should do. It is
the cheapest proof that routing and the app table are both intact.

Read the response codes as:

| Request | Expected | Meaning |
|---|---|---|
| `GET /faro-proxy?app=blog` | **405** | healthy — route matched, app known |
| `GET /faro-proxy?app=nonsense` | 400 | route matched, app not in `TOKEN_ENV_BY_APP` |
| `GET /faro-proxy?app=<known>` | **404** | **routing is broken** — every app goes dark silently |
| `GET /faro-proxy?app=<known>` | 500 | app known but its ingest token is unset/malformed |
| `GET /` | 404 | normal — `/` is not a route |

**Do not check `GET /?app=<known>`.** That path returns `404` for every app
including healthy ones, because the proxy route is `/faro-proxy` and `/` is a
legitimate 404. Used as a health check it reports a fully healthy service as
catastrophically broken. (A prior audit recorded the signal that way; it cost a
real investigation on 2026-08-23.)

One-liner across every configured app:

```bash
for a in $(curl -s https://grafana.michaellamb.dev/health | jq -r '.apps[]'); do
  printf '%-32s %s\n' "$a" \
    "$(curl -s -o /dev/null -w '%{http_code}' "https://grafana.michaellamb.dev/faro-proxy?app=$a")"
done
```

- **Analytics Engine metrics** — when the `FARO_PROXY_METRICS` binding is available (configured in `wrangler.toml`), each request emits a datapoint with the app (index), duration, status, upstream status, outcome, method, and origin. Queryable from Grafana via the Cloudflare Analytics Engine datasource. Comment out the `[[analytics_engine_datasets]]` block to disable.

## Usage

In your client application, configure the Grafana Faro SDK to use this proxy with the required `?app=` query parameter:

```javascript
import { initializeFaro } from '@grafana/faro-web-sdk';

initializeFaro({
  url: 'https://grafana.michaellamb.dev/faro-proxy?app=your-app-name',
  app: {
    name: 'your-app-name',
    version: '1.0.0',
    environment: 'production',
  },
});
```

## Deployment

### Manual Deployment

This worker is designed to be deployed on Cloudflare Workers. Follow these steps:

1. Create a new Cloudflare Worker in your Cloudflare dashboard
2. Import this GitHub repository (or a forked version that meets your needs) 
3. Configure the required environment variables
4. Deploy the worker
5. Set up a route in your Cloudflare dashboard to direct traffic to this worker

### GitHub Actions Deployment

This repository includes a GitHub Actions workflow for automatic deployment. To set it up:

1. In your GitHub repository, go to Settings > Secrets and variables > Actions
2. Add the following secrets:
   - `CF_API_TOKEN`: Your Cloudflare API token with Workers deployment permissions
   - `BLOG_INGEST_TOKEN`: Your Grafana Faro ingest token for the blog application
   - `LETTERBOXD_INGEST_TOKEN`: Your Grafana Faro ingest token for the letterboxd viewer

3. Push to the main branch or manually trigger the workflow to deploy

The workflow will automatically deploy your worker to Cloudflare using the environment variables and secrets configured in GitHub.

# Setting Up Local Development for Grafana Faro Proxy

This guide explains how to set up a local development environment for the Grafana Faro proxy to avoid CORS issues when developing locally.

## Prerequisites

1. Node.js and npm installed
2. Wrangler CLI (Cloudflare Workers development tool)

## Setup Instructions

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Clone your Grafana Faro Proxy repository

```bash
git clone https://github.com/michaellambgelo/grafana-faro-proxy.git
cd grafana-faro-proxy
```

### 3. Configure local secrets

The committed `wrangler.toml` already contains the development environment config (port 8787, `ALLOWED_ORIGINS=http://localhost:4000`). Create a `.dev.vars` file alongside it with your ingest tokens:

```
BLOG_INGEST_TOKEN = "your-development-ingest-token"
LETTERBOXD_INGEST_TOKEN = "your-development-ingest-token"
```

Use a dev-only Grafana ingest token or a 32+ char alphanumeric placeholder that passes format validation for smoke tests.

### 4. Run the worker locally

```bash
wrangler dev --local
```

This will start your worker on `http://localhost:8787`.

### 5. Test with local setup

#### Prerequisite: a blog application served from localhost:4000

With your Jekyll site running on `localhost:4000` and your Cloudflare Worker running on `localhost:8787`, your site should now be able to send telemetry data.

## Production Deployment

When you're ready to deploy changes to your Cloudflare Worker:

```bash
wrangler deploy
```

Remember to keep your production ingest tokens secure and never commit them to version control.


## License

See the [LICENSE](LICENSE) file for details.
