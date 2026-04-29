import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, {
  parseAllowedOrigins,
  isOriginAllowed,
  isBot,
  isServerToServer,
  getIngestToken,
  TOKEN_ENV_BY_APP,
  SERVER_TOKEN_HEADER,
  handleRequest,
} from './worker.js';

const VALID_TOKEN = 'a'.repeat(40);

function makeEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: 'https://michaellamb.dev,https://blog.michaellamb.dev,https://letterboxd.michaellamb.dev',
    GRAFANA_COLLECTOR_HOST: 'faro-collector-test.example.com',
    BLOG_INGEST_TOKEN: VALID_TOKEN,
    LETTERBOXD_INGEST_TOKEN: VALID_TOKEN,
    LANDING_INGEST_TOKEN: VALID_TOKEN,
    ...overrides,
  };
}

describe('parseAllowedOrigins', () => {
  it('returns null when env is unset or empty', () => {
    expect(parseAllowedOrigins(undefined)).toBeNull();
    expect(parseAllowedOrigins('')).toBeNull();
  });

  it('splits and normalizes to protocol+host', () => {
    const set = parseAllowedOrigins('https://a.example.com, https://b.example.com:8080');
    expect(set.has('https://a.example.com')).toBe(true);
    expect(set.has('https://b.example.com:8080')).toBe(true);
  });

  it('skips malformed entries', () => {
    const set = parseAllowedOrigins('https://a.example.com,not-a-url,,https://b.example.com');
    expect(set.size).toBe(2);
  });
});

describe('isOriginAllowed', () => {
  const allowed = parseAllowedOrigins('https://blog.michaellamb.dev');

  it('default-denies when allowlist is null', () => {
    expect(isOriginAllowed('https://blog.michaellamb.dev', null)).toBe(false);
  });

  it('default-denies when origin is absent', () => {
    expect(isOriginAllowed(null, allowed)).toBe(false);
  });

  it('accepts exact protocol+host match', () => {
    expect(isOriginAllowed('https://blog.michaellamb.dev', allowed)).toBe(true);
  });

  it('rejects substring-trick origins', () => {
    expect(isOriginAllowed('https://evil.com/blog.michaellamb.dev', allowed)).toBe(false);
    expect(isOriginAllowed('https://blog.michaellamb.dev.attacker.com', allowed)).toBe(false);
  });

  it('rejects wrong protocol', () => {
    expect(isOriginAllowed('http://blog.michaellamb.dev', allowed)).toBe(false);
  });

  it('rejects malformed origin values', () => {
    expect(isOriginAllowed('not-a-url', allowed)).toBe(false);
  });
});

describe('isBot', () => {
  it('returns false for empty UA', () => {
    expect(isBot('')).toBe(false);
    expect(isBot(null)).toBe(false);
  });

  it('matches known bot patterns case-insensitively', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('Slackbot-LinkExpanding 1.0')).toBe(true);
  });

  it('passes through real browsers', () => {
    expect(isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe(false);
  });
});

describe('getIngestToken', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns the token for a known app', () => {
    expect(getIngestToken('blog', makeEnv())).toBe(VALID_TOKEN);
  });

  it('returns null for unknown app', () => {
    expect(getIngestToken('ghost-app', makeEnv())).toBeNull();
  });

  it('returns null when env var is unset', () => {
    expect(getIngestToken('blog', makeEnv({ BLOG_INGEST_TOKEN: undefined }))).toBeNull();
  });

  it('rejects short tokens', () => {
    expect(getIngestToken('blog', makeEnv({ BLOG_INGEST_TOKEN: 'tooshort' }))).toBeNull();
  });

  it('rejects non-alphanumeric tokens', () => {
    const bad = 'a'.repeat(39) + '!';
    expect(getIngestToken('blog', makeEnv({ BLOG_INGEST_TOKEN: bad }))).toBeNull();
  });

  it('never logs the full token on validation failure', () => {
    const bad = 'BADTOKEN_WITH_SECRET_INFO_THAT_SHOULD_NOT_LEAK';
    getIngestToken('blog', makeEnv({ BLOG_INGEST_TOKEN: bad }));
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(bad);
    expect(logged).toContain('prefix');
  });
});

