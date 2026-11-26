// Worker tests — vitest. Exercises the Hono app via app.request() with an
// in-memory stub facilitator (no network) and a fully mocked fetchImpl serving
// fixtures for BMKG / Aladhan / frankfurter / er-api / wttr.in.
import { describe, it, expect, vi } from 'vitest';
import { createWorkerApp, workerConfig } from '../src/worker.mjs';
import { weatherDesc, toWib, isValidCity } from '../src/data.mjs';

const SELLER = '0xAe9ad223a1D4e9ADecFd3BD8363f1b8Ea4e0d512';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function stubFacilitator() {
  return {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
      extensions: [],
    }),
    verify: async () => ({ isValid: true, payer: '0x1234567890abcdef1234567890abcdef12345678' }),
    settle: async () => ({ success: true, transaction: '0xdeadbeef', network: 'eip155:8453' }),
  };
}

// ------------------------------------------------------------------ fixtures
const FIXTURES = {
  kursFrankfurter: { amount: 1.0, base: 'USD', date: '2026-11-26', rates: { IDR: 18394 } },
  kursErApi: { result: 'success', base_code: 'USD', rates: { IDR: 18410 } },
  aladhan: {
    code: 200, status: 'OK',
    data: {
      timings: {
        Fajr: '04:03', Sunrise: '05:27', Dhuhr: '11:40', Asr: '15:05',
        Sunset: '17:53', Maghrib: '17:53', Isha: '19:08', Imsak: '03:53',
      },
    },
  },
  autogempa: {
    Infogempa: { gempa: {
      Tanggal: '26 Nov 2026', Jam: '22:40:36 WIB', DateTime: '2026-11-26T15:40:36+00:00',
      Coordinates: '-1.22,134.27', Lintang: '1.22 LS', Bujur: '134.27 BT',
      Magnitude: '4.2', Kedalaman: '14 km', Wilayah: 'Pusat gempa berada di laut 34 km utara Ransiki',
      Potensi: 'Gempa ini dirasakan untuk diteruskan pada masyarakat', Dirasakan: 'II-III Manokwari',
    } },
  },
  gempadirasakan: {
    Infogempa: { gempa: [{
      Tanggal: '25 Nov 2026', Jam: '20:28:30 WIB', DateTime: '2026-11-25T13:28:30+00:00',
      Coordinates: '-8.36,120.52', Lintang: '8.36 LS', Bujur: '120.52 BT',
      Magnitude: '3.5', Kedalaman: '5 km', Wilayah: 'Pusat gempa berada di darat 10 km barat Flores',
      Dirasakan: 'II-III Ruteng',
    }] },
  },
  digitalForecast: {
    data: {
      metadata: { source: 'BMKG', generated: '2026-11-27' },
      areas: [{
        id: '501337', description: 'Kota Administrasi Jakarta Pusat', domain: 'maritim',
        latitude: '-6.185', longitude: '106.83', timezone: '7',
        parameters: {
          weather: { description: 'Kode cuaca', rows: [{ name: '202611270900', value: ['3'] }] },
          t: { description: 'Suhu', rows: [{ name: '202611270900', value: ['31'] }] },
          hu: { description: 'Kelembapan', rows: [{ name: '202611270900', value: ['70'] }] },
        },
      }],
    },
  },
  wttr: { current_condition: [{ temp_C: '31', humidity: '72', weatherDesc: [{ value: 'Partly cloudy' }], localObsDateTime: '2026-11-27 03:41 PM' }] },
};

