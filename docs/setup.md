# Setup

## Requirements

- Node.js 20.19 or newer and npm 10 or newer.
- For WebTransport: a Chromium-based browser with native WebTransport support, the FAILS QUIC native backend for the current OS/architecture, a certificate trusted by the browser, and UDP port 4443 reachable between clients and server.
- For e2e tests: Playwright Chromium (`npx playwright install chromium`).

## WebSocket development

From the project root:

```powershell
npm install
npm run dev
```

Open `http://localhost:4200`. The Angular dev server proxies `/ws` and `/api` to the room service on port 3001. Run multiple tabs or browsers, enter the same room ID, and join. A room ID is an invitation secret; use a random ID for anything beyond a local demo.

Individual processes can be started with `npm run server` and `npm start`. The health endpoint is `http://localhost:3001/api/health`.

## WebTransport HTTP/3

WebTransport requires a secure browser context and a trusted certificate. Create a localhost certificate/key with a certificate tool such as `mkcert` and trust its local CA in the browser/OS. Use a certificate whose SAN includes `localhost`; do not commit private keys. The FAILS adapter expects PEM certificate and private key paths.

In PowerShell, point the backend at the files and permit the HTTPS frontend origin:

```powershell
$env:WT_CERT = 'C:\certs\localhost.pem'
$env:WT_KEY = 'C:\certs\localhost-key.pem'
$env:WT_PORT = '4443'
$env:ALLOWED_ORIGINS = 'https://localhost:4200'
npm run server
```

In another terminal, serve Angular over HTTPS with the same trusted certificate:

```powershell
npm start -- --ssl --ssl-cert C:\certs\localhost.pem --ssl-key C:\certs\localhost-key.pem
```

Open `https://localhost:4200`, choose WebTransport, and join the same room from another browser context. Check browser support and certificate trust before interpreting a failed connection. WebTransport uses UDP/HTTP/3 directly on port 4443; the Angular WebSocket proxy is not involved. The adapter starts only when both `WT_CERT` and `WT_KEY` are set.

The `@fails-components/webtransport-transport-http3-quiche` package supplies the HTTP/3 backend. Its install uses a prebuilt binary where supported; if npm attempts a native build, use that package’s current platform build prerequisites. Do not silently substitute the package’s WebSocket ponyfill when presenting QUIC results.

## Tests and builds

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The default Playwright run opens two isolated browser contexts and verifies WebSocket drawing, presence, reload, and snapshot synchronization. The WebTransport scenario is skipped unless `WT_E2E=1` is set and a trusted HTTPS/HTTP/3 test environment is already running. Set `PLAYWRIGHT_BASE_URL` to that HTTPS Angular origin for manual WebTransport e2e runs.

## Packet impairment

The in-app simulator is application-level delay, cursor sampling, app-message dropping, and extra reliable payload load. It does not cause TCP or QUIC packet loss.

For a real impairment test on an isolated Linux test host, identify the egress interface with `ip route`, then run as an administrator (replace `eth0` and choose controlled values):

```bash
sudo tc qdisc add dev eth0 root netem delay 80ms 10ms loss 2%
sudo tc qdisc show dev eth0
sudo tc qdisc del dev eth0 root
```

Apply the same impairment to both transports, keep hardware/browser/payloads/users/workload fixed, record repeated trials, and remove the qdisc afterward. `tc netem` affects traffic on that interface, so use a controlled network. On Windows, use an equivalent network impairment tool or run the clients/server in Linux VMs/WSL with a network path that actually traverses the impaired interface.
