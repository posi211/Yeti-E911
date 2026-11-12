// Run with the same test database as the other tests (E911_DB_URL; default is the local test cluster on port 5499).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 't';
process.env.E911_DB_URL = process.env.E911_DB_URL || 'postgres://postgres@/e911?host=/tmp&port=5499';
process.env.MAIL_FROM = process.env.MAIL_FROM || 'alerts@example.com';
process.env.METRICS_PORT = '19396'; process.env.METRICS_TOKEN = 'secret';
const assert = require('assert'), http = require('http');
const M = require('../metrics'), L = require('../lib');
const get = (path, auth) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 19396, path, headers: auth ? { Authorization: auth } : {} }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ s: r.statusCode, b: d })); }).on('error', rej));
(async () => {
  const srv = M.start(); await new Promise(r => setTimeout(r, 200));
  assert.strictEqual((await get('/metrics')).s, 401);
  assert.strictEqual((await get('/other', 'Bearer secret')).s, 404);
  M.ok('live'); M.fail('cdr'); M.fail('cdr');
  const r = await get('/metrics', 'Bearer secret'); assert.strictEqual(r.s, 200);
  const v = n => Number((r.b.match(new RegExp('^' + n + ' (\\S+)$', 'm')) || [])[1]);
  assert.strictEqual(v('e911_db_up'), 1);
  assert.strictEqual(v('e911_cdr_poll_consecutive_failures'), 2); assert.strictEqual(v('e911_cdr_poll_failures_total'), 2);
  assert.strictEqual(v('e911_live_poll_consecutive_failures'), 0); assert.ok(v('e911_live_poll_last_success_timestamp_seconds') > 1e9);
  for (const n of ['e911_real_calls_24h', 'e911_test_calls_24h', 'e911_noelin_calls_24h', 'e911_notify_failed_24h', 'e911_last_test_call_timestamp_seconds']) assert.ok(!Number.isNaN(v(n)), n);
  console.log(r.b.split('\n').filter(l => l && !l.startsWith('#')).join('\n'));
  console.log('metrics test passed'); srv.close(); await L.pool.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
