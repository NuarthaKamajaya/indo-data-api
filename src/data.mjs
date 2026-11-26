// Indo Data API — Indonesia aggregated data, x402 paid API on Cloudflare Workers.
// Pure fetch/JS, Workers-compatible (no Node APIs). All times output in WIB (UTC+07:00).
// Every fetcher takes an injectable fetchImpl for tests and does failover across sources.

export const WIB = 'WIB (UTC+07:00)';

/** Format a Date/epoch/ISO string as an explicit-offset WIB ISO string. */
export function toWib(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  // UTC+07:00 fixed offset
  const wibMs = d.getTime() + 7 * 3600 * 1000;
  const s = new Date(wibMs).toISOString().replace('.000', ''); // drop millis when zero
  return s.replace('Z', '+07:00');
}

const jsonFetch = async (fetchImpl, url, timeoutMs = 15000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': 'indo-data-api/1.0' } });
    if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
};

// ---------------------------------------------------------------- kurs (IDR)
// Sources in failover order:
//  1. JISDOR — official Bank Indonesia reference rate (often geo-blocked/captcha)
//  2. frankfurter.dev (ECB-derived, USD→IDR)
//  3. open.er-api.com (exchangerate-api open endpoint)
const JISDOR_URL = (from, to) =>
  `https://www.bi.go.id/jisdor/leasing/hargadasareferensijisdor/tanggal/${from}/${to}`;

function parseJisdor(json) {
  // BI's JSON shape varies; accept the common {data:[{date, rate|kurs|jisdor}]} shape.
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : null;
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const rate = Number(last.rate ?? last.kurs ?? last.jisdor ?? last.value);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return { rate, date: String(last.date ?? last.tanggal ?? ''), source: 'JISDOR (Bank Indonesia)' };
}

export async function fetchKurs(fetchImpl = fetch, now = new Date()) {
  const d = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const iso = (x) => x.toISOString().slice(0, 10);
  const sources = [];
  const attempts = [
    {
      name: 'JISDOR (Bank Indonesia)',
      run: async () => {
        const j = await jsonFetch(fetchImpl, JISDOR_URL(iso(d), iso(now)));
        const p = parseJisdor(j);
        return p ? { mid: p.rate, note: p.date } : null;
      },
    },
    {
      name: 'frankfurter.dev',
      run: async () => {
        const j = await jsonFetch(fetchImpl, 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=IDR');
        const r = Number(j?.rates?.IDR);
        return Number.isFinite(r) && r > 0 ? { mid: r } : null;
      },
    },
    {
      name: 'exchangerate-api (open endpoint)',
      run: async () => {
        const j = await jsonFetch(fetchImpl, 'https://open.er-api.com/v6/latest/USD');
        const r = Number(j?.rates?.IDR);
        return Number.isFinite(r) && r > 0 ? { mid: r } : null;
      },
    },
  ];
  for (const a of attempts) {
    try {
      const out = await a.run();
      if (out) {
        sources.push({ source: a.name, usdIdrMid: out.mid, ...(out.note ? { date: out.note } : {}), timestamp: toWib(new Date()) });
      }
    } catch (e) {
      sources.push({ source: a.name, error: e.message });
    }
  }
  const ok = sources.filter((s) => s.usdIdrMid);
  if (ok.length === 0) {
    const err = new Error('all kurs sources failed');
    err.allSources = sources;
    throw err;
  }
  return { base: 'USD', quote: 'IDR', rates: sources, primary: ok[0], timezone: WIB, fetchedAt: toWib(new Date()) };
}

// ------------------------------------------------------------- sholat (Aladhan)
export const SHOLAT_FIELDS = ['Imsak', 'Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

// Non-exhaustive but useful city allowlist (case-insensitive match); "Kota X"/
// "X Selatan" style variants are normalized before matching.
const CITIES = [
  'jakarta', 'bandung', 'surabaya', 'medan', 'semarang', 'yogyakarta', 'makassar',
  'palembang', 'denpasar', 'bekasi', 'tangerang', 'tangerang selatan', 'depok', 'bogor',
  'malang', 'padang', 'pekanbaru', 'balikpapan', 'banjarmasin', 'manado', 'pontianak',
  'ambon', 'jayapura', 'surakarta', 'solo', 'cirebon', 'batam', 'bandar lampung',
  'kupang', 'mataram', 'banda aceh', 'serang', 'jambi', 'gorontalo', 'palu', 'kendari',
  'samarinda', 'binjai', 'tasikmalaya', 'purwokerto', 'sukabumi',
];

export function normalizeCity(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^kota\s+/, '').replace(/\s+/g, ' ');
}

export function isValidCity(raw) {
  const c = normalizeCity(raw);
  return c.length > 0 && CITIES.includes(c);
}

const isValidDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false; const [, y, mo, d] = m.map(Number); const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d; };

