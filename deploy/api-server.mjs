#!/usr/bin/env node
/**
 * Self-hosted API server for World Monitor APAC fork.
 *
 * Reuses the same Vercel Edge Function handlers (Web Standard Request/Response)
 * by dynamically importing them and bridging Node.js HTTP ↔ Web API.
 *
 * Based on the desktop sidecar pattern (src-tauri/sidecar/local-api-server.mjs)
 * but adapted for headless server deployment behind Nginx + Cloudflare Tunnel.
 *
 * Usage:
 *   NODE_ENV=production PORT=3001 node deploy/api-server.mjs
 *
 * Environment variables (loaded from .env via EnvironmentFile in systemd):
 *   PORT                     — HTTP listen port (default 3001)
 *   UPSTASH_REDIS_REST_URL   — Upstash Redis REST URL
 *   UPSTASH_REDIS_REST_TOKEN — Upstash Redis REST token
 *   WS_RELAY_URL             — AIS relay URL (e.g. http://localhost:3004)
 *   RELAY_SHARED_SECRET      — Shared secret for relay auth
 *   GROQ_API_KEY             — Groq LLM key (for AI summary)
 *   FINNHUB_API_KEY          — Finnhub market data
 *   FRED_API_KEY             — Federal Reserve data
 *   EIA_API_KEY              — Energy data
 *   ACLED_ACCESS_TOKEN       — Conflict data
 *   AISSTREAM_API_KEY        — AIS ship tracking
 */

import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3001);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

// ── IPv4 fetch monkey-patch ─────────────────────────────────────────────
// Node.js built-in fetch tries IPv6 first; many upstream APIs have broken
// IPv6 causing ETIMEDOUT. Force IPv4 for all outbound requests.
const _originalFetch = globalThis.fetch;

function normalizeBody(body) {
  if (body == null) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return body;
}

globalThis.fetch = async function ipv4Fetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === 'string' ? input : input.url);
  } catch {
    return _originalFetch(input, init);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return _originalFetch(input, init);
  }

  const isRequest = input && typeof input === 'object' && 'url' in input;
  const mod = url.protocol === 'https:' ? https : http;
  const method = init?.method || (isRequest ? input.method : 'GET');

  let body = null;
  if (method !== 'GET' && method !== 'HEAD') {
    if (init?.body != null) {
      body = normalizeBody(init.body);
    } else if (isRequest && input.body) {
      const clone = typeof input.clone === 'function' ? input.clone() : input;
      body = normalizeBody(await clone.arrayBuffer());
    }
  }

  const headers = {};
  const rawHeaders = init?.headers || (isRequest ? input.headers : null);
  if (rawHeaders) {
    const h = rawHeaders instanceof Headers
      ? Object.fromEntries(rawHeaders.entries())
      : Array.isArray(rawHeaders)
        ? Object.fromEntries(rawHeaders)
        : rawHeaders;
    Object.assign(headers, h);
  }

  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      family: 4,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v) responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
        const status = Number.isInteger(res.statusCode) ? res.statusCode : 500;
        const responseBody = (status === 204 || status === 205 || status === 304) ? null : buf;
        try {
          resolve(new Response(responseBody, { status, statusText: res.statusMessage, headers: responseHeaders }));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (init?.signal) {
      init.signal.addEventListener('abort', () => req.destroy());
    }
    if (body != null) req.write(body);
    req.end();
  });
};

// ── CORS ────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  /^https:\/\/(.*\.)?cooperation\.tw$/,
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server
  return ALLOWED_ORIGINS.some(p => p.test(origin));
}

function getCorsHeaders(origin) {
  const allowedOrigin = (origin && isAllowedOrigin(origin)) ? origin : 'https://cooperation.tw';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ── Route table builder ─────────────────────────────────────────────────
function isBracketSegment(s) {
  return s.startsWith('[') && s.endsWith(']');
}

function routePriority(routePath) {
  return routePath.split('/').filter(Boolean).reduce((score, part) => {
    if (part.startsWith('[[...') && part.endsWith(']]')) return score;
    if (part.startsWith('[...') && part.endsWith(']')) return score + 1;
    if (isBracketSegment(part)) return score + 2;
    return score + 10;
  }, 0);
}

function matchRoute(routePath, pathname) {
  const routeParts = routePath.split('/').filter(Boolean);
  const pathParts = pathname.replace(/^\/api/, '').split('/').filter(Boolean);
  let i = 0, j = 0;
  while (i < routeParts.length && j < pathParts.length) {
    const rp = routeParts[i];
    if (rp.startsWith('[[...') || rp.startsWith('[...')) return true;
    if (isBracketSegment(rp)) { i++; j++; continue; }
    if (rp !== pathParts[j]) return false;
    i++; j++;
  }
  if (i === routeParts.length && j === pathParts.length) return true;
  if (i === routeParts.length - 1) {
    const tail = routeParts[i];
    if (tail?.startsWith('[[...')) return true;
    if (tail?.startsWith('[...')) return j < pathParts.length;
  }
  return false;
}

async function buildRouteTable(apiDir) {
  if (!existsSync(apiDir)) return [];
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.ts')) continue;
      if (entry.name.startsWith('_')) continue;
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.mjs') || entry.name.endsWith('.test.ts')) continue;
      const relative = path.relative(apiDir, absolute).replace(/\\/g, '/');
      const routePath = relative.replace(/\.(js|ts)$/, '').replace(/\/index$/, '');
      files.push({ routePath, modulePath: absolute });
    }
  }

  await walk(apiDir);
  files.sort((a, b) => routePriority(b.routePath) - routePriority(a.routePath));
  return files;
}