describe('TOKEN_ENV_BY_APP registry', () => {
  it('includes the known production apps', () => {
    expect(TOKEN_ENV_BY_APP).toHaveProperty('blog');
    expect(TOKEN_ENV_BY_APP).toHaveProperty('letterboxd-viewer');
    expect(TOKEN_ENV_BY_APP).toHaveProperty('landing');
    expect(TOKEN_ENV_BY_APP).toHaveProperty('discord-embed-builder-slash');
  });

  it('maps each app to an *_INGEST_TOKEN env var', () => {
    for (const envVar of Object.values(TOKEN_ENV_BY_APP)) {
      expect(envVar).toMatch(/_INGEST_TOKEN$/);
    }
  });
});

describe('isServerToServer', () => {
  it('returns false when the header is absent', () => {
    const req = new Request('https://example.com', { method: 'POST' });
    expect(isServerToServer(req, { SERVER_SHARED_SECRET: 'secret' })).toBe(false);
  });

  it('returns false when the env secret is unset', () => {
    const req = new Request('https://example.com', {
      method: 'POST',
      headers: { [SERVER_TOKEN_HEADER]: 'secret' },
    });
    expect(isServerToServer(req, {})).toBe(false);
  });

  it('returns false when the values do not match', () => {
    const req = new Request('https://example.com', {
      method: 'POST',
      headers: { [SERVER_TOKEN_HEADER]: 'wrong' },
    });
    expect(isServerToServer(req, { SERVER_SHARED_SECRET: 'secret' })).toBe(false);
  });

  it('returns true when the header matches the env secret', () => {
    const req = new Request('https://example.com', {
      method: 'POST',
      headers: { [SERVER_TOKEN_HEADER]: 'secret' },
    });
    expect(isServerToServer(req, { SERVER_SHARED_SECRET: 'secret' })).toBe(true);
  });
});

