'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ABSi Corp
// Prometheus metrics for the watcher. Off unless METRICS_PORT is set. Plain text format, no dependencies.
const http = require('http');
const L = require('./lib');

const state = {
  started: Date.now() / 1000,
  live: { lastOk: 0, lastTry: 0, fails: 0, consecutive: 0 },
  cdr:  { lastOk: 0, lastTry: 0, fails: 0, consecutive: 0 },
};
function ok(which)   { const s = state[which]; s.lastOk = s.lastTry = Date.now() / 1000; s.consecutive = 0; }
function fail(which) { const s = state[which]; s.lastTry = Date.now() / 1000; s.fails++; s.consecutive++; }

async function dbNumbers() {
  const q = async (sql) => Number((await L.pool.query(sql)).rows[0].n || 0);
  const one = (sql) => q(sql);
  return {
    real24: await one("SELECT count(*) n FROM emergency_calls WHERE class='real' AND started_at > now() - interval '24 hours'"),
    test24: await one("SELECT count(*) n FROM emergency_calls WHERE class='test' AND started_at > now() - interval '24 hours'"),
    noelin24: await one(`SELECT count(*) n FROM emergency_calls e LEFT JOIN dids d ON d.id = e.did_id
                           WHERE e.class='real' AND e.started_at > now() - interval '24 hours'
                             AND (d.id IS NULL OR btrim(coalesce(d.elin_address1,'')) = '')`),
    // a real call whose alert email did not go out (still empty after 2 minutes, or not 'sent...')
    notifyFailed24: await one(`SELECT count(*) n FROM emergency_calls
                                WHERE class='real' AND started_at > now() - interval '24 hours'
                                  AND ((notify_status IS NULL AND created_at < now() - interval '2 minutes')
                                       OR (notify_status IS NOT NULL AND notify_status NOT LIKE 'sent%'))`),
    staffCopyFailed24: await one("SELECT count(*) n FROM emergency_calls WHERE class='real' AND started_at > now() - interval '24 hours' AND notify_status LIKE 'sent;%'"),
    lastReal: await one("SELECT coalesce(extract(epoch FROM max(started_at)),0) n FROM emergency_calls WHERE class='real'"),
    lastTest: await one("SELECT coalesce(extract(epoch FROM max(started_at)),0) n FROM emergency_calls WHERE class='test'"),
  };
}

async function render() {
  const lines = [];
  const g = (name, help, value, type = 'gauge') => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  g('e911_watcher_start_time_seconds', 'Unix time the watcher process started.', state.started);
  for (const [w, label] of [['live', 'Yeti live (active calls) poll'], ['cdr', 'CDR database poll']]) {
    const s = state[w];
    g(`e911_${w}_poll_last_success_timestamp_seconds`, `Unix time of the last successful ${label}.`, s.lastOk);
    g(`e911_${w}_poll_failures_total`, `Failed ${label}s since the watcher started.`, s.fails, 'counter');
    g(`e911_${w}_poll_consecutive_failures`, `Failed ${label}s in a row right now.`, s.consecutive);
  }
  let d = null, dbUp = 1;
  try { d = await dbNumbers(); } catch (e) { dbUp = 0; }
  g('e911_db_up', '1 if the E911 database answered the metrics queries.', dbUp);
  if (d) {
    g('e911_real_calls_24h', 'Real 911 calls recorded in the last 24 hours.', d.real24);
    g('e911_test_calls_24h', 'Test calls (933 etc) recorded in the last 24 hours.', d.test24);
    g('e911_noelin_calls_24h', 'Real 911 calls in the last 24 hours with no ELIN address on file.', d.noelin24);
    g('e911_notify_failed_24h', 'Real 911 calls in the last 24 hours whose alert email did not go out.', d.notifyFailed24);
    g('e911_staff_copy_failed_24h', 'Real 911 calls in the last 24 hours where only the staff copy failed.', d.staffCopyFailed24);
    g('e911_last_real_call_timestamp_seconds', 'Unix time of the most recent real 911 call (0 = none).', d.lastReal);
    g('e911_last_test_call_timestamp_seconds', 'Unix time of the most recent test call (0 = none).', d.lastTest);
  }
  return lines.join('\n') + '\n';
}

function start() {
  const port = Number(process.env.METRICS_PORT || 0);
  if (!port) return null;
  const bind = process.env.METRICS_BIND || '127.0.0.1';
  const token = process.env.METRICS_TOKEN || '';
  const srv = http.createServer(async (req, res) => {
    if (req.url.split('?')[0] !== '/metrics') { res.writeHead(404); return res.end('not found\n'); }
    if (token && req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('unauthorized\n'); }
    try { const body = await render(); res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }); res.end(body); }
    catch (e) { res.writeHead(500); res.end('error\n'); }
  });
  srv.listen(port, bind, () => console.log('yeti-e911 metrics on', bind + ':' + port));
  return srv;
}

module.exports = { ok, fail, render, start, state };