// ── Module loader ───────────────────────────────────────────────────────
const moduleCache = new Map();
const failedImports = new Set();

function pickModule(pathname, routes) {
  for (const candidate of routes) {
    if (matchRoute(candidate.routePath, pathname)) {
      return candidate.modulePath;
    }
  }
  return null;
}

async function importHandler(modulePath) {
  if (failedImports.has(modulePath)) {
    throw new Error(`cached-failure:${path.basename(modulePath)}`);
  }
  const cached = moduleCache.get(modulePath);
  if (cached) return cached;
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    moduleCache.set(modulePath, mod);
    return mod;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      failedImports.add(modulePath);
    }
    throw error;
  }
}

// ── Node.js HTTP → Web API bridge ───────────────────────────────────────
function nodeHeadersToWebHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (key.toLowerCase() === 'host') continue;
    if (Array.isArray(value)) {
      value.forEach(v => headers.append(key, v));
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

async function readNodeBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

// ── Request handler ─────────────────────────────────────────────────────
async function handleRequest(req, res, routes) {
  const requestUrl = new URL(req.url || '/', `http://${BIND_HOST}:${PORT}`);
  const origin = req.headers.origin || '';
  const corsHeaders = getCorsHeaders(origin);
  const start = Date.now();

  // Health check
  if (requestUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      routes: routes.length,
    }));
    return;
  }

  // Only serve /api/* paths
  if (!requestUrl.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Origin check
  if (origin && !isAllowedOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  // Find handler
  const modulePath = pickModule(requestUrl.pathname, routes);
  if (!modulePath || !existsSync(modulePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'No handler for this endpoint', endpoint: requestUrl.pathname }));
    return;
  }

  try {
    const mod = await importHandler(modulePath);
    if (typeof mod.default !== 'function') {
      console.error(`[api] invalid handler module: ${modulePath}`);
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Invalid handler module' }));
      return;
    }

    // Bridge: Node HTTP request → Web Standard Request
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readNodeBody(req);
    const webHeaders = nodeHeadersToWebHeaders(req.headers);
    // Set origin to cooperation.tw so gateway CORS checks pass
    if (!webHeaders.has('origin')) {
      webHeaders.set('origin', 'https://cooperation.tw');
    }
    const webRequest = new Request(requestUrl.toString(), {
      method: req.method,
      headers: webHeaders,
      body,
    });

    // Execute the Vercel Edge Function handler
    const webResponse = await mod.default(webRequest);

    if (!(webResponse instanceof Response)) {
      console.error(`[api] handler returned non-Response for ${requestUrl.pathname}`);
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Handler returned invalid response' }));
      return;
    }

    // Bridge: Web Standard Response → Node HTTP response
    const responseHeaders = {};
    webResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    // Remove gateway's lowercase CORS headers, then apply ours
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase().startsWith('access-control-') || key.toLowerCase() === 'vary') {
        delete responseHeaders[key];
      }
    }
    Object.assign(responseHeaders, corsHeaders);

    const responseBody = Buffer.from(await webResponse.arrayBuffer());
    const duration = Date.now() - start;

    // Log slow requests
    if (duration > 5000) {
      console.warn(`[api] slow: ${req.method} ${requestUrl.pathname} ${webResponse.status} ${duration}ms`);
    }

    res.writeHead(webResponse.status, responseHeaders);
    res.end(responseBody);
  } catch (error) {
    const duration = Date.now() - start;
    const reason = error.code === 'ERR_MODULE_NOT_FOUND'
      ? `missing dependency: ${error.message}`
      : error.message;
    console.error(`[api] error: ${req.method} ${requestUrl.pathname} → ${reason} (${duration}ms)`);

    res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({
      error: 'Handler error',
      reason: process.env.NODE_ENV === 'production' ? 'internal error' : reason,
    }));
  }
}

// ── Server startup ──────────────────────────────────────────────────────
async function main() {
  console.log('[api-server] starting...');
  console.log(`[api-server] project root: ${PROJECT_ROOT}`);

  const apiDir = path.join(PROJECT_ROOT, 'api');
  const routes = await buildRouteTable(apiDir);
  console.log(`[api-server] discovered ${routes.length} route handlers`);

  // Log first few routes for debugging
  for (const r of routes.slice(0, 5)) {
    console.log(`  → ${r.routePath}`);
  }
  if (routes.length > 5) {
    console.log(`  ... and ${routes.length - 5} more`);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, routes).catch((err) => {
      console.error('[api-server] fatal error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`[api-server] ${signal} received, shutting down...`);
    server.close(() => {
      console.log('[api-server] server closed');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, BIND_HOST, () => {
    console.log(`[api-server] listening on http://${BIND_HOST}:${PORT}`);
    console.log(`[api-server] health check: http://${BIND_HOST}:${PORT}/health`);
  });
}

main().catch((err) => {
  console.error('[api-server] startup failed:', err);
  process.exit(1);
});
