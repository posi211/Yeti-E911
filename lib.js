'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ABSi Corp
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.E911_DB_URL });

const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
const callerNum = src => (src || []).map(digits).find(d => d.length >= 10) || '';

// patterns: [{pattern, class}]. Exact digit match against each number; 'real' wins over 'test'.
function classify(numbers, patterns) {
  let hit = null;
  for (const n of numbers.map(digits).filter(Boolean)) {
    for (const p of patterns) {
      if (n === p.pattern && (!hit || (p.class === 'real' && hit.class !== 'real'))) hit = { class: p.class, pattern: p.pattern };
    }
  }
  return hit;
}

async function loadPatterns(db = pool) {
  return (await db.query('SELECT pattern, class FROM patterns')).rows;
}

// Match the caller to a DID by the last 10 digits of any of the source numbers.
async function findDid(srcNumbers, db = pool) {
  for (const s of srcNumbers) {
    const d = digits(s).slice(-10);
    if (d.length !== 10) continue;
    const r = await db.query('SELECT d.*, c.name AS customer_name, c.notify_emails AS cust_emails, c.contact_email AS cust_contact, c.admin_emails AS cust_admin_emails FROM dids d JOIN customers c ON c.id = d.customer_id WHERE d.did = $1', [d]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

// Insert or merge one emergency call. Returns {id, inserted, did}.
// c: {callId, src:[...], dstIn, dstRouting, dstOut, start, connect, end, duration, code, reason, source, raw}
async function recordCall(c, patterns, db = pool) {
  const hit = classify([c.dstIn, c.dstRouting, c.dstOut], patterns);
  if (!hit) return null;
  const did = await findDid(c.src, db);
  const r = await db.query(
    `INSERT INTO emergency_calls
       (call_id,class,matched_pattern,src_number,dst_in,dst_routing,dst_out,did_id,customer_id,
        started_at,connected_at,ended_at,duration_s,disconnect_code,disconnect_reason,source,raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (call_id) DO UPDATE SET
       connected_at      = COALESCE(EXCLUDED.connected_at, emergency_calls.connected_at),
       ended_at          = COALESCE(EXCLUDED.ended_at, emergency_calls.ended_at),
       duration_s        = COALESCE(EXCLUDED.duration_s, emergency_calls.duration_s),
       disconnect_code   = COALESCE(EXCLUDED.disconnect_code, emergency_calls.disconnect_code),
       disconnect_reason = COALESCE(EXCLUDED.disconnect_reason, emergency_calls.disconnect_reason),
       source = CASE WHEN emergency_calls.source <> EXCLUDED.source THEN 'both' ELSE emergency_calls.source END
     RETURNING id, (xmax = 0) AS inserted`,
    [c.callId, hit.class, hit.pattern, callerNum(c.src) || null, c.dstIn || null, c.dstRouting || null, c.dstOut || null,
     did ? did.id : null, did ? did.customer_id : null, c.start || new Date(), c.connect || null, c.end || null,
     c.duration == null ? null : Math.round(c.duration), c.code == null ? null : c.code, c.reason || null,
     c.source, c.raw ? JSON.stringify(c.raw) : null]);
  return { id: r.rows[0].id, inserted: r.rows[0].inserted, did, hit };
}

// One row per (call, event). Initiated/answered keep the first time seen; hangup is overwritten by the CDR's real end time.
async function recordEvent(callId, type, ts, c, rec, authoritative = false, db = pool) {
  try {
    await db.query(
      `INSERT INTO call_events (call_id, event_type, ts, src_number, dst_number, class, customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (call_id, event_type) DO ${authoritative ? 'UPDATE SET ts = EXCLUDED.ts' : 'NOTHING'}`,
      [callId, type, ts || new Date(), callerNum(c.src) || null, c.dstIn || null, rec.hit.class, rec.did ? rec.did.customer_id : null]);
  } catch (e) { console.error('call_events', e.message); }   // never let event logging interrupt 911 capture
}

// ---- email via SMTP2GO HTTP API ----
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Display name used in the portal, emails and sender (BRAND_NAME in .env).
const brand = () => String(process.env.BRAND_NAME || 'Yeti-E911').replace(/[^\w .,&'-]/g, '').slice(0, 60) || 'Yeti-E911';

// to = visible recipients, bcc = hidden copies (e.g. staff the customer must not see). Returns 'sent' or the reason it was not.
async function sendMail(to, subject, html, bcc = [], opts = {}) {
  to = [...new Set(to.filter(Boolean))];
  bcc = [...new Set(bcc.filter(Boolean))].filter(e => !to.includes(e));
  if (!to.length && bcc.length) { to = bcc; bcc = []; }   // only hidden copies: they become the visible recipients
  if (!to.length) return 'no recipients';
  if (!process.env.SMTP2GO_API_KEY) return 'SMTP2GO_API_KEY not set';
  if (!process.env.MAIL_FROM) return 'MAIL_FROM not set';
  const body = { api_key: process.env.SMTP2GO_API_KEY, to, sender: `${process.env.MAIL_FROM_NAME || brand()} <${process.env.MAIL_FROM}>`, subject, html_body: html };
  if (bcc.length) body.bcc = bcc;
  if (opts.urgent) body.custom_headers = [{ header: 'X-Priority', value: '1' }, { header: 'Importance', value: 'High' }];
  const res = await fetch('https://api.smtp2go.com/v3/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
  const failed = j && j.data && Number(j.data.failed) > 0;
  return res.ok && !failed ? 'sent' : 'error ' + res.status + ' ' + text.slice(0, 200);
}

// Staff addresses = ADMIN_EMAILS from .env plus the list managed in the portal (settings table). Never sent to customers.
const envAdmins = () => (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
let storedAdmins = [], storedAt = 0;
async function refreshAdminEmails(force = false, db = pool) {
  if (!force && Date.now() - storedAt < 30000) return;
  try { const r = await db.query("SELECT value FROM settings WHERE key='admin_emails'"); storedAdmins = r.rows[0] ? r.rows[0].value : []; }
  catch (e) { storedAdmins = []; }   // table not created yet: fall back to .env only
  storedAt = Date.now();
}
const adminEmails = () => [...new Set([...envAdmins(), ...storedAdmins])];
const storedAdminEmails = () => [...storedAdmins];

// Who gets a call alert. Customer addresses get one email; staff (global list + this customer's internal list) get a SEPARATE email.
// The two are never mixed: no staff address appears in anything a customer receives.
const noElin = did => !did || !String(did.elin_address1 || '').trim();   // caller unknown, or number loaded without an ELIN address

function recipientsFor(did, isReal) {
  const staff = [...adminEmails(), ...(did ? did.cust_admin_emails || [] : [])];
  if (!isReal) return { to: [], staff: adminEmails(), unknown: !did };
  const customer = did ? [...(did.cust_emails || []), ...(did.notify_emails || []), ...(noElin(did) && did.cust_contact ? [did.cust_contact] : [])] : [];   // contact email always gets a NO ELIN alert
  return { to: [...new Set(customer)], staff: [...new Set(staff)].filter(e => !customer.includes(e)), unknown: !did };
}

// Two emails: customer copy, then the staff copy (clearly labelled, says who the customer was emailed). Returns {status, staffStatus}.
async function sendAlert(rcp, subject, html, opts = {}) {
  let status = null, staffStatus = null;
  if (rcp.unknown && !rcp.to.length) {   // caller not in the ELIN list: nobody on the customer side to tell, so this is the primary alert to staff
    if (rcp.staff.length) staffStatus = await sendMail(rcp.staff, subject, opts.staffHtml || html, [], opts);
    return { status, staffStatus };
  }
  if (rcp.to.length) status = await sendMail(rcp.to, subject, html, [], opts);
  if (rcp.staff.length) {
    const note = `<div style="font-family:Arial,sans-serif;font-size:13px;background:#eef;padding:6px 10px;margin:0 0 8px;max-width:560px">Staff copy. Customer was emailed at: ${esc(rcp.to.join(', ') || 'NO customer addresses on file')}</div>`;
    staffStatus = await sendMail(rcp.staff, '[Staff copy] ' + subject, note + (opts.staffHtml || html), [], opts);
  }
  return { status, staffStatus };
}

// Time shown in the alert, in the portal's alert time zone (ALERT_TZ, default US Eastern), e.g. 11/09/2026 05:05:34 EST
function fmtTime(d, tz = process.env.ALERT_TZ || 'America/New_York') {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  const p = Object.fromEntries(f.formatToParts(d || new Date()).map(x => [x.type, x.value]));
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
}
const upper = v => String(v == null ? '' : v).toUpperCase();

function alertSubject({ isReal, pattern, did, c, sample }) {
  const who = did ? (did.facility || did.customer_name) : 'UNKNOWN CALLER';
  const base = noElin(did) ? (isReal ? `⚠ URGENT: 911 Call - NO ELIN MATCH${did ? ' from ' + upper(who) : ''} (${callerNum(c.src)})` : `TEST CALL (${pattern})${did ? ' from ' + upper(who) : ''} - NO ELIN MATCH (${callerNum(c.src)})`)
    : isReal ? `🚨 EMERGENCY 911 CALL from ${upper(who)} (${callerNum(c.src)})` : `TEST CALL (${pattern}) from ${upper(who)} (${callerNum(c.src)})`;
  return sample ? 'TEST: SAMPLE — ' + base : base;
}

function alertHtml({ isReal, label, late = '', did, c, sample, staff = false }) {
  const red = '#e00', col = isReal ? red : '#6b7280';
  const caller = callerNum(c.src), dialed = c.dstIn || '';
  const row = (k, v, bg) => `<tr><td style="padding:10px 14px;text-align:right;font-weight:bold;color:#333;width:190px;vertical-align:middle">${k}</td><td style="padding:10px 14px;${bg ? 'background:#fffbdb;' : ''}vertical-align:middle">${v}</td></tr>`;
  const hasElin = !noElin(did);
  const street = hasElin ? esc(did.elin_address1) : '';
  const cityLine = hasElin ? esc([did.city, [did.state, did.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')) : '';
  const addr = hasElin ? `<div style="font-weight:bold;color:#111">${street}</div><div style="color:#333">${cityLine}</div>` : '<div style="font-weight:bold;color:#111">Address not on file</div>';
  const unit = hasElin && did.elin_address2 ? row('Unit / Room:', `<b>${esc(did.elin_address2)}</b>`) : '';
  const fee = Number(process.env.NO_ELIN_FEE || 0);
  const noElinRow = hasElin ? '' : `<tr><td style="padding:10px 14px;text-align:right;font-weight:bold;color:#c00;width:190px;vertical-align:middle">⚠ ELIN Status:</td><td style="padding:10px 14px;background:#fde8e8;color:#c00;font-weight:bold;vertical-align:middle">NO ELIN MATCH &mdash; ${did ? 'This number has no ELIN address on file.' : 'Caller ID not found in the ELIN database.'} The dispatchable address above may be incomplete or incorrect. Verify the caller location immediately.${isReal ? `<div style="margin-top:6px;font-weight:normal;color:#900">${staff ? `${fee > 0 ? `Each 911 call without an ELIN on file is charged $${fee}. ` : ''}Add this number to the ELIN list so the next call is matched.` : `Please send ${esc(brand())} the dispatchable address (street, suite/room, city, state, ZIP) for this number so that future calls are matched.`}</div>` : '<div style="margin-top:6px;font-weight:normal;color:#900">This was only a test, but a real 911 call from this number would have no address on file.</div>'}</td></tr>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;border:3px solid ${col};padding:22px 26px;max-width:640px;background:#fff;color:#111">
    ${sample ? '<div style="background:#ffe9a8;color:#101c2e;padding:8px 12px;margin:0 0 14px;font-weight:bold;font-size:14px">SAMPLE ONLY &mdash; this is a test of the alert email. No emergency call was made.</div>' : ''}
    <div style="font-size:26px;font-weight:bold;color:${col};line-height:1.2">${isReal ? '🚨 CRITICAL EMERGENCY ALERT: ' + esc(dialed || '911') + ' DIALED' : '🧪 TEST CALL: ' + esc(dialed) + ' DIALED'}</div>
    <div style="font-size:15px;margin:4px 0 12px;color:#222">${isReal ? 'An emergency service call has been detected on your network.' : 'This was a test call. No emergency response is expected.'}${late ? ' <span style="color:#666">(late alert: found in the call record after the call)</span>' : ''}</div>
    <hr style="border:0;border-top:2px solid #bbb;margin:0">
    <table cellpadding="0" cellspacing="0" style="width:100%;font-size:15px;border-collapse:collapse">
      ${row('Time:', esc(fmtTime(c.start)))}
      ${row('Facility Name:', `<b style="color:${col}">${esc(upper(did ? did.facility || did.customer_name : 'UNKNOWN CALLER'))}</b>`)}
      ${row('Caller ID (From):', `<b style="color:#1d4ed8">${esc(caller)}</b>`)}
      ${row('Number Dialed (To):', esc(dialed))}
      ${row('Dispatchable Address:', addr, true)}
      ${unit}
      ${noElinRow}
    </table>
    <hr style="border:0;border-top:2px solid #bbb;margin:0 0 10px">
    <div style="font-size:12px;color:#777">Automated alert generated by ${esc(brand())} &mdash; E911 Monitoring System<br><span style="font-size:11px">Call ID: ${esc(c.callId)}</span></div></div>`;
}

async function notifyCall(id, c, rec, db = pool) {
  await refreshAdminEmails();
  const did = rec.did;
  const isReal = rec.hit.class === 'real';
  if (!isReal && process.env.NOTIFY_TEST !== '1') return;
  const rcp = recipientsFor(did, isReal);
  const late = c.source === 'cdr' ? ' (late: found in CDR after the call)' : '';
  const label = isReal ? '911 CALL' : 'TEST CALL (' + rec.hit.pattern + ')';
  const r = await sendAlert(rcp, alertSubject({ isReal, pattern: rec.hit.pattern, did, c }), alertHtml({ isReal, label, late, did, c }), { urgent: isReal && noElin(did), staffHtml: alertHtml({ isReal, label, late, did, c, staff: true }) });
  let status = r.status || r.staffStatus || 'no recipients';   // what the customer email did (or the staff email, if no customer addresses exist)
  if (r.status === 'sent' && r.staffStatus && r.staffStatus !== 'sent') status = 'sent; staff copy: ' + r.staffStatus;
  await db.query('UPDATE emergency_calls SET notified_at = now(), notify_status = $2 WHERE id = $1', [id, status]);
  if (status !== 'sent') console.error('notify', id, status);
}

// ---- passwords and session tokens (no extra dependencies) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
const secret = () => process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET not set'); })();
function makeToken(userId, hours = 12) {
  const body = userId + '.' + (Date.now() + hours * 3600e3);
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('hex');
}
function readToken(tok) {
  const p = String(tok || '').split('.');
  if (p.length !== 3) return null;
  const good = crypto.createHmac('sha256', secret()).update(p[0] + '.' + p[1]).digest('hex');
  if (p[2].length !== good.length || !crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(good))) return null;
  return Date.now() < Number(p[1]) ? Number(p[0]) : null;
}

module.exports = { pool, brand, digits, classify, loadPatterns, findDid, recordCall, recordEvent, recipientsFor, noElin, sendAlert, alertHtml, alertSubject, fmtTime, refreshAdminEmails, storedAdminEmails, envAdmins, notifyCall, sendMail, adminEmails, esc, hashPassword, checkPassword, makeToken, readToken };
