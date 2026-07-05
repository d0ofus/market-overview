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
        return await asyncio.to_thread(client.chains, request)

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
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "IBKR historical BID_ASK probe failed.",
                    "error": str(exc),
                },
            ) from exc

    return app


app = create_app()
