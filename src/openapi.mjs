// OpenAPI 3.1 document for agent discovery (paid endpoints carry x-payment-info).
export function buildOpenApi(config) {
  const price = config.price ?? '$0.002';
  const pay = (desc) => ({
    price,
    protocol: 'x402',
    network: config.network ?? 'eip155:8453',
    asset: 'USDC',
    payTo: config.sellerAddress,
    description: desc,
  });
  const paidResponses = {
    200: { description: 'Data payload (JSON)' },
    400: { description: 'Present-but-invalid query parameter' },
    402: { description: 'Payment required (x402 v2, USDC on Base)' },
    502: { description: 'All upstream sources unavailable' },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Indo Data API',
      version: '1.0.0',
      description:
        'Aggregated Indonesian open data: multi-source USD/IDR reference rates (JISDOR/BI, frankfurter.dev, exchangerate-api), prayer times (Aladhan), latest earthquakes (BMKG) and city weather (BMKG DigitalForecast). All times in WIB (UTC+07:00). Paid per request in USDC on Base via x402 v2. Cached 10 minutes, keyless.',
      'x-x402-price': price,
    },
    servers: [{ url: config.publicBaseUrl ?? 'https://indo-data-api.kamajaya-agents.workers.dev' }],
    paths: {
      '/v1/kurs': {
        get: {
          operationId: 'getKurs',
          summary: 'USD/IDR reference rate, multi-source',
          description: 'One call, multiple sources: attempts JISDOR (official Bank Indonesia) first, then frankfurter.dev, then exchangerate-api open endpoint. Each rate carries its source and a WIB timestamp. Cached 10 minutes. Paid: x402 USDC on Base.',
          'x-payment-info': pay('Multi-source USD/IDR reference rate'),
          responses: paidResponses,
        },
      },
      '/v1/sholat': {
        get: {
          operationId: 'getPrayerTimes',
          summary: 'Daily prayer times for an Indonesian city',
          description: 'Imsak/Fajr/Dhuhr/Asr/Maghrib/Isha for a city (via Aladhan timingsByCity, method 20) or lat/lon fallback. City is validated; date is optional (default today, YYYY-MM-DD). All times WIB. Cached 10 minutes. Paid: x402 USDC on Base.',
          parameters: [
            { name: 'city', in: 'query', required: false, schema: { type: 'string' }, description: 'Indonesian city, e.g. Jakarta (required unless lat/lon given)' },
            { name: 'date', in: 'query', required: false, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, description: 'Date, YYYY-MM-DD (default: today)' },
            { name: 'lat', in: 'query', required: false, schema: { type: 'number' }, description: 'Latitude fallback when city is omitted (within Indonesia)' },
            { name: 'lon', in: 'query', required: false, schema: { type: 'number' }, description: 'Longitude fallback when city is omitted (within Indonesia)' },
          ],
          'x-payment-info': pay('Prayer times (Aladhan)'),
          responses: paidResponses,
        },
      },
      '/v1/gempa': {
        get: {
          operationId: 'getEarthquakes',
          summary: 'Latest BMKG earthquakes',
          description: 'Latest auto-reported quake (autogempa.json) plus the recent felt-quakes list (gempadirasakan.json) from BMKG: magnitude, wilayah, WIB time, coordinates, depth. Cached 10 minutes. Paid: x402 USDC on Base.',
          'x-payment-info': pay('BMKG latest earthquakes'),
          responses: paidResponses,
        },
      },
      '/v1/cuaca': {
        get: {
          operationId: 'getCuaca',
          summary: 'Current weather for an Indonesian city',
          description: 'BMKG DigitalForecast parsed to a description (BMKG weather code → Indonesian description), temperature and humidity in WIB; falls back to wttr.in when the BMKG dump is unavailable (source is labeled per response). Cached 10 minutes. Paid: x402 USDC on Base.',
          parameters: [
            { name: 'city', in: 'query', required: true, schema: { type: 'string' }, description: 'Indonesian city, e.g. Jakarta' },
          ],
          'x-payment-info': pay('City weather (BMKG)'),
          responses: paidResponses,
        },
      },
    },
  };
}
