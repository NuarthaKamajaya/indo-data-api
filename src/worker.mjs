// Cloudflare Worker entry — Indo Data API.
// Hono + @x402/hono (x402 v2, Circle facilitator) + @x402/evm ExactEvmScheme.
// Same architecture as bsc-mint-radar branch `workers`, including the commit-8f3f34e
// payTo-in-402 wrapper (SDK omits payTo; inject it into header + body here).
import { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { buildOpenApi } from './openapi.mjs';
import {
  fetchKurs, fetchSholat, fetchGempa, fetchCuaca,
  validateSholatParams, validateCuacaParams,
} from './data.mjs';

export const workerConfig = {
  network: 'eip155:8453',
  sellerAddress: '0xAe9ad223a1D4e9ADecFd3BD8363f1b8Ea4e0d512',
  price: '$0.002',
  amount: '2000', // $0.002 in USDC (6 decimals)
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  facilitatorUrl: 'https://api.circle.com/v1/facilitator/x402',
  cacheTtlMs: 600000, // 10 minutes
  publicBaseUrl: 'https://indo-data-api.kamajaya-agents.workers.dev',
};

const PAID_PATHS = ['/v1/kurs', '/v1/sholat', '/v1/gempa', '/v1/cuaca'];

/** Simple TTL cache (10 min). Key = path + normalized query. */
function createCache(ttlMs) {
  const map = new Map();
  return {
    async get(key, loader) {
      const hit = map.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return { value: hit.value, state: 'hit' };
      const value = await loader();
      map.set(key, { value, at: Date.now() });
      if (map.size > 100) map.delete(map.keys().next().value);
      return { value, state: 'miss' };
    },
  };
}

/**
 * Build the Hono app.
 * @param {object} [config] overrides merged over workerConfig
 * @param {object} [deps] injectable for tests: fetchImpl, facilitator,
 *   bypassHeader/bypassValue
 */
export function createWorkerApp(config = {}, deps = {}) {
  const cfg = { ...workerConfig, ...config };
  const fetchImpl = deps.fetchImpl ?? fetch;

  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({
    url: cfg.facilitatorUrl,
    ...(deps.facilitatorAuth ? { createAuthHeaders: deps.facilitatorAuth } : {}),
  });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(cfg.network, new ExactEvmScheme());
  let initPromise = null;
  const ensureInit = () => {
    if (!initPromise) {
      initPromise = resourceServer.initialize();
      initPromise.catch(() => { initPromise = null; });
    }
    return initPromise;
  };

  const acceptsWire = {
    scheme: 'exact',
    network: cfg.network,
    amount: cfg.amount,
    asset: cfg.usdcAddress,
    payTo: cfg.sellerAddress,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  };
  const unpaidBody = () => ({
    contentType: 'application/json',
    body: { x402Version: 2, error: 'Payment required', accepts: [acceptsWire] },
  });
  const routeCfg = (description) => ({
    accepts: {
      scheme: 'exact',
      price: cfg.price,
      network: cfg.network,
      payTo: cfg.sellerAddress,
    },
    description,
    mimeType: 'application/json',
    unpaidResponseBody: unpaidBody,
  });
  const paymentMw = paymentMiddleware(
    {
      'GET /v1/kurs': routeCfg('Indo Data API — multi-source USD/IDR reference rate (JISDOR/frankfurter/exchangerate-api)'),
      'GET /v1/sholat': routeCfg('Indo Data API — Indonesian prayer times (Aladhan, WIB)'),
      'GET /v1/gempa': routeCfg('Indo Data API — latest BMKG earthquakes'),
      'GET /v1/cuaca': routeCfg('Indo Data API — BMKG city weather'),
    },
    resourceServer,
    undefined,
    undefined,
    deps.syncFacilitatorOnStart ?? false,
  );

  const cache = createCache(cfg.cacheTtlMs);

  const app = new Hono();

  // ---- Free routes ----
  app.get('/health', (c) => c.json({
    status: 'ok',
    version: '1.0.0',
    runtime: 'cloudflare-workers',
    paidEndpoints: PAID_PATHS,
    price: cfg.price,
    network: cfg.network,
  }));

  app.get('/openapi.json', (c) => c.json(buildOpenApi(cfg)));

  app.get('/.well-known/x402', (c) => {
    const base = c.env?.PUBLIC_ORIGIN ?? cfg.publicBaseUrl;
    const resource = (path, description) => ({
      resource: `${base}${path}`,
      method: 'GET',
      description,
      accepts: [acceptsWire],
    });
    return c.json({
      x402Version: 2,
      resources: [
        resource('/v1/kurs', 'Multi-source USD/IDR reference rate: JISDOR (Bank Indonesia), frankfurter.dev, exchangerate-api — one call, source labeled per rate, WIB timestamps'),
        resource('/v1/sholat', 'Prayer times (Imsak/Fajr/Dhuhr/Asr/Maghrib/Isha) for an Indonesian city via Aladhan; lat/lon fallback; WIB'),
        resource('/v1/gempa', 'Latest BMKG earthquakes: magnitude, wilayah, WIB time, coordinates (autogempa + gempadirasakan)'),
        resource('/v1/cuaca', 'City weather from BMKG DigitalForecast: BMKG weather code description, temperature, humidity, WIB; wttr.in fallback'),
      ],
    });
  });

  // ---- Paid routes ----
  // Validation BEFORE the payment gate: bare unpaid probe (no param) → 402 so
  // crawlers read the price; present-but-invalid param → honest 400.
  app.use('/v1/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/v1/sholat') {
      const v = validateSholatParams({
        city: c.req.query('city'), date: c.req.query('date'),
        lat: c.req.query('lat'), lon: c.req.query('lon'),
      });
      if (v.error) return c.json(v, 400);
      c.set('sholatParams', v.ok ? v : null);
    } else if (p === '/v1/cuaca') {
      const v = validateCuacaParams({ city: c.req.query('city') });
      if (v.error) return c.json(v, 400);
      c.set('cuacaParams', v.ok ? v : null);
    } else if (!PAID_PATHS.includes(p)) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (deps.bypassHeader) {
      const v = c.req.header(deps.bypassHeader);
      if (v && (!deps.bypassValue || v === deps.bypassValue)) return next();
    }
    await ensureInit();
    return paymentMw(c, next);
  });

  const cachedJson = async (c, key, loader) => {
    try {
      const { value, state } = await cache.get(key, loader);
      c.header('X-Cache', state);
      return c.json(value);
    } catch (e) {
      return c.json({ error: 'upstream_unavailable', message: e.message }, 502);
    }
  };

  app.get('/v1/kurs', (c) =>
    cachedJson(c, 'kurs', () => fetchKurs(fetchImpl)));

  app.get('/v1/sholat', (c) => {
    const v = c.get('sholatParams');
    if (!v) return c.json({ error: 'missing_params', message: 'Provide ?city=Jakarta (or ?lat=&lon=) and optionally ?date=YYYY-MM-DD' }, 400);
    const key = `sholat:${v.mode}:${v.mode === 'city' ? v.city : `${v.lat},${v.lon}`}:${v.date ?? 'today'}`;
    return cachedJson(c, key, () => fetchSholat(v, fetchImpl));
  });

  app.get('/v1/gempa', (c) =>
    cachedJson(c, 'gempa', () => fetchGempa(fetchImpl)));

  app.get('/v1/cuaca', (c) => {
    const v = c.get('cuacaParams');
    if (!v) return c.json({ error: 'missing_params', message: 'Provide ?city=Jakarta' }, 400);
    return cachedJson(c, `cuaca:${v.city}`, () => fetchCuaca(v, fetchImpl));
  });

  return app;
}

