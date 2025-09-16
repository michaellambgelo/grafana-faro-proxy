/**
 * Cloudflare Worker for Grafana Faro RUM Data Proxy
 * Proxies requests from michaellamb.dev domains to Grafana Cloud
 * Supports blog.michaellamb.dev (blog) and michaellamb.dev (landing page)
 */

// Default CORS headers with wildcard origin
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, x-faro-session-id',
  'Access-Control-Max-Age': '86400',
};

// New function to generate proper CORS headers
function getCorsHeaders(request) {
  // Get the Origin header from the request
  const origin = request.headers.get('Origin');
  
  // If there's an origin header and it's from localhost or your domains, use it
  if (origin && (origin.includes('localhost') || 
                 origin.includes('michaellamb.dev') ||
                 origin.includes('letterboxd.michaellamb.dev') ||
                 origin.includes('blog.michaellamb.dev'))) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, x-faro-session-id',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin', // Important when varying response based on Origin
    };
  }
  
  // Default CORS headers (wildcard)
  return CORS_HEADERS;
}

// Bot detection patterns
const BOT_USER_AGENTS = [
  'bot', 'crawler', 'spider', 'scraper', 'facebookexternalhit',
  'twitterbot', 'linkedinbot', 'whatsapp', 'telegram', 'slackbot',
  'googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'baiduspider'
];

function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some(pattern => ua.includes(pattern));
}

function isValidOrigin(origin, allowedOrigins) {
  if (!allowedOrigins) return true;
  const origins = allowedOrigins.split(',').map(o => o.trim());
  return origins.includes(origin) || origins.includes('*');
}

function getIngestTokenForApp(appName, env) {
  const tokenMap = {
    'blog': env.BLOG_INGEST_TOKEN,
    'letterboxd-viewer': env.LETTERBOXD_INGEST_TOKEN,
    'landing': env.LANDING_INGEST_TOKEN
  };
  
  return tokenMap[appName];
}

function detectAppFromRequest(request) {
  const url = new URL(request.url);
  const referer = request.headers.get('Referer');
  
  // Method 1: Check for app parameter in query string
  const appParam = url.searchParams.get('app');
  if (appParam) {
    return appParam;
  }

  // Default to landing
  return 'landing';
}

async function handleFaroProxy(request, env) {
  // Get configuration from environment variables
  const collectorHost = env.GRAFANA_COLLECTOR_HOST || 'faro-collector-prod-us-east-0.grafana.net';
  const allowedOrigins = env.ALLOWED_ORIGINS;
  
  // Detect which app this request is from and get appropriate token
  const appName = detectAppFromRequest(request);
  const ingestToken = getIngestTokenForApp(appName, env);
  
  if (!ingestToken) {
    console.error(`No ingest token found for app: ${appName}`);
    return new Response('Configuration Error: No ingest token', { 
      status: 500,
      headers: getCorsHeaders(request) 
    });
  }
  
  const collectorPath = `/collect/${ingestToken}`;

  // Validate origin
  const origin = request.headers.get('Origin');
  if (allowedOrigins && !isValidOrigin(origin, allowedOrigins)) {
    return new Response('Forbidden: Invalid origin', { 
      status: 403,
      headers: getCorsHeaders(request) 
    });
  }

  // Bot detection
  const userAgent = request.headers.get('User-Agent');
  if (isBot(userAgent)) {
    console.log('Bot detected, blocking request:', userAgent);
    return new Response('Blocked: Bot detected', { 
      status: 403,
      headers: getCorsHeaders(request) 
    });
  }

  try {
    // Parse the incoming URL to get any additional path
    const url = new URL(request.url);
    const pathSuffix = url.pathname.replace('/faro-proxy', '');
    
    // Construct the target URL
    const targetUrl = `https://${collectorHost}${collectorPath}${pathSuffix}${url.search}`;
    
    // Clone the request to modify headers
    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    // Add required headers
    modifiedRequest.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '');
    modifiedRequest.headers.set('X-Forwarded-Proto', 'https');
    
    // Set Host header to the target host
    modifiedRequest.headers.set('Host', collectorHost);

    // Optional: Add custom data enrichment
    if (request.method === 'POST') {
      // You could modify the request body here to add custom fields
      // For now, we'll pass it through unchanged
    }

    // Make the request to Grafana
    const response = await fetch(modifiedRequest);
    
    // Create the response with CORS headers
    // First, get all the original headers except CORS headers
    const responseHeaders = Object.fromEntries(response.headers.entries());
    
    // Remove any existing CORS headers to prevent duplicates
    delete responseHeaders['access-control-allow-origin'];
    delete responseHeaders['access-control-allow-methods'];
    delete responseHeaders['access-control-allow-headers'];
    delete responseHeaders['access-control-max-age'];
    delete responseHeaders['vary'];
    
    // Create the response with our CORS headers
    const modifiedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...responseHeaders,
        ...getCorsHeaders(request),
      },
    });

    console.log(`Proxied request for app "${appName}": ${request.method} ${url.pathname} -> ${response.status}`);
    return modifiedResponse;

  } catch (error) {
    console.error('Proxy error:', error);
    return new Response('Internal Server Error', { 
      status: 500,
      headers: getCorsHeaders(request) 
    });
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  
  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: getCorsHeaders(request),
    });
  }

  // Route faro-proxy requests
  if (url.pathname.startsWith('/faro-proxy')) {
    return handleFaroProxy(request, env);
  }

  // For non-proxy requests, return 404
  return new Response('Not Found', { 
    status: 404,
    headers: getCorsHeaders(request) 
  });
}

// Cloudflare Workers entry point
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};
