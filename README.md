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
- `discord-embed-builder` — `michaellambgelo.github.io` (Discord embed builder, browser RUM)
- `discord-embed-builder-slash` — server-to-server telemetry from the embed-builder Worker (`X-Server-Token` bypass; not a separate Faro app)
- `boxd-card` — `boxd-card.com` / `boxd-card.michaellamb.dev` (hero + web app; segmented by `surface` event attribute)
- `fertile-ground-events` — `fertile-ground-events.pages.dev` (trivia-scorer SPA; admin + public segmented by `surface` session attribute)

## Security Features

- **Exact-host origin validation** — `ALLOWED_ORIGINS` is parsed and compared against the request `Origin` URL's `protocol://host`. Substring matches are **not** permitted. Default-deny when the env var is unset.
- **Bot filtering** — common bot user-agents are rejected with `403`.
- **Token redaction** — ingest tokens never appear in logs (prefix + length only on validation failure).
- **Upstream failure isolation** — network errors to Grafana return `502`, distinct from `500` config errors and pass-through upstream 4xx/5xx.

## Observability

- **`GET /health`** — returns `{ ok, apps, version, collector }` for uptime checks. No CORS/origin requirement.
- **Structured request logs** — one JSON line per request via `console.log`, with `ts`, `method`, `path`, `origin`, `app`, `status`, `upstream_status`, `outcome`, `duration_ms`. Visible via `wrangler tail` or shippable to Loki through Cloudflare Logpush. The `outcome` field is one of: `proxied_ok`, `upstream_error`, `upstream_fetch_failed`, `unknown_app`, `missing_token`, `bot_blocked`, `origin_denied`, `preflight`, `health`, `not_found`, `proxy_exception`.
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
