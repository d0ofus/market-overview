import os

os.environ.setdefault("IBKR_BRIDGE_TOKEN", "import-secret")

from fastapi.testclient import TestClient

from app.config import BridgeConfig
from app.main import create_app


class FakeClient:
    def health(self):
        return {
            "ok": True,
            "version": "test",
            "bridgeRunning": True,
            "ibkr": {"authenticated": True, "running": True},
            "marketData": {"entitled": True, "quoteMode": "realtime"},
            "latestTickAt": "2026-07-02T19:45:00Z",
            "historicalPacing": {"status": "ok"},
            "lastSuccessfulProbeAt": "2026-07-02T19:45:00Z",
            "lastError": None,
        }

    def chains(self, request):
        return {
            "results": [{
                "ticker": request.tickers[0],
                "provider": "ibkr_bridge",
                "status": "ok",
                "underlyingPrice": 212.5,
                "optionsAvailable": True,
                "ivRank52w": None,
                "contracts": [{
                    "contractKey": "AAPL-C-20260821-220",
                    "localSymbol": "AAPL  260821C00220000",
                    "expiry": "2026-08-21",
                    "right": "call",
                    "strike": 220,
                    "quote": {"bid": 5.1, "ask": 5.3, "mid": 5.2, "quoteTime": "2026-07-02T19:45:00Z"},
                    "volume": 240,
                    "openInterest": 1500,
                    "greeks": {"delta": 0.42},
                    "iv": 0.31,
                    "warnings": [],
                }],
            }]
        }

    def historical_bid_ask(self, request):
        return {
            "contracts": [{
                "contractKey": request.contracts[0].contractKey,
                "sessionDate": request.sessionDate,
                "spreadBasis": "historical_bid_ask",
                "lastBid": 5.1,
                "lastAsk": 5.3,
                "medianSpreadPct": 3.8,
                "p75SpreadPct": 4.0,
                "maxSpreadPct": 4.2,
                "sampleCount": 2,
                "firstSampleTime": "2026-07-02T14:00:00Z",
                "lastSampleTime": "2026-07-02T19:45:00Z",
                "warnings": [],
            }]
        }


class FailingClient(FakeClient):
    def chains(self, request):
        raise ConnectionRefusedError("[WinError 1225] The remote computer refused the network connection")


def make_client():
    config = BridgeConfig(bridge_token="secret")
    return TestClient(create_app(config=config, client=FakeClient()))


def make_failing_client():
    config = BridgeConfig(bridge_token="secret")
    return TestClient(create_app(config=config, client=FailingClient()))


def auth_headers():
    return {"Authorization": "Bearer secret"}


def test_health_requires_bearer_token():
    client = make_client()

    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/health", headers=auth_headers()).status_code == 200


def test_chain_endpoint_returns_worker_compatible_shape():
    client = make_client()

    response = client.post("/v1/options/chains", json={"tickers": ["AAPL"], "minDte": 14, "maxDte": 90}, headers=auth_headers())

    assert response.status_code == 200
    data = response.json()
    assert data["results"][0]["ticker"] == "AAPL"
    assert data["results"][0]["contracts"][0]["contractKey"] == "AAPL-C-20260821-220"


def test_chain_endpoint_returns_structured_503_when_ibkr_is_unreachable():
    client = make_failing_client()

    response = client.post("/v1/options/chains", json={"tickers": ["AAPL"]}, headers=auth_headers())

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["message"] == "IBKR option chain request failed."
    assert "refused" in detail["error"]
    assert "IB Gateway/TWS" in detail["hint"]


def test_historical_bid_ask_requires_rth_and_returns_metrics():
    client = make_client()

    bad = client.post(
        "/v1/options/historical-bid-ask",
        json={"sessionDate": "2026-07-02", "useRth": 0, "contracts": []},
        headers=auth_headers(),
    )
    assert bad.status_code == 400

    response = client.post(
        "/v1/options/historical-bid-ask",
        json={
            "sessionDate": "2026-07-02",
            "useRth": 1,
            "tickType": "BID_ASK",
            "contracts": [{"ticker": "AAPL", "contractKey": "AAPL-C-20260821-220"}],
        },
        headers=auth_headers(),
    )

    assert response.status_code == 200
    row = response.json()["contracts"][0]
    assert row["spreadBasis"] == "historical_bid_ask"
    assert row["sampleCount"] == 2
