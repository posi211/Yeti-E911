# Installing Yeti-E911

Written for a fresh Debian 12/13 server run as root. Adapt the commands for other systems. Replace every `YOUR_...` placeholder with your own value. Never paste real passwords or keys into chat, tickets or git.

## 1. Prerequisites on the Yeti side

1. **Admin API user.** In yeti-web, create an admin user for this tool. Give it the narrowest role that can read active calls. The user name and password go into `YETI_API_USER` / `YETI_API_PASS`.
2. **API access.** Allow this server's address to reach the Yeti admin API (for example port 6666) in the Yeti's web server and firewall.
3. **CDR read-only role.** In the CDR database create a role that can only `SELECT` on `cdr.cdr`, and allow this server's address to connect to it (`pg_hba.conf`).
4. **Routing.** Make sure your Yeti routes 911 (and 933 for testing) to your emergency carrier. This tool only watches.

## 2. Packages

```
apt install -y postgresql nginx certbot curl
# Node.js 20.6 or newer (for example from NodeSource), then:
npm install -g pm2
```

## 3. Code

```
git clone <this repository> /opt/yeti-e911
cd /opt/yeti-e911 && npm install --omit=dev
```

## 4. Database

Choose a long random password for the application's database role:

```
su postgres -c "psql -c \"CREATE ROLE e911 LOGIN PASSWORD 'YOUR_LONG_RANDOM_PASSWORD'\""
su postgres -c "psql -c 'CREATE DATABASE e911 OWNER e911'"
su postgres -c "psql -d e911" < schema.sql
su postgres -c "psql -d e911 -c 'GRANT ALL ON ALL TABLES IN SCHEMA public TO e911; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO e911;'"
```

## 5. Settings

```
cp .env.example .env && chmod 600 .env
nano .env
```

Fill in the database URLs, Yeti API details, `SESSION_SECRET` (`openssl rand -hex 32`), your SMTP2GO key, and `MAIL_FROM` (a sender verified in SMTP2GO). Keep a copy of `.env` in a password manager: it is the one file you cannot rebuild from this repository.

## 6. First admin and start

```
node --env-file=.env create-user.js admin 'YOUR_PASSWORD_10_OR_MORE_CHARS'
pm2 start ecosystem.config.js && pm2 save && pm2 startup     # run the line pm2 prints
pm2 logs --lines 20 --nostream
```

You should see `yeti-e911 web on 3100` and `yeti-e911 watcher running`.

## 7. Reverse proxy and TLS

Get a certificate for your host name (for example with certbot), then put this in `/etc/nginx/conf.d/yeti-e911.conf`. Two server blocks serve the same app. The proxy **overwrites** `X-E911-Internal`: `1` for the staff site and `0` for the public one.

```
# Staff site: reachable only from your internal network (bind to an internal address)
server {
  listen YOUR_INTERNAL_IP:443 ssl;
  server_name e911.example.com;
  ssl_certificate     /etc/letsencrypt/live/e911.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/e911.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-E911-Internal 1;
  }
}
# Customer site: reachable from the internet, never marked internal
server {
  listen 8443 ssl;
  server_name e911.example.com;
  ssl_certificate     /etc/letsencrypt/live/e911.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/e911.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-E911-Internal 0;
  }
}
```

Check with `nginx -t`, then `systemctl reload nginx`. Port 3100 must never be reachable from outside the server (the app already binds to `127.0.0.1`). Publish the customer site however suits you (port forward, CDN, VPN). Reload nginx after every certificate renewal: `certbot renew --deploy-hook "systemctl reload nginx"`.

## 8. Verify

1. Open the staff site and sign in as the admin you created.
2. Add a customer (a contact email is required) and one number with an address.
3. Dial **933** from that number. A call row should appear with `call.initiated`, `call.answered` and `call.hangup` events. Set `NOTIFY_TEST=1` in `.env` and restart to also get an email on test calls.
4. Use **Preview alert** and **Send test email** on the customer card to check email delivery.
5. Before relying on it, run a real 911 test arranged with your carrier.

## Maintenance

| Task | Command |
| --- | --- |
| Status / logs | `pm2 list`, `pm2 logs --lines 50 --nostream` |
| Restart (re-reads `.env`) | `cd /opt/yeti-e911 && pm2 restart all` |
| Back up the database | `su postgres -c "pg_dump e911" \| gzip > backup-$(date +%F).sql.gz` |
| Restore | `gunzip -c backup.sql.gz \| su postgres -c "psql -d e911"` |
| Upgrade | `git pull && npm install --omit=dev`, run any new `migrate-N.sql` in order (each is safe to repeat), then `pm2 restart all` |

Back up the database nightly and keep a copy off the server. It holds all customers, numbers and call history.

## Troubleshooting

- **"SMTP2GO key not set" although it is in `.env`.** Node's `--env-file` does not override variables already present in the environment. An old exported (or empty) value is winning. Run `unset SMTP2GO_API_KEY`, then `pm2 kill`, then start again from `ecosystem.config.js`.
- **`live yeti 401` in the log.** The Yeti API rejected the login: check `YETI_API_USER` and `YETI_API_PASS` against the yeti-web admin user.
- **Connection refused or timeout to the Yeti.** The server cannot reach the API port: check the Yeti's web-server allow list and firewall.
- **No calls appear.** Confirm the watcher is online in `pm2 list`, check the log, then dial 933.
- **Admin cannot sign in.** Admins can sign in only through the staff site. If you reach the app through the public site it treats you as outside.
- **Email goes to nobody.** The customer has no notification emails and no contact email; the call row shows "no recipients".