export function validateSholatParams(q) {
  const { city, date, lat, lon } = q;
  const hasLatLon = lat !== undefined && lon !== undefined;
  if (date !== undefined && !isValidDate(date)) {
    return { error: 'invalid_date', message: 'Provide ?date=YYYY-MM-DD (e.g. 2026-11-27)' };
  }
  if (city !== undefined && city.trim() !== '') {
    if (!isValidCity(city)) {
      return { error: 'invalid_city', message: `Unknown city "${city}". Use a major Indonesian city (e.g. Jakarta, Bandung, Surabaya) or pass ?lat=&lon= instead.` };
    }
    return { ok: true, mode: 'city', city: normalizeCity(city), date: date ?? null };
  }
  if (hasLatLon) {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || la < -11 || la > 6 || !Number.isFinite(lo) || lo < 94 || lo > 141) {
      return { error: 'invalid_coordinates', message: 'lat/lon must be within Indonesia (lat -11..6, lon 94..141)' };
    }
    return { ok: true, mode: 'latlon', lat: la, lon: lo, date: date ?? null };
  }
  return { ok: false, bare: true }; // no params → bare unpaid probe (payment gate answers 402)
}

export async function fetchSholat(validated, fetchImpl = fetch) {
  const date = validated.date ?? new Date().toISOString().slice(0, 10);
  const url = validated.mode === 'city'
    ? `https://api.aladhan.com/v1/timingsByCity/${date}?city=${encodeURIComponent(validated.city)}&country=Indonesia&method=20`
    : `https://api.aladhan.com/v1/timings/${date}?latitude=${validated.lat}&longitude=${validated.lon}&method=20`;
  const j = await jsonFetch(fetchImpl, url);
  if (Number(j?.code) !== 200 || !j?.data?.timings) throw new Error('aladhan response malformed');
  const timings = {};
  for (const f of SHOLAT_FIELDS) {
    const v = j.data.timings[f];
    if (typeof v !== 'string' || !/^\d{2}:\d{2}/.test(v)) throw new Error(`aladhan timings missing ${f}`);
    timings[f] = v.slice(0, 5) + ' WIB';
  }
  return {
    city: validated.mode === 'city' ? validated.city : `${validated.lat},${validated.lon}`,
    date,
    timings,
    timezone: WIB,
    source: 'aladhan.com (method 20, Kemenag)',
    fetchedAt: toWib(new Date()),
  };
}

