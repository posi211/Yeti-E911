'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ABSi Corp
const express = require('express');
const path = require('path');
const L = require('./lib');
const { pool } = L;
const ExcelJS = require('exceljs');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/csv', limit: '5mb' }));
app.use(express.raw({ type: XLSX_MIME, limit: '10mb' }));

// ---- auth ----
const cookie = (req, n) => (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(p => p[0] === n)?.[1];
app.use(async (req, res, next) => {
  const id = L.readToken(cookie(req, 'e911'));
  if (id) req.user = (await pool.query('SELECT id, username, role, customer_id FROM users WHERE id=$1 AND active', [id])).rows[0];
  if (req.user && req.user.role === 'admin' && req.headers['x-e911-internal'] !== '1') req.user = undefined;   // admins only via the internal address
  next();
});
const need = role => (req, res, next) => (!req.user ? res.status(401).json({ error: 'login' })
  : role === 'admin' && req.user.role !== 'admin' ? res.status(403).json({ error: 'admin only' }) : next());
const wrap = f => (req, res) => f(req, res).catch(e => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'server error' }); });

const clientIp = req => String(req.headers['cf-connecting-ip'] || req.ip || '').slice(0, 64);
const logLogin = (req, username, role, success) =>
  pool.query('INSERT INTO login_log(username, role, success, ip) VALUES ($1,$2,$3,$4)', [String(username).slice(0, 120), role || null, success, clientIp(req)]).catch(e => console.error('login_log', e.message));
