# Troubleshooting

## WebSocket does not connect

- Confirm `npm run server` is listening on port 3001 and `http://localhost:3001/api/health` returns JSON.
- Keep the Angular origin at `http://localhost:4200`, or add the exact origin to `ALLOWED_ORIGINS`.
- Check that the dev server loaded `proxy.conf.json`; direct use of a static build does not provide the `/ws` proxy.
- Use a room ID containing 3-64 letters, numbers, underscores, or hyphens.

## WebTransport does not connect

- WebTransport requires HTTPS and a browser-trusted certificate. A certificate warning that is bypassed for the page may still prevent WebTransport from accepting the server.
- Confirm the backend logs `WebTransport HTTP/3 listening`, `WT_CERT`/`WT_KEY` point to readable PEM files, and UDP 4443 is not blocked.
- Verify the URL uses the same hostname present in the certificate. `localhost` and `127.0.0.1` are different names for certificate checks.
- Confirm `ALLOWED_ORIGINS` includes the exact HTTPS origin.
- Check that the selected browser exposes native `WebTransport`; the client does not silently fall back to WebSocket.
- Inspect the browser console and backend log for the session-close reason.

## Collaboration or snapshot issues

- All clients must join the exact same room ID and backend process.
- A server restart clears in-memory board state. A disconnect without server restart should rejoin and receive a snapshot.
- Drawing previews may disappear over WebTransport; the completed operation is committed by reliable `DRAW_END`.
- A room accepts at most 24 users. Invalid, stale, oversized, or over-rate events are rejected or dropped by design.

## Test issues

- Install browser binaries with `npx playwright install chromium` before `npm run test:e2e`.
- WebTransport e2e is opt-in (`WT_E2E=1`) because it requires a trusted HTTPS frontend and live HTTP/3 server. Start those manually and set `PLAYWRIGHT_BASE_URL`.
- For Windows PowerShell, use `$env:NAME = 'value'` to set environment variables for the current terminal.