// ------------------------------------------------------------- gempa (BMKG)
export async function fetchGempa(fetchImpl = fetch) {
  const [auto, dirasa] = await Promise.allSettled([
    jsonFetch(fetchImpl, 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json'),
    jsonFetch(fetchImpl, 'https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json'),
  ]);
  if (auto.status !== 'fulfilled' && dirasa.status !== 'fulfilled') {
    throw new Error('all BMKG gempa sources failed');
  }
  const norm = (g) => ({
    magnitude: g?.Magnitude ?? null,
    wilayah: g?.Wilayah ?? null,
    waktuWib: g?.Jam ?? null,
    timestamp: g?.DateTime ? toWib(g.DateTime) : null,
    koordinat: { raw: g?.Coordinates ?? null, lintang: g?.Lintang ?? null, bujur: g?.Bujur ?? null },
    kedalaman: g?.Kedalaman ?? null,
    ...(g?.Dirasakan ? { dirasakan: g.Dirasakan } : {}),
    ...(g?.Potensi ? { potensi: g.Potensi } : {}),
  });
  const out = { source: 'BMKG (data.bmkg.go.id)', timezone: WIB, fetchedAt: toWib(new Date()) };
  if (auto.status === 'fulfilled') {
    const g = auto.value?.Infogempa?.gempa;
    if (g) out.terkini = norm(g);
  }
  if (dirasa.status === 'fulfilled') {
    const arr = dirasa.value?.Infogempa?.gempa;
    const list = Array.isArray(arr) ? arr : [arr];
    if (list.length) out.dirasakan = list.filter(Boolean).map(norm);
  }
  if (!out.terkini && !out.dirasakan) throw new Error('BMKG response malformed');
  if (auto.status === 'rejected') out.autogempaError = auto.reason?.message;
  if (dirasa.status === 'rejected') out.gempadirasakanError = dirasa.reason?.message;
  return out;
}

// ------------------------------------------------------------- cuaca (BMKG)
// Primary: BMKG DigitalForecast-Indonesia.json (official open-data dump).
// Secondary: wttr.in (single-call, keyless) when the BMKG dump is unavailable.
const WEATHER_CODES = {
  0: 'Cerah', 1: 'Cerah Berawan', 2: 'Berawan', 3: 'Berawan Tebal', 4: 'Berawan Sangat Tebal',
  5: 'Hujan Ringan', 10: 'Hujan', 11: 'Hujan Lebat', 45: 'Kabut', 60: 'Hujan Ringan',
  61: 'Hujan Sedang', 63: 'Hujan Lebat', 80: 'Hujan Lokal', 95: 'Hujan Petir', 100: 'Tidak Pasti',
};
export const weatherDesc = (code) => WEATHER_CODES[Number(code)] ?? `Kode cuaca BMKG ${code}`;

const isValidCuacaCity = (raw) => isValidCity(raw);

export function validateCuacaParams(q) {
  const { city } = q;
  if (city !== undefined && city.trim() !== '') {
    if (!isValidCuacaCity(city)) {
      return { error: 'invalid_city', message: `Unknown city "${city}". Use a major Indonesian city (e.g. Jakarta, Bandung, Surabaya).` };
    }
    return { ok: true, city: normalizeCity(city) };
  }
  return { ok: false, bare: true };
}

function parseDigitalForecast(json, city) {
  const areas = json?.data?.areas;
  if (!Array.isArray(areas) || areas.length === 0) return null;
  const target = normalizeCity(city);
  const area = areas.find((a) => normalizeCity(a.description ?? a.name ?? '').includes(target))
    ?? areas.find((a) => normalizeCity(a.description ?? a.name ?? '').split(' ').some((w) => w === target));
  if (!area) return null;
  const pickLatest = (param) => {
    const rows = param?.rows;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const last = rows[rows.length - 1];
    return Array.isArray(last.value) ? last.value[0] : last.value;
  };
  const code = pickLatest(area.parameters?.weather);
  const temp = pickLatest(area.parameters?.t);
  const hum = pickLatest(area.parameters?.hu);
  const slotName = area.parameters?.weather?.rows?.[area.parameters.weather.rows.length - 1]?.name;
  if (code === null || code === undefined) return null;
  // BMKG slot names are local (WIB) timestamps like 202611271200
  const wibTime = typeof slotName === 'string' && /^\d{12}$/.test(slotName)
    ? `${slotName.slice(0, 4)}-${slotName.slice(4, 6)}-${slotName.slice(6, 8)}T${slotName.slice(8, 10)}:${slotName.slice(10, 12)}:00+07:00`
    : null;
  return {
    city: area.description ?? area.name ?? city,
    cuaca: weatherDesc(code),
    kodeCuaca: Number(code),
    suhu: temp !== null && temp !== undefined ? { celcius: Number(temp) } : null,
    kelembapan: hum !== null && hum !== undefined ? { persen: Number(hum) } : null,
    waktuWib: wibTime,
  };
}

function parseWttr(json, city) {
  const cur = json?.current_condition?.[0];
  if (!cur) return null;
  const obsUtc = cur.localObsDateTime ?? null;
  return {
    city,
    cuaca: cur.weatherDesc?.[0]?.value ?? null,
    kodeCuaca: null,
    suhu: { celcius: Number(cur.temp_C) },
    kelembapan: { persen: Number(cur.humidity) },
    waktuWib: obsUtc ? toWib(obsUtc) : toWib(new Date()),
  };
}

export async function fetchCuaca(validated, fetchImpl = fetch) {
  // Primary: BMKG DigitalForecast
  try {
    const j = await jsonFetch(fetchImpl, 'https://data.bmkg.go.id/DataMKG/MEWS/DigitalForecast/DigitalForecast-Indonesia.json');
    const p = parseDigitalForecast(j, validated.city);
    if (p) return { ...p, source: 'BMKG DigitalForecast', timezone: WIB, fetchedAt: toWib(new Date()) };
  } catch { /* fall over to secondary */ }
  // Secondary: wttr.in
  const j = await jsonFetch(fetchImpl, `https://wttr.in/${encodeURIComponent(validated.city)}?format=j1`);
  const p = parseWttr(j, validated.city);
  if (!p) throw new Error('all cuaca sources failed');
  return { ...p, source: 'wttr.in (fallback; BMKG DigitalForecast unavailable)', timezone: WIB, fetchedAt: toWib(new Date()) };
}
