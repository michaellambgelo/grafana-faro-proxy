/**
 * Cloudflare Worker for Grafana Faro RUM Data Proxy.
 * Proxies telemetry from michaellamb.dev properties to Grafana Cloud.
 * App selection is driven by the required `?app=<name>` query parameter;
 * each app maps to its own ingest token secret.
 */

const TOKEN_ENV_BY_APP = {
  blog: 'BLOG_INGEST_TOKEN',
  'letterboxd-viewer': 'LETTERBOXD_INGEST_TOKEN',
  landing: 'LANDING_INGEST_TOKEN',
  // Server-to-server telemetry from the discord-embed-builder Worker's
  // /interactions endpoint. Reached via the X-Server-Token header bypass
  // (see isServerToServer below); the Origin allowlist and bot-UA gate
  // do not apply when the bypass is active.
  'discord-embed-builder-slash': 'EMBED_BUILDER_SLASH_INGEST_TOKEN',
};

const SERVER_TOKEN_HEADER = 'X-Server-Token';

const CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-Requested-With, x-faro-session-id';

const BOT_USER_AGENTS = [
  'bot', 'crawler', 'spider', 'scraper', 'facebookexternalhit',
  'twitterbot', 'linkedinbot', 'whatsapp', 'telegram', 'slackbot',
  'googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'baiduspider',
];

function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some((pattern) => ua.includes(pattern));
}

function parseAllowedOrigins(allowedOriginsEnv) {
  if (!allowedOriginsEnv) return null;
  const set = new Set();
  for (const raw of allowedOriginsEnv.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      set.add(`${u.protocol}//${u.host}`);
    } catch {
      console.error(`Ignoring malformed ALLOWED_ORIGINS entry: "${trimmed}"`);
    }
  }
  return set;
}