const attempts = new Map();   // naive login throttle: 8 tries / 10 min / ip+user
app.post('/api/login', wrap(async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const k = req.ip + '|' + username, a = (attempts.get(k) || []).filter(t => Date.now() - t < 600e3);
  if (a.length >= 8) { logLogin(req, username, null, false); return res.status(429).json({ error: 'too many attempts' }); }
  const u = (await pool.query('SELECT * FROM users WHERE username=$1 AND active', [username])).rows[0];
  if (u && u.role === 'admin' && req.headers['x-e911-internal'] !== '1') { logLogin(req, username, 'admin', false); return res.status(403).json({ error: 'admin login is internal only' }); }
  if (!u || !L.checkPassword(password, u.pass_hash)) { a.push(Date.now()); attempts.set(k, a); logLogin(req, username, u && u.role, false); return res.status(401).json({ error: 'bad login' }); }
  logLogin(req, username, u.role, true);
  res.setHeader('Set-Cookie', `e911=${L.makeToken(u.id)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'e911=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', need(), (req, res) => res.json(req.user));

// ---- Excel helpers ----
const cellText = v => v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object'
  ? String(v.text || v.result || (v.richText ? v.richText.map(t => t.text).join('') : '') || '') : String(v);
async function toXlsx(res, filename, sheet, rows, cols) {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(sheet);
  ws.columns = cols.map(c => ({ header: c, key: c, width: Math.max(14, c.length + 4) }));
  ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(cols.map(c => { const v = r[c]; return v instanceof Date ? v : v == null ? '' : v; }));
  res.setHeader('Content-Type', XLSX_MIME); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(Buffer.from(await wb.xlsx.writeBuffer()));
}
async function tableFromBody(req) {   // .xlsx upload or CSV text -> array of rows (array of strings)
  let rows;
  if (Buffer.isBuffer(req.body)) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.body); } catch (e) { throw Object.assign(new Error('not a valid Excel (.xlsx) file'), { status: 400 }); }
    const ws = wb.worksheets[0]; rows = [];
    if (ws) ws.eachRow({ includeEmpty: false }, row => { const v = []; for (let i = 1; i <= ws.columnCount; i++) v.push(cellText(row.getCell(i).value)); rows.push(v); });
  } else rows = parseCsv(String(req.body || '').replace(/^﻿/, ''));
  rows = rows.filter(r => r.some(x => String(x).trim()));
  if (!rows.length) throw Object.assign(new Error('file is empty or not a CSV/Excel file'), { status: 400 });
  return rows;
}

// ---- calls (customers only ever see their own) ----
function callsQuery(req) {
  const w = [], p = [];
  if (req.user.role !== 'admin') { p.push(req.user.customer_id); w.push(`e.customer_id = $${p.length}`); }
  else if (req.query.customer) { p.push(Number(req.query.customer)); w.push(`e.customer_id = $${p.length}`); }
  if (req.query.class === 'real' || req.query.class === 'test') { p.push(req.query.class); w.push(`e.class = $${p.length}`); }
  if (req.query.noelin === '1') w.push("e.class = 'real' AND COALESCE(trim(d.elin_address1),'') = ''");
  if (req.query.from) { p.push(req.query.from); w.push(`e.started_at >= $${p.length}`); }
  if (req.query.to) { p.push(req.query.to); w.push(`e.started_at < $${p.length}::date + 1`); }
  if (req.query.q) { p.push('%' + req.query.q + '%'); w.push(`(e.src_number ILIKE $${p.length} OR d.facility ILIKE $${p.length} OR d.elin_address1 ILIKE $${p.length} OR e.call_id ILIKE $${p.length})`); }
  const lim = Math.min(Number(req.query.limit) || 500, 20000);
  return [`SELECT e.id, e.started_at, e.class, e.matched_pattern, e.src_number, e.dst_in, e.duration_s, e.ended_at,
                  e.disconnect_code, e.disconnect_reason, e.source, e.notified_at, ${req.user.role === 'admin' ? 'e.notify_status' : "CASE WHEN e.notify_status LIKE 'sent%' THEN 'sent' WHEN e.notify_status IS NULL THEN NULL ELSE 'failed' END AS notify_status"}, e.call_id,
                  c.name AS customer, d.facility, d.elin_address1, d.elin_address2, d.city, d.state, d.zip
             FROM emergency_calls e LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN dids d ON d.id = e.did_id
            ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.started_at DESC LIMIT ${lim}`, p];
}
app.get('/api/calls', need(), wrap(async (req, res) => res.json((await pool.query(...callsQuery(req))).rows)));

const csvCell = v => { v = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCsv = (rows, cols) => [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
const CALL_COLS = ['started_at', 'class', 'customer', 'facility', 'src_number', 'dst_in', 'elin_address1', 'elin_address2', 'city', 'state', 'zip', 'duration_s', 'disconnect_code', 'notified_at', 'call_id'];
app.get('/api/calls.csv', need(), wrap(async (req, res) => {
  res.type('text/csv').attachment('emergency-calls.csv').send(toCsv((await pool.query(...callsQuery(req))).rows, CALL_COLS));
}));
app.get('/api/calls.xlsx', need(), wrap(async (req, res) => toXlsx(res, 'emergency-calls.xlsx', 'Calls', (await pool.query(...callsQuery(req))).rows, CALL_COLS)));

// ---- DID / ELIN list ----
const DID_COLS = ['did', 'customer', 'facility', 'elin_address1', 'elin_address2', 'city', 'state', 'zip', 'notes', 'notify_emails'];
const emailList = v => (Array.isArray(v) ? v : String(v || '').split(/[,\s;]+/)).map(x => String(x).trim()).filter(Boolean);
async function didRows(req) {
  const p = [], w = [];
  if (req.user.role !== 'admin') { p.push(req.user.customer_id); w.push('d.customer_id = $1'); }
  return (await pool.query(`SELECT d.id, d.did, d.customer_id, c.name AS customer, d.facility, d.elin_address1, d.elin_address2, d.city, d.state, d.zip, d.notes, array_to_string(d.notify_emails, ';') AS notify_emails
      FROM dids d JOIN customers c ON c.id = d.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY c.name, d.did`, p)).rows;
}
app.get('/api/dids', need(), wrap(async (req, res) => res.json(await didRows(req))));
app.get('/api/dids.csv', need(), wrap(async (req, res) => res.type('text/csv').attachment('did-elin-list.csv').send(toCsv(await didRows(req), DID_COLS))));
app.get('/api/dids.xlsx', need(), wrap(async (req, res) => toXlsx(res, 'did-elin-list.xlsx', 'ELIN', await didRows(req), DID_COLS)));

const cleanDid = v => { const d = L.digits(v); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
async function upsertDid(b, create) {
  const did = cleanDid(b.did);
  if (did.length !== 10) throw Object.assign(new Error('DID must be 10 digits: ' + b.did), { status: 400 });
  let cust = b.customer_id ? { id: b.customer_id } : (await pool.query('SELECT id FROM customers WHERE name = $1', [b.customer])).rows[0];
  if (!cust) throw Object.assign(new Error('unknown customer (add the customer with a contact email first): ' + (b.customer || b.customer_id)), { status: 400 });
  await pool.query(`INSERT INTO dids (customer_id,did,facility,elin_address1,elin_address2,city,state,zip,notes,notify_emails) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (did) DO UPDATE SET customer_id=$1, facility=$3, elin_address1=$4, elin_address2=$5, city=$6, state=$7, zip=$8, notes=$9, notify_emails=$10, updated_at=now()`,
    [cust.id, did, b.facility || null, (b.elin_address1 || '').trim() || null, b.elin_address2 || null, b.city || null, b.state || null, b.zip || null, b.notes || null, emailList(b.notify_emails)]);
}
app.post('/api/dids', need('admin'), wrap(async (req, res) => { await upsertDid(req.body); res.json({ ok: true }); }));
app.delete('/api/dids/:id', need('admin'), wrap(async (req, res) => { await pool.query('DELETE FROM dids WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

function parseCsv(text) {   // small RFC4180 parser
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
app.post('/api/dids/import', need('admin'), wrap(async (req, res) => {
  const rows = await tableFromBody(req);
  const head = rows.shift().map(h => h.trim().toLowerCase());
  let n = 0; const errors = [];
  for (const r of rows) {
    const o = Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()]));
    try { await upsertDid(o, req.query.create === '1'); n++; } catch (e) { errors.push(e.message); }
  }
  res.json({ imported: n, errors });
}));

// ---- customers manage their own alert emails (addresses/ELIN stay admin-only) ----
const okEmail = e => e.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e);
const requiredEmail = v => { const e = String(v || '').trim().toLowerCase(); if (!okEmail(e)) throw Object.assign(new Error('a valid customer contact email is required'), { status: 400 }); return e; };
function cleanEmails(v) {
  const l = [...new Set(emailList(v).map(x => x.toLowerCase()))], bad = l.find(e => !okEmail(e));
  if (bad) throw Object.assign(new Error('not a valid email address: ' + bad), { status: 400 });
  if (l.length > 20) throw Object.assign(new Error('20 addresses at most'), { status: 400 });
  return l;
}
const needCustomer = (req, res, next) => (req.user && req.user.role !== 'customer') ? res.status(403).json({ error: 'customer accounts only' }) : need()(req, res, next);
const tellAdmins = (req, what, oldV, newV) => L.sendMail(L.adminEmails(), 'E911 portal: ' + what, `<p><b>${L.esc(req.user.username)}</b> changed ${L.esc(what)} (from ${L.esc(clientIp(req))}).</p><p>Before: ${L.esc(oldV.join(', ') || '(none)')}<br>After: ${L.esc(newV.join(', ') || '(none)')}</p>`).catch(() => {});
app.get('/api/my/notify', needCustomer, wrap(async (req, res) => res.json((await pool.query('SELECT name, notify_emails FROM customers WHERE id=$1', [req.user.customer_id])).rows[0])));
app.put('/api/my/notify', needCustomer, wrap(async (req, res) => {
  const emails = cleanEmails((req.body || {}).notify_emails);
  const old = (await pool.query('SELECT notify_emails FROM customers WHERE id=$1', [req.user.customer_id])).rows[0].notify_emails;
  await pool.query('UPDATE customers SET notify_emails=$2 WHERE id=$1', [req.user.customer_id, emails]);
  tellAdmins(req, 'account 911 alert emails', old, emails); res.json({ ok: true, notify_emails: emails });
}));
app.put('/api/my/dids/:id/emails', needCustomer, wrap(async (req, res) => {
  const emails = cleanEmails((req.body || {}).notify_emails);
  const d = (await pool.query('SELECT did, notify_emails FROM dids WHERE id=$1 AND customer_id=$2', [Number(req.params.id), req.user.customer_id])).rows[0];
  if (!d) return res.status(404).json({ error: 'no such number on your account' });
  await pool.query('UPDATE dids SET notify_emails=$2, updated_at=now() WHERE id=$1', [Number(req.params.id), emails]);
  tellAdmins(req, 'alert emails for number ' + d.did, d.notify_emails || [], emails); res.json({ ok: true, notify_emails: emails });
}));
const testSent = new Map();
app.post('/api/my/notify-test', needCustomer, wrap(async (req, res) => {
  if (Date.now() - (testSent.get(req.user.id) || 0) < 60e3) return res.status(429).json({ error: 'wait a minute between test emails' });
  testSent.set(req.user.id, Date.now());
  const c = (await pool.query('SELECT name, notify_emails FROM customers WHERE id=$1', [req.user.customer_id])).rows[0];
  const dd = (await pool.query('SELECT notify_emails FROM dids WHERE customer_id=$1', [req.user.customer_id])).rows;
  const to = [...new Set([...(c.notify_emails || []), ...dd.flatMap(r => r.notify_emails || [])])];
  if (!to.length) return res.status(400).json({ error: 'no notification emails are set yet' });
  const status = await L.sendMail(to, `TEST: ${L.brand()} E911 notification email`, `<div style="font-family:Arial,sans-serif;border:4px solid #888;padding:16px;max-width:520px"><h2 style="margin:0 0 8px;color:#555">TEST MESSAGE</h2><p>This is a test of the 911 alert emails for <b>${L.esc(c.name)}</b>. <b>No emergency call was made.</b></p><p>If you received this, alerts will reach this address.</p></div>`);
  res.json({ sent: to.length, status });
}));

// ---- customers, users, patterns (admin) ----
app.get('/api/customers', need('admin'), wrap(async (req, res) => res.json((await pool.query(
  `SELECT c.*, COALESCE((SELECT array_agg(u.username ORDER BY u.username) FROM users u WHERE u.customer_id = c.id AND u.active), '{}') AS portal_users,
          (SELECT count(*)::int FROM dids d WHERE d.customer_id = c.id) AS did_count
     FROM customers c ORDER BY c.name`)).rows)));
app.patch('/api/customers/:id', need('admin'), wrap(async (req, res) => {   // edit emails / notes, or deactivate (never deletes: 911 records are kept)
  const b = req.body || {}, id = Number(req.params.id);
  if (b.notify_emails !== undefined) await pool.query('UPDATE customers SET notify_emails=$2 WHERE id=$1', [id, emailList(b.notify_emails)]);
  if (b.notes !== undefined) await pool.query('UPDATE customers SET notes=$2 WHERE id=$1', [id, b.notes || null]);
  if (b.contact_email !== undefined) await pool.query('UPDATE customers SET contact_email=$2 WHERE id=$1', [id, requiredEmail(b.contact_email)]);
  if (b.admin_emails !== undefined) await pool.query('UPDATE customers SET admin_emails=$2 WHERE id=$1', [id, cleanEmails(b.admin_emails)]);
  if (b.active !== undefined) { await pool.query('UPDATE customers SET active=$2 WHERE id=$1', [id, !!b.active]); await pool.query('UPDATE users SET active=$2 WHERE customer_id=$1', [id, !!b.active]); }
  res.json({ ok: true });
}));
async function sampleAlert(customerId, noElin = false) {   // a made-up alert built from this customer's first real number, plus who would receive it
  const q = await pool.query(`SELECT d.*, c.name AS customer_name, c.notify_emails AS cust_emails, c.contact_email AS cust_contact, c.admin_emails AS cust_admin_emails
      FROM customers c LEFT JOIN dids d ON d.customer_id = c.id WHERE c.id = $1 ORDER BY d.id LIMIT 1`, [customerId]);
  if (!q.rows.length) throw Object.assign(new Error('no such customer'), { status: 404 });
  const r = q.rows[0]; let did = r.did ? r : { ...r, facility: '(no numbers added yet)', elin_address1: '123 Example St', city: 'Springfield', state: 'ST', zip: '00000' };
  if (noElin) did = { ...did, elin_address1: null, elin_address2: null, city: null, state: null, zip: null };
  const c = { src: [r.did || '9705550100'], dstIn: '911', start: new Date(), callId: 'SAMPLE-' + Date.now() };
  const { to, staff } = L.recipientsFor(did, true);
  return { to, staff, urgent: L.noElin(did), subject: L.alertSubject({ isReal: true, did, c, sample: true }), html: L.alertHtml({ isReal: true, label: 'SAMPLE', did, c, sample: true }), staffHtml: L.alertHtml({ isReal: true, label: 'SAMPLE', did, c, sample: true, staff: true }) };
}
app.get('/api/customers/:id/email-preview', need('admin'), wrap(async (req, res) => res.json(await sampleAlert(Number(req.params.id), req.query.noelin === '1'))));
app.post('/api/customers/:id/test-email', need('admin'), wrap(async (req, res) => {
  const a = await sampleAlert(Number(req.params.id), (req.body || {}).noelin === true);
  const r = await L.sendAlert({ to: a.to, staff: a.staff }, a.subject, a.html, { urgent: a.urgent, staffHtml: a.staffHtml });
  res.json({ status: r.status || r.staffStatus, staffStatus: r.staffStatus, to: a.to, staff: a.staff });
}));
app.post('/api/customers/:id/portal', need('admin'), wrap(async (req, res) => {   // set the customer's portal login (username defaults to the account name)
  const id = Number(req.params.id), b = req.body || {};
  const c = (await pool.query('SELECT name FROM customers WHERE id=$1', [id])).rows[0];
  if (!c) return res.status(404).json({ error: 'no such customer' });
  if (!b.password || b.password.length < 10) return res.status(400).json({ error: 'password of 10+ characters required' });
  const username = String(b.username || c.name).trim();
  const ex = (await pool.query('SELECT id, customer_id FROM users WHERE username=$1', [username])).rows[0];
  if (ex && ex.customer_id !== id) return res.status(409).json({ error: 'that username belongs to someone else' });
  if (ex) await pool.query('UPDATE users SET pass_hash=$2, active=true WHERE id=$1', [ex.id, L.hashPassword(b.password)]);
  else await pool.query("INSERT INTO users(username, pass_hash, role, customer_id) VALUES ($1,$2,'customer',$3)", [username, L.hashPassword(b.password), id]);
  res.json({ ok: true, username });
}));
app.get('/api/login-logs', need('admin'), wrap(async (req, res) =>
  res.json((await pool.query('SELECT ts, username, role, success, ip FROM login_log ORDER BY ts DESC LIMIT $1', [Math.min(Number(req.query.limit) || 1000, 20000)])).rows)));
app.get('/api/events', need(), wrap(async (req, res) => {
  const p = [Math.min(Number(req.query.limit) || 100, 2000)], w = [];
  if (req.user.role !== 'admin') { p.push(req.user.customer_id); w.push(`customer_id = $${p.length}`); }
  if (req.query.type) { p.push(req.query.type); w.push(`event_type = $${p.length}`); }
  if (req.query.class === 'real' || req.query.class === 'test') { p.push(req.query.class); w.push(`class = $${p.length}`); }
  res.json((await pool.query(`SELECT ts, call_id, event_type, src_number, dst_number, class FROM call_events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT $1`, p)).rows);
}));
app.get('/api/stats', need(), wrap(async (req, res) => {
  const cust = req.user.role === 'admin' ? null : req.user.customer_id;
  const r = (await pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE class='real')::int AS real, count(*) FILTER (WHERE class='test')::int AS test,
      count(*) FILTER (WHERE started_at > now() - interval '30 days')::int AS last30,
      count(*) FILTER (WHERE class='real' AND (did_id IS NULL OR NOT EXISTS (SELECT 1 FROM dids d WHERE d.id = did_id AND COALESCE(trim(d.elin_address1),'') <> '')) AND started_at > now() - interval '30 days')::int AS no_elin_30d,
      count(*) FILTER (WHERE ended_at IS NULL AND started_at > now() - interval '2 hours')::int AS live,
      max(started_at) FILTER (WHERE class='real') AS last_real, max(started_at) AS last_any
    FROM emergency_calls WHERE ($1::int IS NULL OR customer_id = $1)`, [cust])).rows[0];
  r.fee = Number(process.env.NO_ELIN_FEE || 0);
  r.dids = (await pool.query('SELECT count(*)::int AS n FROM dids WHERE ($1::int IS NULL OR customer_id = $1)', [cust])).rows[0].n;
  res.json(r);
}));
app.post('/api/customers', need('admin'), wrap(async (req, res) => {
  const b = req.body || {}, emails = (Array.isArray(b.notify_emails) ? b.notify_emails : String(b.notify_emails || '').split(/[,\s;]+/)).filter(Boolean);
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const contact = requiredEmail(b.contact_email);
  await pool.query('INSERT INTO customers(name, notify_emails, notes, contact_email) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO UPDATE SET notify_emails=$2, notes=$3, contact_email=$4', [b.name, emails, b.notes || null, contact]);
  res.json({ ok: true });
}));
app.get('/api/customers.csv', need('admin'), wrap(async (req, res) => {
  const rows = (await pool.query("SELECT name, contact_email, array_to_string(notify_emails, ';') AS notify_emails, notes, active, array_to_string(admin_emails, ';') AS admin_emails FROM customers ORDER BY name")).rows;
  res.type('text/csv').attachment('customers.csv').send(toCsv(rows, ['name', 'contact_email', 'notify_emails', 'notes', 'active', 'admin_emails']));
}));
app.get('/api/customers.xlsx', need('admin'), wrap(async (req, res) => {
  const rows = (await pool.query("SELECT name, contact_email, array_to_string(notify_emails, ';') AS notify_emails, notes, active, array_to_string(admin_emails, ';') AS admin_emails FROM customers ORDER BY name")).rows;
  await toXlsx(res, 'customers.xlsx', 'Customers', rows, ['name', 'contact_email', 'notify_emails', 'notes', 'active', 'admin_emails']);
}));
app.post('/api/customers/import', need('admin'), wrap(async (req, res) => {
  const rows = await tableFromBody(req);
  const head = rows.shift().map(h => h.trim().toLowerCase());
  let n = 0; const errors = [];
  for (const r of rows) {
    const o = Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()]));
    if (!o.name) { errors.push('row without a name'); continue; }
    const emails = (o.notify_emails || '').split(/[,;\s]+/).filter(Boolean);
    let contact = (o.contact_email || '').toLowerCase();
    if (!contact) contact = ((await pool.query('SELECT contact_email FROM customers WHERE name=$1', [o.name])).rows[0] || {}).contact_email || '';   // keep the stored one if the file has none
    if (!okEmail(contact)) { errors.push(o.name + ': contact_email required (a valid address)'); continue; }
    const hasAdmin = 'admin_emails' in o;   // only touch the internal list if the file has that column
    await pool.query(`INSERT INTO customers(name, notify_emails, notes, active, admin_emails, contact_email) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (name) DO UPDATE SET notify_emails=$2, notes=$3, active=$4, contact_email=$6${hasAdmin ? ', admin_emails=$5' : ''}`,
      [o.name, emails, o.notes || null, !/^(false|no|0)$/i.test(o.active || 'true'), emailList(o.admin_emails), contact]);
    n++;
  }
  res.json({ imported: n, errors });
}));
app.post('/api/users', need('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password || b.password.length < 10) return res.status(400).json({ error: 'username and a password of 10+ characters required' });
  await pool.query('INSERT INTO users(username, pass_hash, role, customer_id) VALUES ($1,$2,$3,$4)',
    [b.username, L.hashPassword(b.password), b.customer_id ? 'customer' : 'admin', b.customer_id || null]);
  res.json({ ok: true });
}));
// ---- manage users (admins and customer logins) ----
app.get('/api/users', need('admin'), wrap(async (req, res) => res.json((await pool.query(
  `SELECT u.id, u.username, u.role, u.active, u.customer_id, c.name AS customer,
          (SELECT max(l.ts) FROM login_log l WHERE l.success AND l.username = u.username) AS last_login
     FROM users u LEFT JOIN customers c ON c.id = u.customer_id ORDER BY u.role, u.username`)).rows)));
