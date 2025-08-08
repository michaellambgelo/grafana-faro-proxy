# Grafana Faro Proxy

A Cloudflare Worker that proxies Real User Monitoring (RUM) data from web applications to Grafana Cloud's Faro collector.

## Overview

This proxy service allows multiple web applications to send telemetry data to Grafana Cloud while:

- Enforcing CORS policies
- Filtering out bot traffic
- Routing different applications to different Grafana ingest tokens
- Enriching requests with client IP and protocol information

## How It Works

The worker acts as a middleware between your web applications and Grafana Cloud:

1. Client applications send telemetry data to `/faro-proxy` endpoint
2. The proxy determines which application is making the request through:
   - Query parameter: `?app=app-name`
   - Referer header analysis
   - Custom `X-App-Name` header
3. The appropriate ingest token is selected based on the application
4. The request is forwarded to Grafana Cloud with necessary headers

## Configuration

The worker requires the following environment variables to be set in the Cloudflare Workers dashboard:

| Variable | Description | Example |
|----------|-------------|--------|
| `GRAFANA_COLLECTOR_HOST` | Grafana Faro collector hostname | `faro-collector-prod-us-east-0.grafana.net` |
| `BLOG_INGEST_TOKEN` | Ingest token for blog application | `your-blog-token-here` |
| `LETTERBOXD_INGEST_TOKEN` | Ingest token for letterboxd viewer application | `your-letterboxd-token-here` |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins | `https://michaellamb.dev,http://localhost:3000` |

## Supported Applications

The proxy currently supports routing for the following applications:

- `blog` - Main blog/website (default)
- `letterboxd-viewer` or `letterboxd` - Letterboxd viewer application

## Security Features

- **Origin Validation**: Requests are checked against the `ALLOWED_ORIGINS` list
- **Bot Detection**: Requests from common bot user agents are blocked
- **CORS Headers**: Proper CORS headers are added to all responses

## Usage

In your client application, configure the Grafana Faro SDK to use this proxy instead of directly connecting to Grafana Cloud:

```javascript
import { initializeFaro } from '@grafana/faro-web-sdk';

initializeFaro({
  url: 'https://yourdomain.com/faro-proxy',
  // Optional: Specify which app this is for multi-app setups
  // transportOptions: {
  //   fetch: {
  //     url: 'https://yourdomain.com/faro-proxy?app=your-app-name'
  //   }
  // }
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

### 3. Create a wrangler.toml file (if not already present)

Create a `wrangler.toml` file in the root of your project with the following content:

```toml
name = "grafana-faro-proxy"
main = "worker.js"
compatibility_date = "2023-01-01"

[vars]
GRAFANA_COLLECTOR_HOST = "faro-collector-prod-us-east-0.grafana.net"
ALLOWED_ORIGINS = "*"
```

Create a file in the root directory of the Cloudflare Worker named `.dev.vars` with this template:

```toml
BLOG_INGEST_TOKEN = "your-development-ingest-token"
LETTERBOXD_INGEST_TOKEN = "your-development-ingest-token"
```

Replace the ingest tokens with development tokens or dummy values for local testing.

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
wrangler publish
```

Remember to keep your production ingest tokens secure and never commit them to version control.


## License

See the [LICENSE](LICENSE) file for details.
