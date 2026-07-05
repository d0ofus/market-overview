# IBKR Options Bridge

Private read-only bridge for the Market Command options workflow.

The production path is:

```text
Cloudflare Worker -> Cloudflare Access -> Cloudflare Tunnel -> 127.0.0.1:8765 bridge -> local IB Gateway
```

V1 is intentionally data-only. It does not expose order entry, account mutation, or trading endpoints.

## What The Bridge Provides

- `GET /health`
- `POST /v1/options/chains`
- `POST /v1/options/historical-bid-ask`
- Bearer-token auth on every endpoint
- localhost-only listener by default
- IBKR connection through local IB Gateway/TWS API socket

## Bridge Machine Prerequisites

- Windows machine that stays on during market sessions
- Python 3.11+
- IB Gateway installed and logged in
- IB Gateway API socket enabled
- `cloudflared` installed after the local bridge works

Recommended IB Gateway API setup:

- Socket clients enabled
- Trusted IPs limited to `127.0.0.1`
- Paper mode first
- Daily auto-restart enabled
- Manual weekly re-authentication expected after IBKR security token reset

## Local Setup On The Bridge Machine

From this directory:

```powershell
copy .env.example .env
scripts\generate-bridge-token.ps1
```

Paste the generated token into `.env` as `IBKR_BRIDGE_TOKEN`.

Create the Python environment:

```powershell
scripts\setup-venv.ps1
```

Start the bridge:

```powershell
scripts\start-bridge.ps1
```

In another terminal, verify local health:

```powershell
scripts\check-bridge.ps1 -BridgeToken "<IBKR_BRIDGE_TOKEN>"
```

Probe a small chain only after IB Gateway is running and authenticated:

```powershell
scripts\check-bridge.ps1 -BridgeToken "<IBKR_BRIDGE_TOKEN>" -ProbeTicker AAPL
```

## Run At Login

After local health checks pass:

```powershell
scripts\install-bridge-task.ps1 -Trigger AtLogOn
```

Use `-Trigger AtStartup` only when running the script as an administrator and when the machine can start the bridge before user login.

## Cloudflare Tunnel + Access

Use a named, remotely managed tunnel for production. In the Cloudflare dashboard:

1. Create or choose a Cloudflare-managed domain.
2. Go to Zero Trust or Networking, then Tunnels.
3. Create tunnel `market-options-bridge`.
4. Add published application hostname `ibkr-bridge.<your-domain>`.
5. Set service URL to `http://127.0.0.1:8765`.
6. Create an Access application for the same hostname.
7. Create service token `market-worker-options-bridge`.
8. Add a Service Auth policy that only allows that service token.
9. Copy the tunnel token and install `cloudflared` on the bridge machine:

```powershell
scripts\install-cloudflared-service.ps1 -TunnelToken "<CLOUDFLARE_TUNNEL_TOKEN>"
```

Validate through Access:

```powershell
scripts\check-bridge.ps1 `
  -BridgeUrl "https://ibkr-bridge.<your-domain>" `
  -BridgeToken "<IBKR_BRIDGE_TOKEN>" `
  -CfAccessClientId "<CF_ACCESS_CLIENT_ID>" `
  -CfAccessClientSecret "<CF_ACCESS_CLIENT_SECRET>"
```

## Worker Secrets

After the tunnel hostname works through Access, submit Worker secrets from a machine with Wrangler auth:

```powershell
scripts\set-worker-options-secrets.ps1 `
  -BridgeEndpoint "https://ibkr-bridge.<your-domain>" `
  -BridgeToken "<IBKR_BRIDGE_TOKEN>" `
  -CfAccessClientId "<CF_ACCESS_CLIENT_ID>" `
  -CfAccessClientSecret "<CF_ACCESS_CLIENT_SECRET>"
```

`IBKR_OPTIONS_ENABLED` remains `false` in `worker/wrangler.toml` until the bridge is verified. Flip it to `true` and deploy only after `/api/admin/options/status` is expected to succeed.

## Troubleshooting

Check in this order:

1. IB Gateway is running and authenticated.
2. IB Gateway API socket accepts local connections.
3. `scripts\check-bridge.ps1 -BridgeToken ...` succeeds locally.
4. Cloudflare Tunnel connector is Healthy in the dashboard.
5. Access blocks requests without service-token headers.
6. Access allows requests with service-token headers.
7. Worker secrets match the bridge token and Access token.
8. `/options/status` shows bridge reachable, IBKR auth true, and quote mode.

Common failures:

- `401`: wrong or missing bridge bearer token.
- Access HTML/login response: missing or wrong Cloudflare Access service-token headers.
- `ibkr.authenticated=false`: IB Gateway is closed, logged out, wrong port, or API sockets are disabled.
- Empty chains: missing market data permissions, pacing, no listed options, or filters too narrow.
- Empty historical spread samples: no RTH BID_ASK ticks returned for that contract/session.

## Tests

The included tests use a fake IBKR client and do not require IB Gateway:

```powershell
scripts\setup-venv.ps1
.venv\Scripts\pytest.exe
```