describe('handleRequest (integration)', () => {
  let logSpy;
  let errorSpy;
  let fetchSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  function req(path, init = {}) {
    return new Request(`https://grafana.michaellamb.dev${path}`, init);
  }

  it('responds to /health without auth', async () => {
    const res = await handleRequest(req('/health'), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.apps).toEqual(expect.arrayContaining(['blog', 'letterboxd-viewer']));
  });

  it('returns 403 for disallowed origin without CORS headers', async () => {
    const res = await handleRequest(
      req('/faro-proxy?app=blog', { method: 'POST', headers: { Origin: 'https://evil.com' } }),
      makeEnv()
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('returns 400 when ?app= is missing', async () => {
    const res = await handleRequest(
      req('/faro-proxy', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
      }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when ?app= is unknown', async () => {
    const res = await handleRequest(
      req('/faro-proxy?app=nope', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
      }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('returns 204 with CORS headers on OPTIONS preflight', async () => {
    const res = await handleRequest(
      req('/faro-proxy', {
        method: 'OPTIONS',
        headers: { Origin: 'https://blog.michaellamb.dev' },
      }),
      makeEnv()
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://blog.michaellamb.dev');
  });

  it('forwards to the collector on success', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await handleRequest(
      req('/faro-proxy?app=blog', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
        body: '{"events":[]}',
      }),
      makeEnv()
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const target = fetchSpy.mock.calls[0][0];
    expect(target).toContain('faro-collector-test.example.com');
    expect(target).toContain(`/collect/${VALID_TOKEN}`);
  });

  it('returns 502 when upstream fetch throws', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('connection reset'));
    const res = await handleRequest(
      req('/faro-proxy?app=blog', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
        body: '{}',
      }),
      makeEnv()
    );
    expect(res.status).toBe(502);
  });

  it('passes through upstream 4xx without masking it', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('bad', { status: 401 }));
    const res = await handleRequest(
      req('/faro-proxy?app=blog', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
        body: '{}',
      }),
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('blocks bot user-agents', async () => {
    const res = await handleRequest(
      req('/faro-proxy?app=blog', {
        method: 'POST',
        headers: {
          Origin: 'https://blog.michaellamb.dev',
          'User-Agent': 'Googlebot/2.1',
        },
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits one structured log line per request', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await handleRequest(
      req('/faro-proxy?app=blog', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
        body: '{}',
      }),
      makeEnv()
    );
    const structured = logSpy.mock.calls
      .map(([line]) => line)
      .filter((line) => typeof line === 'string' && line.startsWith('{'));
    expect(structured).toHaveLength(1);
    const entry = JSON.parse(structured[0]);
    expect(entry).toMatchObject({
      method: 'POST',
      app: 'blog',
      status: 200,
      outcome: 'proxied_ok',
      upstream_status: 200,
    });
    expect(typeof entry.duration_ms).toBe('number');
  });

  it('writes to Analytics Engine when binding is present', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const writeDataPoint = vi.fn();
    await handleRequest(
      req('/faro-proxy?app=blog', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
        body: '{}',
      }),
      makeEnv({ FARO_PROXY_METRICS: { writeDataPoint } })
    );
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const [datapoint] = writeDataPoint.mock.calls[0];
    expect(datapoint.indexes).toEqual(['blog']);
    expect(datapoint.blobs[0]).toBe('proxied_ok');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await handleRequest(
      req('/nope', { headers: { Origin: 'https://blog.michaellamb.dev' } }),
      makeEnv()
    );
    expect(res.status).toBe(404);
  });

  it('server-to-server bypass: forwards even with no Origin and a bot-shaped UA', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await handleRequest(
      req('/faro-proxy?app=discord-embed-builder-slash', {
        method: 'POST',
        headers: {
          'User-Agent': 'cfworker-bot',
          [SERVER_TOKEN_HEADER]: 'shared-secret',
        },
        body: '{"events":[]}',
      }),
      makeEnv({
        SERVER_SHARED_SECRET: 'shared-secret',
        EMBED_BUILDER_SLASH_INGEST_TOKEN: VALID_TOKEN,
      })
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [forwardedUrl] = fetchSpy.mock.calls[0];
    expect(forwardedUrl).toContain('faro-collector-test.example.com');
    expect(forwardedUrl).toContain(VALID_TOKEN);
  });

  it('server-to-server bypass: rejects requests without the matching token via the existing gates', async () => {
    const res = await handleRequest(
      req('/faro-proxy?app=discord-embed-builder-slash', {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
        body: '{}',
      }),
      makeEnv({
        SERVER_SHARED_SECRET: 'shared-secret',
        EMBED_BUILDER_SLASH_INGEST_TOKEN: VALID_TOKEN,
      })
    );
    expect(res.status).toBe(403);
  });

  it('server-to-server bypass: a bad token does not bypass the gates (Origin denied)', async () => {
    const res = await handleRequest(
      req('/faro-proxy?app=discord-embed-builder-slash', {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          [SERVER_TOKEN_HEADER]: 'wrong-secret',
        },
        body: '{}',
      }),
      makeEnv({
        SERVER_SHARED_SECRET: 'shared-secret',
        EMBED_BUILDER_SLASH_INGEST_TOKEN: VALID_TOKEN,
      })
    );
    expect(res.status).toBe(403);
  });

  it('server-to-server bypass: missing ingest token still fails with 500', async () => {
    const res = await handleRequest(
      req('/faro-proxy?app=discord-embed-builder-slash', {
        method: 'POST',
        headers: { [SERVER_TOKEN_HEADER]: 'shared-secret' },
        body: '{}',
      }),
      makeEnv({ SERVER_SHARED_SECRET: 'shared-secret' })
    );
    expect(res.status).toBe(500);
  });

  it('browser callers without a server token continue to work normally', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await handleRequest(
      req('/faro-proxy?app=blog', {
        method: 'POST',
        headers: { Origin: 'https://blog.michaellamb.dev' },
        body: '{}',
      }),
      makeEnv({ SERVER_SHARED_SECRET: 'shared-secret' })
    );
    expect(res.status).toBe(200);
  });
});

describe('default export', () => {
  it('exposes a fetch handler', () => {
    expect(typeof worker.fetch).toBe('function');
  });
});
