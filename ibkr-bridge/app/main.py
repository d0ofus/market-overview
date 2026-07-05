from __future__ import annotations

import asyncio
import hmac
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException

from . import __version__
from .config import BridgeConfig
from .ibkr_client import IbkrOptionsClient, OptionsClient
from .schemas import ChainRequest, HistoricalBidAskRequest


def create_app(config: BridgeConfig | None = None, client: OptionsClient | None = None) -> FastAPI:
    config = config or BridgeConfig.from_env()
    config.validate_for_server()
    client = client or IbkrOptionsClient(config)
    app = FastAPI(
        title="Market Command IBKR Options Bridge",
        version=__version__,
        docs_url=None,
        redoc_url=None,
    )

    def require_auth(authorization: str | None = Header(default=None)) -> None:
        prefix = "Bearer "
        if not authorization or not authorization.startswith(prefix):
            raise HTTPException(status_code=401, detail="Missing bridge bearer token.")
        provided = authorization[len(prefix):].strip()
        if not hmac.compare_digest(provided, config.bridge_token):
            raise HTTPException(status_code=401, detail="Invalid bridge bearer token.")

    @app.get("/health")
    async def health(_: None = Depends(require_auth)) -> dict[str, Any]:
        return await asyncio.to_thread(client.health)

    @app.post("/v1/options/chains")
    async def option_chains(request: ChainRequest, _: None = Depends(require_auth)) -> dict[str, Any]:
        if not request.tickers:
            return {"results": []}
        try:
            return await asyncio.to_thread(client.chains, request)
        except Exception as exc:
            raise bridge_unavailable("IBKR option chain request failed.", exc) from exc

    @app.post("/v1/options/historical-bid-ask")
    async def historical_bid_ask(request: HistoricalBidAskRequest, _: None = Depends(require_auth)) -> dict[str, Any]:
        if request.tickType.upper() != "BID_ASK":
            raise HTTPException(status_code=400, detail="Only BID_ASK historical ticks are supported.")
        if request.useRth != 1:
            raise HTTPException(status_code=400, detail="useRth=1 is required for V1 spread probes.")
        if not request.contracts:
            return {"contracts": []}
        try:
            return await asyncio.to_thread(client.historical_bid_ask, request)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise bridge_unavailable("IBKR historical BID_ASK probe failed.", exc) from exc

    return app


def bridge_unavailable(message: str, exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "message": message,
            "error": str(exc),
            "hint": "IB Gateway/TWS must be running, logged in, API sockets enabled, and listening on the configured IBKR_HOST/IBKR_PORT.",
        },
    )


app = create_app()