/** fetchImpl mock keyed by URL substring; records calls. */
function mockFetch(overrides = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const ov = Object.entries(overrides).find(([k]) => url.includes(k));
    if (ov) {
      if (ov[1] === 'throw') throw new Error('network unreachable');
      if (ov[1] === 'http503') return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => JSON.stringify(ov[1]) };
    }
    if (url.includes('frankfurter')) return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES.kursFrankfurter) };
    if (url.includes('er-api.com')) return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES.kursErApi) };
    if (url.includes('bi.go.id')) return { ok: false, status: 403, text: async () => 'captcha' }; // sandbox reality
    if (url.includes('aladhan.com')) return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES.aladhan) };
    if (url.includes('autogempa')) return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES.autogempa) };
    if (url.includes('gempadirasakan')) return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES.gempadirasakan) };
    if (url.includes('DigitalForecast')) return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES.digitalForecast) };
    if (url.includes('wttr.in')) return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES.wttr) };
    return { ok: false, status: 404, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

function makeApp(overrides = {}, extraDeps = {}) {
  return createWorkerApp(overrides, {
    fetchImpl: mockFetch(),
    facilitator: stubFacilitator(),
    bypassHeader: 'x-test-bypass',
    bypassValue: 'letmein',
    ...extraDeps,
  });
}

const bypass = { 'x-test-bypass': 'letmein' };

// Decode the base64url PAYMENT-REQUIRED header per x402 v2.
function decodePaymentHeader(res) {
  const hdr = res.headers.get('payment-required');
  expect(hdr).toBeTruthy();
  const b64 = hdr.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

describe('free routes', () => {
  it('GET /health → 200 with the four paid endpoints and price', async () => {
    const res = await makeApp().request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.paidEndpoints).toEqual(['/v1/kurs', '/v1/sholat', '/v1/gempa', '/v1/cuaca']);
    expect(body.price).toBe('$0.002');
    expect(body.network).toBe('eip155:8453');
  });

  it('GET /openapi.json → all 4 paid paths with x-payment-info (payTo + price)', async () => {
    const res = await makeApp().request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toMatch(/^3\./);
    const paths = ['/v1/kurs', '/v1/sholat', '/v1/gempa', '/v1/cuaca'];
    for (const p of paths) {
      expect(doc.paths[p]).toBeTruthy();
      expect(doc.paths[p].get['x-payment-info']).toMatchObject({
        protocol: 'x402', network: 'eip155:8453', payTo: SELLER, price: '$0.002',
      });
    }
  });

  it('GET /.well-known/x402 → manifest lists 4 resources, each accepts carries payTo + amount 2000', async () => {
    const res = await makeApp().request('/.well-known/x402');
    expect(res.status).toBe(200);
    const man = await res.json();
    expect(man.x402Version).toBe(2);
    expect(man.resources).toHaveLength(4);
    for (const r of man.resources) {
      expect(r.accepts[0]).toMatchObject({
        scheme: 'exact', network: 'eip155:8453', amount: '2000', payTo: SELLER, asset: USDC_BASE,
      });
    }
    expect(man.resources.map((r) => r.resource)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/v1\/kurs$/), expect.stringMatching(/\/v1\/gempa$/)]),
    );
  });
});

describe('unpaid → 402 (incl. bare probes); invalid params → 400', () => {
  it.each(['/v1/kurs', '/v1/gempa'])('bare unpaid GET %s → 402 with price readable in header + body', async (path) => {
    const res = await makeApp().request(path);
    expect(res.status).toBe(402);
    const decoded = decodePaymentHeader(res);
    expect(decoded.x402Version).toBe(2);
    const accept = decoded.accepts[0];
    expect(accept).toMatchObject({ scheme: 'exact', network: 'eip155:8453', amount: '2000', payTo: SELLER, asset: USDC_BASE });
    const body = await res.json();
    expect(body.accepts?.[0]?.payTo).toBe(SELLER);
    expect(body.accepts?.[0]?.amount).toBe('2000');
  });

  it('bare unpaid GET /v1/sholat (no params) → 402; present-but-invalid city → 400', async () => {
    const bare = await makeApp().request('/v1/sholat');
    expect(bare.status).toBe(402);
    expect(decodePaymentHeader(bare).accepts[0].payTo).toBe(SELLER);

    const bad = await makeApp().request('/v1/sholat?city=Atlantis');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_city');
    expect(bad.headers.get('payment-required')).toBeNull();
  });

  it('unpaid GET /v1/sholat with invalid date → 400', async () => {
    const res = await makeApp().request('/v1/sholat?city=Jakarta&date=27-11-2026');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_date');
  });

  it('bare unpaid GET /v1/cuaca → 402; invalid city → 400', async () => {
    const bare = await makeApp().request('/v1/cuaca');
    expect(bare.status).toBe(402);
    const bad = await makeApp().request('/v1/cuaca?city=Tokyo');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_city');
  });

  it('unpaid valid-params request still → 402 (gate first, params validated)', async () => {
    const res = await makeApp().request('/v1/cuaca?city=Jakarta');
    expect(res.status).toBe(402);
    expect(decodePaymentHeader(res).accepts[0].amount).toBe('2000');
  });
});

