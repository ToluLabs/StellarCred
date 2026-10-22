'use strict';

const http = require('node:http');
const { URL } = require('node:url');

/**
 * Public contribution score API.
 *
 * GET /api/v1/users/:id/score
 *
 * Responses expose only public data (address, score, tier, lastUpdated) and
 * respect privacy by omitting any internal or personally identifying fields.
 */

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.SCORE_CACHE_TTL_MS || 30_000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.SCORE_RATE_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.SCORE_RATE_MAX || 60);
const MAX_BODY_BYTES = 1024 * 1024;

// ----------------------------------------------------------------------------
// Score store
// ----------------------------------------------------------------------------
//
// The internal score source is pluggable so this endpoint can be wired to the
// existing contribution-score backend. By default it reads from the in-memory
// store populated by the internal endpoints.

const scoreStore = new Map();

function setScore(id, record) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('id must be a non-empty string');
  }
  const score = Number(record.score);
  if (!Number.finite(score)) {
    throw new TypeError('score must be a finite number');
  }
  scoreStore.set(id, {
    id,
    score,
    tier: tierForScore(score),
    // Privacy: the public record never contains emails, names, or addresses.
    lastUpdated: record.lastUpdated || new Date().toISOString(),
  });
  cache.delete(id);
}

function getScore(id) {
  return scoreStore.get(id) || null;
}

function tierForScore(score) {
  if (score >= 1000) return 'platinum';
  if (score >= 500) return 'gold';
  if (score >= 100) return 'silver';
  return 'bronze';
}

// ----------------------------------------------------------------------------
// Cache
// ----------------------------------------------------------------------------

const cache = new Map(); // id -> { expiresAt, payload }

function cacheGet(id) {
  const entry = cache.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(id);
    return null;
  }
  return entry.payload;
}

function cacheSet(id, payload) {
  cache.set(id, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
}

// ----------------------------------------------------------------------------
// Rate limiting
// ----------------------------------------------------------------------------

const rateBuckets = new Map(); // key -> { count, resetAt }

function clientKey(req) {
  const forwarded = req.headers['cf-connecting-ip'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(key) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - bucket.count),
    resetAt: bucket.resetAt,
  };
}

// ----------------------------------------------------------------------------
// HTTP plumbing
// ----------------------------------------------------------------------------

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(
    status,
    Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    }, extraHeaders),
  );
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf=8')));
    req.on('error', reject);
  });
}

// ----------------------------------------------------------------------------
// Route handlers
// ----------------------------------------------------------------------------

const SCORE_ROUTE_REGEX = /^\/api\/v1\/users\/([^\/]+)\/score\/?$/;

function publicScorePayload(record) {
  // Whitelist of public fields only.
  return {
    id: record.id,
    score: record.score,
    tier: record.tier,
    lastUpdated: record.lastUpdated,
  };
}

async function handleGetScore(req, res, id) {
  const limit = rateLimit(clientKey(req));
  if (!limit.allowed) {
    sendJson(res, 429, { error: 'rate_limit_exceeded' }, {
      'Retry-After': String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
      'X-RateLimit-Remaining': '0',
    });
    return;
  }

  const cached = cacheGet(id);
  if (cached) {
    sendJson(res, 200, cached, {
      'X-Cache': 'HIT',
      'X-RateLimit-Remaining': String(limit.remaining),
    });
    return { hit: true };
  }

  const record = getScore(id);
  if (!record) {
    sendJson(res, 404, { error: 'score_not_found' }, {
      'X-RateLimit-Remaining': String(limit.remaining),
    });
    return { hit: false };
  }

  const payload = publicScorePayload(record);
  cacheSet(id, payload);
  sendJson(res, 200, payload, {
    'X-Cache': 'MISS',
    'X-RateLimit-Remaining': String(limit.remaining),
  });
  return { hit: false };
}

async function handleInternalUpsert(req, res) {
  // Internal endpoint used by the contribution score pipeline to publish scores.
  // Protected by a shared secret when configured.
  const secret = process.env.INTERNAL_API_SECRET || '';
  if (secret.length > 0 && req.headers['x-api-key'] !== secret) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let body;
  try {
    const raw = await readBody(req);
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', message: err.message });
    return;
  }

  const id = typeof body.id === 'string' ? body.id : null;
  if (!id) {
    sendJson(res, 400, { error: 'id_required' });
    return;
  }

  try {
    setScore(id, body);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_score', message: err.message });
    return;
  }

  sendJson(res, 200, { ok: true });
}

// ----------------------------------------------------------------------------
// Server
// ----------------------------------------------------------------------------

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'GET') {
        const match = SCORE_ROUTE_REGEX.exec(pathname);
        if (match) {
          const id = decodeURIComponent(match[1]);
          await handleGetScore(req, res, id);
          return;
        }
      }

      if (req.method === 'POST' && pathname === '/internal/scores') {
        await handleInternalUpsert(req, res);
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Score API listening on port ${PORT}`);
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = {
  createServer,
  setScore,
  getScore,
  tierForScore,
  publicScorePayload,
  _internals: { cache, rateBuckets, scoreStore },
};
