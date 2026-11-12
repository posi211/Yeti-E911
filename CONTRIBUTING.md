# Contributing

Bug reports, fixes and support for other Yeti versions or email providers are welcome.

- Keep changes small and focused. Match the existing style (plain Node.js, no build step).
- Never commit secrets, real phone numbers, real addresses or customer data. Use `example.com` addresses and 555 numbers in tests and screenshots.
- Run the tests before opening a pull request.

## Running the tests

`npm test` runs a quick self-test. The full suite (`npm run test:all`) needs a scratch PostgreSQL server on port 5499 that allows local access without a password, with `schema.sql` loaded into a database named `e911` (the tests connect as `postgres` over the socket in `/tmp`). **The tests empty their tables, so never point them at a real database.** A throwaway instance:

```
initdb -D /tmp/pgtest && pg_ctl -D /tmp/pgtest -o "-p 5499 -k /tmp -c listen_addresses=" -w start
createdb -h /tmp -p 5499 e911 && psql -h /tmp -p 5499 -d e911 -f schema.sql
```
