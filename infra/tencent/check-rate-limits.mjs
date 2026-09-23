import assert from 'node:assert/strict';
const base = process.argv[2];
if (!base || new URL(base).protocol !== 'https:') throw Error('Usage: node check-rate-limits.mjs https://HOST');
async function check(path, count, options, ordinary) {
  const results = await Promise.all(Array.from({length:count}, async (_, i) => {
    const response = await fetch(base + path, {...options, headers: {...options.headers, 'X-Forwarded-For': `198.51.100.${i+1}`}, signal:AbortSignal.timeout(15000)});
    await response.text();
    if (response.status === 429) assert.equal(response.headers.get('retry-after'), '15');
    return response.status;
  }));
  console.log(path, Object.fromEntries([...new Set(results)].map(s => [s, results.filter(x=>x===s).length])));
  assert.ok(results.includes(429), 'Burst must be rate limited');
  assert.ok(results.includes(ordinary), 'Normal requests must retain application response');
  assert.ok(results.every(s => [ordinary,429].includes(s)));
}
await check('/v1/runs',100,{},401);
await check('/auth/web/login',12,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'},400);