describe('paid data flows (bypass header, mocked upstreams)', () => {
  it('GET /v1/kurs → 200 with per-source rates, WIB timestamps, frankfurter primary after BI 403', async () => {
    const fetchImpl = mockFetch();
    const app = makeApp({}, { fetchImpl });
    const res = await app.request('/v1/kurs', { headers: bypass });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('miss');
    const body = await res.json();
    expect(body.base).toBe('USD');
    expect(body.timezone).toContain('UTC+07:00');
    // BI attempt recorded but failed → frankfurter becomes primary
    expect(fetchImpl.calls.some((u) => u.includes('bi.go.id'))).toBe(true);
    expect(body.primary.source).toBe('frankfurter.dev');
    expect(body.primary.usdIdrMid).toBe(18394);
    const okRates = body.rates.filter((r) => r.usdIdrMid);
    expect(okRates.length).toBeGreaterThanOrEqual(2);
    for (const r of okRates) expect(r.timestamp).toMatch(/\+07:00$/);
  });

  it('GET /v1/kurs failover → when frankfurter is down, er-api answer becomes primary', async () => {
    const fetchImpl = mockFetch({ frankfurter: 'http503' });
    const app = makeApp({}, { fetchImpl });
    const res = await app.request('/v1/kurs', { headers: bypass });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.primary.source).toBe('exchangerate-api (open endpoint)');
    expect(body.primary.usdIdrMid).toBe(18410);
    expect(body.rates.some((r) => r.source === 'frankfurter.dev' && r.error)).toBe(true);
  });

  it('GET /v1/sholat?city=Jakarta&date=… → 200 with the 6 prayer times in WIB', async () => {
    const res = await makeApp().request('/v1/sholat?city=Jakarta&date=2026-11-27', { headers: bypass });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.city).toBe('jakarta');
    expect(body.source).toContain('aladhan');
    for (const f of ['Imsak', 'Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
      expect(body.timings[f]).toMatch(/^\d{2}:\d{2} WIB$/);
    }
    expect(body.timings.Fajr).toBe('04:03 WIB');
    expect(body.timezone).toContain('UTC+07:00');
  });

  it('GET /v1/sholat lat/lon fallback → 200 via timings endpoint', async () => {
    const fetchImpl = mockFetch();
    const res = await makeApp({}, { fetchImpl }).request('/v1/sholat?lat=-6.2&lon=106.8', { headers: bypass });
    expect(res.status).toBe(200);
    expect(fetchImpl.calls[0]).toContain('/v1/timings/');
    expect((await res.json()).city).toBe('-6.2,106.8');
  });

  it('GET /v1/gempa → 200 parsing BMKG autogempa + gempadirasakan fixtures', async () => {
    const res = await makeApp().request('/v1/gempa', { headers: bypass });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toContain('BMKG');
    expect(body.terkini).toMatchObject({ magnitude: '4.2', wilayah: 'Pusat gempa berada di laut 34 km utara Ransiki', waktuWib: '22:40:36 WIB' });
    expect(body.terkini.timestamp).toMatch(/2026-11-26T22:40:36\+07:00$/);
    expect(body.terkini.koordinat.lintang).toBe('1.22 LS');
    expect(body.dirasakan).toHaveLength(1);
    expect(body.dirasakan[0].magnitude).toBe('3.5');
  });

  it('GET /v1/cuaca?city=Jakarta → 200 from BMKG DigitalForecast with weather code → description', async () => {
    const res = await makeApp().request('/v1/cuaca?city=Jakarta', { headers: bypass });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('BMKG DigitalForecast');
    expect(body.kodeCuaca).toBe(3);
    expect(body.cuaca).toBe('Berawan Tebal');
    expect(body.suhu.celcius).toBe(31);
    expect(body.kelembapan.persen).toBe(70);
    expect(body.waktuWib).toMatch(/2026-11-27T09:00:00\+07:00$/);
  });

  it('GET /v1/cuaca failover → BMKG dump unavailable → wttr.in fallback labeled as such', async () => {
    const fetchImpl = mockFetch({ DigitalForecast: 'http503' });
    const res = await makeApp({}, { fetchImpl }).request('/v1/cuaca?city=Jakarta', { headers: bypass });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toContain('wttr.in');
    expect(body.suhu.celcius).toBe(31);
    expect(body.waktuWib).toMatch(/\+07:00$/);
  });
});

describe('cache and shared behavior', () => {
  it('10-minute TTL cache: second identical call is an X-Cache hit with zero extra upstream fetches', async () => {
    const fetchImpl = mockFetch();
    const app = makeApp({}, { fetchImpl });
    await app.request('/v1/gempa', { headers: bypass });
    const n = fetchImpl.calls.length;
    expect(n).toBeGreaterThan(0);
    const res2 = await app.request('/v1/gempa', { headers: bypass });
    expect(res2.headers.get('X-Cache')).toBe('hit');
    expect(fetchImpl.calls.length).toBe(n);
    // different cache key per endpoint+query
    const res3 = await app.request('/v1/sholat?city=Bandung', { headers: bypass });
    expect(res3.headers.get('X-Cache')).toBe('miss');
  });

  it('all kurs sources dead → 502 upstream_unavailable', async () => {
    const fetchImpl = mockFetch({ 'bi.go.id': 'throw', frankfurter: 'throw', 'er-api.com': 'throw' });
    const res = await makeApp({}, { fetchImpl }).request('/v1/kurs', { headers: bypass });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('upstream_unavailable');
  });
});

describe('helpers', () => {
  it('toWib renders explicit +07:00 offset', () => {
    expect(toWib('2026-11-26T15:40:36+00:00')).toBe('2026-11-26T22:40:36+07:00');
  });
  it('weatherDesc maps BMKG codes and is total', () => {
    expect(weatherDesc(0)).toBe('Cerah');
    expect(weatherDesc(95)).toBe('Hujan Petir');
    expect(weatherDesc(9999)).toContain('9999');
  });
  it('isValidCity accepts normalized major cities, rejects others', () => {
    expect(isValidCity('Kota Bandung')).toBe(true);
    expect(isValidCity('Yogyakarta')).toBe(true);
    expect(isValidCity('Atlantis')).toBe(false);
    expect(isValidCity('')).toBe(false);
  });
});
