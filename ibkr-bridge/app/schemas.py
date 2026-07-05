from __future__ import annotations

from pydantic import BaseModel, Field


class ChainRequest(BaseModel):
    tickers: list[str] = Field(default_factory=list)
    includeGreeks: bool = True
    includeIvRank: bool = True
    minDte: int = 14
    maxDte: int = 90
    maxContractsPerTicker: int = 800


class OptionContractRequest(BaseModel):
    ticker: str
    contractKey: str | None = None
    ibkrConId: int | None = None
    localSymbol: str | None = None
    expiry: str | None = None
    strike: float | None = None
    right: str | None = None


class HistoricalBidAskRequest(BaseModel):
    sessionDate: str
    useRth: int = 1
    tickType: str = "BID_ASK"
    sampleTarget: int = 300
    contracts: list[OptionContractRequest] = Field(default_factory=list)