const userGuard = async (req, u, removing) => {   // never lock out the last admin or yourself
  if (!removing) return;
  if (u.id === req.user.id) throw Object.assign(new Error('you cannot disable or delete your own account'), { status: 400 });
  if (u.role === 'admin' && u.active && !(await pool.query("SELECT 1 FROM users WHERE role='admin' AND active AND id<>$1", [u.id])).rows.length)
    throw Object.assign(new Error('that is the last active admin'), { status: 400 });
};
app.patch('/api/users/:id', need('admin'), wrap(async (req, res) => {
  const b = req.body || {}, u = (await pool.query('SELECT * FROM users WHERE id=$1', [Number(req.params.id)])).rows[0];
  if (!u) return res.status(404).json({ error: 'no such user' });
  await userGuard(req, u, b.active === false);
  try {
    if (b.password !== undefined) {
      if (String(b.password).length < 10) return res.status(400).json({ error: 'password of 10+ characters required' });
      await pool.query('UPDATE users SET pass_hash=$2 WHERE id=$1', [u.id, L.hashPassword(b.password)]);
    }
    if (b.username !== undefined) {
      if (!String(b.username).trim()) return res.status(400).json({ error: 'username required' });
      await pool.query('UPDATE users SET username=$2 WHERE id=$1', [u.id, String(b.username).trim()]);
    }
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'that username is taken' }); throw e; }
  if (b.active !== undefined) await pool.query('UPDATE users SET active=$2 WHERE id=$1', [u.id, !!b.active]);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', need('admin'), wrap(async (req, res) => {
  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [Number(req.params.id)])).rows[0];
  if (!u) return res.status(404).json({ error: 'no such user' });
  await userGuard(req, u, true);
  await pool.query('DELETE FROM users WHERE id=$1', [u.id]); res.json({ ok: true });
}));
app.get('/api/admin-emails', need('admin'), wrap(async (req, res) => { await L.refreshAdminEmails(true); res.json({ emails: L.storedAdminEmails(), from_env: L.envAdmins() }); }));
app.put('/api/admin-emails', need('admin'), wrap(async (req, res) => {
  const emails = cleanEmails((req.body || {}).emails);
  await pool.query("INSERT INTO settings(key, value) VALUES ('admin_emails', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(emails)]);
  await L.refreshAdminEmails(true); res.json({ ok: true, emails });
}));
app.get('/api/patterns', need('admin'), wrap(async (req, res) => res.json((await pool.query('SELECT * FROM patterns ORDER BY class, pattern')).rows)));
app.post('/api/patterns', need('admin'), wrap(async (req, res) => {
  const { pattern, class: cls, note } = req.body || {};
  await pool.query('INSERT INTO patterns(pattern,class,note) VALUES ($1,$2,$3) ON CONFLICT (pattern) DO UPDATE SET class=$2, note=$3', [L.digits(pattern), cls, note || null]);
  res.json({ ok: true });
}));
app.delete('/api/patterns/:p', need('admin'), wrap(async (req, res) => { await pool.query('DELETE FROM patterns WHERE pattern=$1', [req.params.p]); res.json({ ok: true }); }));

// index.html carries __BRAND__ placeholders, filled from BRAND_NAME in .env
const INDEX = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => res.type('html').send(INDEX.replace(/__BRAND__/g, L.esc(L.brand()))));
app.use(express.static(path.join(__dirname, 'public')));
if (require.main === module) L.refreshAdminEmails(true);
if (require.main === module) app.listen(Number(process.env.PORT || 3100), '127.0.0.1', () => console.log('yeti-e911 web on', process.env.PORT || 3100));
module.exports = app;