function isOriginAllowed(origin, allowedSet) {
  if (!allowedSet || !origin) return false;
  try {
    const u = new URL(origin);
    return allowedSet.has(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}

function buildCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/**
 * Server-to-server callers (e.g. another Cloudflare Worker emitting telemetry)
 * cannot satisfy the browser-oriented Origin allowlist or the bot-UA block.
 * They authenticate by sending a shared secret in the X-Server-Token header,
 * matching env.SERVER_SHARED_SECRET. When matched, the request bypasses both
 * gates; ingest token lookup and forwarding to the collector continue
 * normally.
 */
function isServerToServer(request, env) {
  const presented = request.headers.get(SERVER_TOKEN_HEADER);
  if (!presented) return false;
  const expected = env.SERVER_SHARED_SECRET;
  if (!expected) return false;
  return presented === expected;
}

function getIngestToken(appName, env) {
  const envVarName = TOKEN_ENV_BY_APP[appName];
  if (!envVarName) return null;
  const token = env[envVarName]?.trim();
  if (!token) {
    console.error(`No ingest token configured for app "${appName}" (env var ${envVarName} unset)`);
    return null;
  }
  if (!/^[a-zA-Z0-9]{32,64}$/.test(token)) {
    console.error(
      `Invalid token format for app "${appName}" (length ${token.length}, prefix "${token.substring(0, 5)}")`
    );
    return null;
  }
  return token;
}

function emitTelemetry(env, ctx) {
  const entry = {
    ts: new Date(ctx.start).toISOString(),
    method: ctx.method,
    path: ctx.path,
    origin: ctx.origin || null,
    app: ctx.app || null,
    status: ctx.status,
    upstream_status: ctx.upstream_status ?? null,
    outcome: ctx.outcome,
    duration_ms: Date.now() - ctx.start,
  };
  console.log(JSON.stringify(entry));

  if (env.FARO_PROXY_METRICS?.writeDataPoint) {
    try {
      env.FARO_PROXY_METRICS.writeDataPoint({
        indexes: [ctx.app || 'unknown'],
        doubles: [entry.duration_ms, ctx.status, ctx.upstream_status ?? 0],
        blobs: [ctx.outcome, ctx.method, ctx.origin || 'none'],
      });
    } catch (err) {
      console.error('Analytics Engine writeDataPoint failed:', err);
    }
  }
}

function handleHealth(env) {
  return Response.json({
    ok: true,
    apps: Object.keys(TOKEN_ENV_BY_APP),
    version: env.WORKER_VERSION || 'dev',
    collector: env.GRAFANA_COLLECTOR_HOST || 'faro-collector-prod-us-east-0.grafana.net',
  });
}

async function handleFaroProxy(request, env, corsHeaders, ctx, serverToServer) {
  const url = new URL(request.url);
  const appName = url.searchParams.get('app');
  if (!appName || !(appName in TOKEN_ENV_BY_APP)) {
    ctx.outcome = 'unknown_app';
    return new Response('Bad Request: missing or unknown ?app parameter', {
      status: 400,
      headers: corsHeaders,
    });
  }
  ctx.app = appName;

  const ingestToken = getIngestToken(appName, env);
  if (!ingestToken) {
    ctx.outcome = 'missing_token';
    return new Response('Configuration Error: no ingest token', {
      status: 500,
      headers: corsHeaders,
    });
  }

  if (!serverToServer && isBot(request.headers.get('User-Agent'))) {
    ctx.outcome = 'bot_blocked';
    return new Response('Blocked: Bot detected', {
      status: 403,
      headers: corsHeaders,
    });
  }

  const collectorHost = env.GRAFANA_COLLECTOR_HOST || 'faro-collector-prod-us-east-0.grafana.net';
  const pathSuffix = url.pathname.replace('/faro-proxy', '');
  const targetUrl = `https://${collectorHost}/collect/${ingestToken}${pathSuffix}${url.search}`;

  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(
    'X-Forwarded-For',
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || ''
  );
  forwardedHeaders.set('X-Forwarded-Proto', 'https');
  forwardedHeaders.set('Host', collectorHost);

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: forwardedHeaders,
      body: request.body,
    });
    ctx.upstream_status = upstream.status;
    ctx.outcome = upstream.ok ? 'proxied_ok' : 'upstream_error';

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control-')) {
        responseHeaders.set(key, value);
      }
    });
    for (const [key, value] of Object.entries(corsHeaders)) {
      responseHeaders.set(key, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    ctx.outcome = 'upstream_fetch_failed';
    console.error(`Upstream fetch failed for app "${appName}":`, error);
    return new Response('Bad Gateway', {
      status: 502,
      headers: corsHeaders,
    });
  }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    ctx.outcome = 'health';
    return handleHealth(env);
  }

  const serverToServer = isServerToServer(request, env);
  const origin = request.headers.get('Origin');
  const allowedSet = parseAllowedOrigins(env.ALLOWED_ORIGINS);

  if (!serverToServer && origin && !isOriginAllowed(origin, allowedSet)) {
    ctx.outcome = 'origin_denied';
    return new Response('Forbidden: Invalid origin', { status: 403 });
  }

  const corsHeaders = origin ? buildCorsHeaders(origin) : {};

  if (request.method === 'OPTIONS') {
    ctx.outcome = 'preflight';
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (url.pathname.startsWith('/faro-proxy')) {
    return handleFaroProxy(request, env, corsHeaders, ctx, serverToServer);
  }

  ctx.outcome = 'not_found';
  return new Response('Not Found', { status: 404, headers: corsHeaders });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const ctx = {
    start: Date.now(),
    method: request.method,
    path: url.pathname,
    origin: request.headers.get('Origin'),
    app: null,
    upstream_status: null,
    outcome: 'unknown',
    status: 0,
  };

  let response;
  try {
    response = await route(request, env, ctx);
  } catch (error) {
    ctx.outcome = 'proxy_exception';
    console.error('Unhandled proxy error:', error);
    response = new Response('Internal Server Error', { status: 500 });
  }

  ctx.status = response.status;
  emitTelemetry(env, ctx);
  return response;
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export {
  parseAllowedOrigins,
  isOriginAllowed,
  isBot,
  isServerToServer,
  getIngestToken,
  TOKEN_ENV_BY_APP,
  SERVER_TOKEN_HEADER,
  handleRequest,
};
