# Monitoring Yeti-E911 with Prometheus, Alertmanager and Grafana

A silent 911 watcher is worse than none, so the watcher exposes its own health. Files in this folder:

| File | What it is |
|---|---|
| `prometheus-scrape.yml` | scrape job to add to `prometheus.yml` |
| `e911-alerts.rules.yml` | 9 alert rules |
| `grafana-e911-health.json` | "E911 Health" dashboard (import in Grafana) |

## Metrics (served by the watcher at `/metrics`)
`e911_live_poll_last_success_timestamp_seconds`, `e911_live_poll_consecutive_failures`, `e911_live_poll_failures_total`, the same three for `cdr`,
`e911_db_up`, `e911_real_calls_24h`, `e911_test_calls_24h`, `e911_noelin_calls_24h`, `e911_notify_failed_24h`, `e911_staff_copy_failed_24h`,
`e911_last_real_call_timestamp_seconds`, `e911_last_test_call_timestamp_seconds`, `e911_watcher_start_time_seconds`.
Prometheus's own `up{job="yeti-e911-watcher"}` tells you when the watcher process itself is gone.

## Set up
1. **Turn metrics on.** In the app's `.env` add `METRICS_PORT=9396` and `METRICS_BIND=<this host's internal IP>` (and optionally `METRICS_TOKEN`).
   Then `pm2 restart all`. Check locally: `curl http://<internal IP>:9396/metrics`.
2. **Firewall it.** Allow TCP 9396 only from your Prometheus host. Never bind it to a public address.
3. **Add the scrape job** from `prometheus-scrape.yml` to `prometheus.yml` (set the target address) and reload Prometheus.
4. **Add the rules** from `e911-alerts.rules.yml`, check them with `promtool check rules`, and reload Prometheus.
5. **Import the dashboard** in Grafana (Dashboards, New, Import, upload the JSON, pick your Prometheus data source).
6. **Test it.** `pm2 stop yeti-e911-watcher`, wait about 3 minutes, confirm `E911WatcherDown` fires and the email arrives, then `pm2 start yeti-e911-watcher`.

Send these alerts to more than one place (for example email plus a phone push): if your email provider is down, the alert email and the 911 emails fail together.
