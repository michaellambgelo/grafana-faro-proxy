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

This worker is designed to be deployed on Cloudflare Workers. Follow these steps:

1. Create a new Cloudflare Worker in your Cloudflare dashboard
2. Import this GitHub repository (or a forked version that meets your needs) 
3. Configure the required environment variables
4. Deploy the worker
5. Set up a route in your Cloudflare dashboard to direct traffic to this worker

## License

See the [LICENSE](LICENSE) file for details.
