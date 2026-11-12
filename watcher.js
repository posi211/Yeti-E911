'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ABSi Corp
// Watches the Yeti two ways and writes emergency calls to the e911 database:
//   1. LIVE: polls yeti-web active calls every few seconds -> email goes out while the call is up.
//   2. CDR : every minute reads the CDR DB for finished calls -> permanent record, catches anything live missed.
const { Pool } = require('pg');
const L = require('./lib');
const YETI_URL = (process.env.YETI_API_URL || '').replace(/\/$/, '');
const http = require('http'), https = require('https');
// Node fetch refuses port 6666 ("bad port"), so talk to the Yeti with the plain http client.
function yetiReq(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(YETI_URL + p);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout: 10000 }, res => {
      let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: d }));
    });
    req.on('timeout', () => req.destroy(new Error('yeti timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const POLL_MS = Number(process.env.LIVE_POLL_MS || 2000);
const CDR_MS = Number(process.env.CDR_POLL_MS || 60000);
const cdrPool = new Pool({ connectionString: process.env.CDR_DB_URL });

let jwt = null, patterns = [], patternsAt = 0, fails = 0, blindAlertSent = false;
const liveState = new Map();   // callId -> {init, ans, c, rec} for emergency calls currently up

async function refreshPatterns() {
  if (Date.now() - patternsAt < 30000) return;
  patterns = await L.loadPatterns();
  await L.refreshAdminEmails(true);
  patternsAt = Date.now();
}

async function yetiToken() {
  if (process.env.YETI_API_TOKEN) return process.env.YETI_API_TOKEN;
  const r = await yetiReq('POST', '/api/rest/admin/auth', { 'Content-Type': 'application/json' },
    JSON.stringify({ auth: { username: process.env.YETI_API_USER, password: process.env.YETI_API_PASS } }));
  if (!r.ok) throw new Error('yeti auth ' + r.status);
  return JSON.parse(r.text).jwt;
}

async function pollLive() {
  await refreshPatterns();
  if (!jwt) jwt = await yetiToken();
  const r = await yetiReq('GET', '/api/rest/admin/active-calls', { Authorization: jwt, Accept: 'application/vnd.api+json' });
  if (r.status === 401) { jwt = null; throw new Error('yeti 401'); }
  if (!r.ok) throw new Error('yeti active-calls ' + r.status);
  const calls = JSON.parse(r.text).data || [];
  const nowUp = new Set();
  for (const row of calls) {
    const a = row.attributes || {};
    const c = {
      callId: a['orig-call-id'] || row.id,
      src: [a['src-prefix-in'], a['src-prefix-routing'], a['src-prefix-out']],
      dstIn: a['dst-prefix-in'], dstRouting: a['dst-prefix-routing'], dstOut: a['dst-prefix-out'],
      start: a['start-time'] ? new Date(a['start-time']) : new Date(),
      connect: a['connect-time'] ? new Date(a['connect-time']) : null,
      source: 'live', raw: a,
    };
    const rec = await L.recordCall(c, patterns);
    if (rec && rec.inserted) await L.notifyCall(rec.id, c, rec);
    if (rec) {
      nowUp.add(c.callId);
      const st = liveState.get(c.callId) || {};
      if (!st.init) { await L.recordEvent(c.callId, 'call.initiated', c.start, c, rec); st.init = true; }
      if (c.connect && !st.ans) { await L.recordEvent(c.callId, 'call.answered', c.connect, c, rec); st.ans = true; }
      st.c = c; st.rec = rec; liveState.set(c.callId, st);
    }
  }
  for (const [id, st] of liveState) if (!nowUp.has(id)) {   // call left the active list = hung up (CDR later corrects the exact end time)
    await L.recordEvent(id, 'call.hangup', new Date(), st.c, st.rec);
    liveState.delete(id);
  }
}

async function pollCdr() {
  await refreshPatterns();
  const list = patterns.map(p => p.pattern);
  // Look back 6 hours every pass; recordCall is idempotent. Verify column names with:  \d cdr.cdr
  const r = await cdrPool.query(
    `SELECT orig_call_id, src_prefix_in, src_prefix_routing, src_prefix_out, dst_prefix_in, dst_prefix_routing, dst_prefix_out,
            time_start, time_connect, time_end, duration, internal_disconnect_code, internal_disconnect_reason
       FROM cdr.cdr
      WHERE time_start > now() - interval '6 hours'
        AND (dst_prefix_in = ANY($1) OR dst_prefix_routing = ANY($1) OR dst_prefix_out = ANY($1))`, [list]);
  for (const x of r.rows) {
    const c = {
      callId: x.orig_call_id, src: [x.src_prefix_in, x.src_prefix_routing, x.src_prefix_out],
      dstIn: x.dst_prefix_in, dstRouting: x.dst_prefix_routing, dstOut: x.dst_prefix_out,
      start: x.time_start, connect: x.time_connect, end: x.time_end, duration: x.duration,
      code: x.internal_disconnect_code, reason: x.internal_disconnect_reason, source: 'cdr',
    };
    const rec = await L.recordCall(c, patterns);
    if (rec && rec.inserted) await L.notifyCall(rec.id, c, rec);   // late alert: live polling missed it
    if (rec) {   // fill in / correct the event stream from the CDR
      await L.recordEvent(c.callId, 'call.initiated', c.start, c, rec);
      if (c.connect) await L.recordEvent(c.callId, 'call.answered', c.connect, c, rec);
      if (c.end) await L.recordEvent(c.callId, 'call.hangup', c.end, c, rec, true);
    }
  }
}

// If we cannot see the Yeti for a minute, tell the admins. A silent 911 watcher is worse than none.
async function liveLoop() {
  for (;;) {
    try {
      await pollLive();
      if (fails >= 30 && blindAlertSent) await L.sendMail(L.adminEmails(), '911 watcher recovered', '<p>The Yeti 911 watcher can see the Yeti again.</p>');
      fails = 0; blindAlertSent = false;
    } catch (e) {
      console.error('live', e.message, e.cause && (e.cause.code || e.cause.message));
      if (++fails === 30 && !blindAlertSent) {
        blindAlertSent = true;
        await L.sendMail(L.adminEmails(), '911 watcher CANNOT SEE THE YETI', `<p>Live polling has failed for about a minute: ${L.esc(e.message)}</p>`).catch(() => {});
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
async function cdrLoop() {
  for (;;) {
    try { await pollCdr(); } catch (e) { console.error('cdr', e.message); }
    await new Promise(r => setTimeout(r, CDR_MS));
  }
}

if (require.main === module) {
  for (const k of ['E911_DB_URL', 'CDR_DB_URL', 'YETI_API_URL', 'YETI_API_USER', 'YETI_API_PASS']) if (!process.env[k]) { console.error('Missing required setting ' + k + ' (see .env.example)'); process.exit(1); }
  liveLoop(); cdrLoop(); console.log('yeti-e911 watcher running, yeti at', YETI_URL); }
module.exports = { pollLive, pollCdr };