// CIRCLE_API_KEY is a Worker secret (`npx wrangler secret put CIRCLE_API_KEY`) —
// never stored in this repo.
const authFor = (apiKey) => () => ({
  verify: { Authorization: `Bearer ${apiKey}` },
  settle: { Authorization: `Bearer ${apiKey}` },
});

// Directory crawlers (PayAPI/agent402/minia2a) read payTo from the 402 JSON
// body, but the SDK payload omits it — rewrite the final 402 response here
// (bsc-mint-radar commit 8f3f34e pattern: fix both the base64url
// PAYMENT-REQUIRED header payload and the JSON body mirror).
const withPayToInBody = async (response, sellerAddress) => {
  if (!response || response.status !== 402) return response;
  try {
    const headers = new Headers(response.headers);
    const hdr = headers.get('payment-required');
    if (hdr) {
      try {
        const b64 = hdr.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (hdr.length % 4)) % 4);
        const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        let changed = false;
        for (const a of decoded?.accepts ?? []) {
          if (a.payTo !== sellerAddress) { a.payTo = sellerAddress; changed = true; }
        }
        if (changed) {
          const bin = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64');
          headers.set('payment-required', bin.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
        }
      } catch { /* header stays as-is */ }
    }
    const payload = await response.json();
    let changed = false;
    for (const a of payload?.accepts ?? []) {
      if (a.payTo !== sellerAddress) { a.payTo = sellerAddress; changed = true; }
    }
    headers.delete('content-length');
    return new Response(JSON.stringify(payload), { status: 402, headers });
  } catch {
    return response;
  }
};

export default {
  async fetch(request, env, ctx) {
    const app = createWorkerApp({
      sellerAddress: env.SELLER_ADDRESS || undefined,
      facilitatorUrl: env.FACILITATOR_URL || undefined,
      publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
    }, {
      facilitatorAuth: env.CIRCLE_API_KEY ? authFor(env.CIRCLE_API_KEY) : undefined,
    });
    const seller = env.SELLER_ADDRESS || '0xAe9ad223a1D4e9ADecFd3BD8363f1b8Ea4e0d512';
    return withPayToInBody(await app.fetch(request, env, ctx), seller);
  },
};
