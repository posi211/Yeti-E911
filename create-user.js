'use strict';
// node create-user.js <username> <password> [customer_id]    (no customer_id = admin)
const L = require('./lib');
const [u, p, c] = process.argv.slice(2);
if (!u || !p || p.length < 10) { console.error('usage: node create-user.js <username> <password 10+ chars> [customer_id]'); process.exit(1); }
L.pool.query('INSERT INTO users(username, pass_hash, role, customer_id) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO UPDATE SET pass_hash=$2',
  [u, L.hashPassword(p), c ? 'customer' : 'admin', c || null]).then(() => { console.log('ok'); process.exit(0); }, e => { console.error(e.message); process.exit(1); });
