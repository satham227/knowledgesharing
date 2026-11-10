# Real-Time Whiteboard Lab

An Angular 20 and Node.js collaboration demo comparing WebSocket over TCP with WebTransport over HTTP/3 and QUIC. The application uses one shared event model and room manager; live measurements come from browser/server events rather than generated sample values.

## Start the WebSocket demo

```powershell
npm install
npm run dev
```

Open `http://localhost:4200`, join the same room from multiple tabs or browsers, and draw together. The backend health endpoint is `http://localhost:3001/api/health`.

WebTransport mode requires a trusted HTTPS certificate, the FAILS HTTP/3 QUIC adapter, and reachable UDP 4443. Configure `WT_CERT`, `WT_KEY`, and `ALLOWED_ORIGINS`, then serve Angular using HTTPS. The full steps are in [docs/setup.md](docs/setup.md).

## Verify

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The default Playwright scenario opens two independent browser contexts and checks WebSocket drawing, presence, reload, and state synchronization. The WebTransport scenario requires a separately configured HTTPS/HTTP/3 environment and `WT_E2E=1`.

## Documentation

- [Architecture](docs/architecture.md)
- [Setup and packet impairment](docs/setup.md)
- [30-minute demo script](docs/demo-script.md)
- [Troubleshooting](docs/troubleshooting.md)

Room state is in-memory and the room ID acts as a bearer invitation. This is a technical demo, not a production-authenticated deployment.
