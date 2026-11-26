# Indo Data API

Aggregated Indonesian open data behind an **x402 paid API** on Cloudflare Workers
(x402 v2, USDC on Base). Keyless — payment *is* the auth. Architecture mirrors
`bsc-mint-radar` branch `workers` (Hono + `@x402/hono` + Circle facilitator).

## Paid endpoints — $0.002 USDC on Base per call (`amount` = `'2000'`, 6 decimals)

| Endpoint | Data | Sources (failover order) |
|---|---|---|
| `GET /v1/kurs` | USD/IDR reference rate, multi-source in one call; per-rate `source` + WIB timestamp | JISDOR (Bank Indonesia) → frankfurter.dev → exchangerate-api open endpoint |
| `GET /v1/sholat?city=Jakarta&date=2026-11-27` | Imsak/Fajr/Dhuhr/Asr/Maghrib/Isha in WIB | api.aladhan.com `timingsByCity` (method 20); `?lat=&lon=` fallback (`/v1/timings`) |
| `GET /v1/gempa` | Latest quake (autogempa) + felt quakes: Magnitude, Wilayah, WIB time, koordinat, kedalaman | `data.bmkg.go.id/DataMKG/TEWS/autogempa.json` + `gempadirasakan.json` |
| `GET /v1/cuaca?city=Jakarta` | BMKG weather-code description, suhu, kelembapan, waktu WIB | `DigitalForecast-Indonesia.json` → fallback `wttr.in` (source labeled in response) |

## Free endpoints

- `GET /health`
- `GET /openapi.json` — OpenAPI 3.1, `x-payment-info` on all 4 paid paths
- `GET /.well-known/x402` — x402 v2 manifest (4 resources, each with `accepts[].payTo`)

## Payment semantics (x402 v2)

- Unpaid request → **402** with a base64url `PAYMENT-REQUIRED` header (authoritative)
  **and** a JSON body mirror. `payTo` is injected into **both** at the fetch level
  (`withPayToInBody`, same pattern as bsc-mint-radar commit `8f3f34e`) because the
  SDK omits it from the wire payload.
- **Bare request (no params) → 402** so directory crawlers can read the price.
  Present-but-invalid params → honest **400** (`invalid_city`, `invalid_date`, …).
- Facilitator: `https://api.circle.com/v1/facilitator/x402`; key via
  `CIRCLE_API_KEY` env/secret (sent as `Authorization: Bearer …`). Never in code.

## Rules

- **Cache:** 10-minute TTL per endpoint+query (`X-Cache: hit|miss`).
- **Failover:** every endpoint tries a secondary source; failures are labeled
  per-source in the response (`error` on a rate entry, `wttr.in` fallback note).
- **WIB everywhere:** all timestamps are explicit-offset `…+07:00` (UTC+7).
- **Keyless.** No secrets in the repo; `SELLER_ADDRESS`,
  `FACILITATOR_URL`, `PUBLIC_BASE_URL` are overridable via Worker env.

## Deploy (parent)

```bash
npm install
npx wrangler secret put CIRCLE_API_KEY
npx wrangler deploy
```

`wrangler.jsonc`: name `indo-data-api`, compatibility_date `2026-11-20`, `nodejs_compat`.

## Tests

```bash
npm test        # vitest run → 21 tests
```

Covers: unpaid→402 per endpoint (incl. bare probes, payTo in header + body,
amount `2000`), invalid→400 per endpoint, health/openapi/manifest, 10-min cache
(hit + zero extra upstream fetches), source failover (kurs, cuaca), fixture
parsing for BMKG (gempa + DigitalForecast), Aladhan, frankfurter/er-api, and
WIB formatting helpers. All upstreams mocked; no network in tests.

## Notes on sources (checked 2026-11-27)

- Live-verified from this sandbox: frankfurter.dev, open.er-api.com, api.aladhan.com,
  BMKG autogempa/gempadirasakan. JISDOR (`bi.go.id`) and
  `DigitalForecast-Indonesia.json` were **not reachable from this sandbox**
  (connection reset / 404) — both remain the configured *primary* source with the
  failover above; production should re-check reachability.
