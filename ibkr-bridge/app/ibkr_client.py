from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date, datetime, time as dtime
from threading import RLock
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from . import __version__
from .config import BridgeConfig
from .metrics import BidAskSample, summarize_bid_ask_samples
from .schemas import ChainRequest, HistoricalBidAskRequest, OptionContractRequest


class OptionsClient(Protocol):
    def health(self) -> dict[str, Any]:
        ...

    def chains(self, request: ChainRequest) -> dict[str, Any]:
        ...

    def historical_bid_ask(self, request: HistoricalBidAskRequest) -> dict[str, Any]:
        ...


def normalize_ticker(value: str) -> str | None:
    ticker = str(value or "").strip().upper()
    if not ticker or len(ticker) > 16:
        return None
    if any(char in ticker for char in "^/="):
        return None
    return ticker


def right_to_ib(value: str | None) -> str | None:
    text = str(value or "").strip().lower()
    if text in {"c", "call", "calls"}:
        return "C"
    if text in {"p", "put", "puts"}:
        return "P"
    return None


def right_from_ib(value: str | None) -> str | None:
    text = str(value or "").strip().upper()
    if text == "C":
        return "call"
    if text == "P":
        return "put"
    return None


def parse_expiry(value: str | None) -> date | None:
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%Y%m"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed.date()
        except ValueError:
            continue
    return None


def expiry_to_ib(value: str | None) -> str | None:
    parsed = parse_expiry(value)
    return parsed.strftime("%Y%m%d") if parsed else None


def dte(expiry: str, now: date | None = None) -> int | None:
    parsed = parse_expiry(expiry)
    if not parsed:
        return None
    return (parsed - (now or date.today())).days


def as_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed in {float("inf"), float("-inf")}:
        return None
    return parsed


def as_int(value: Any) -> int | None:
    parsed = as_float(value)
    return int(parsed) if parsed is not None else None


def contract_key(ticker: str, expiry: str | None, right: str | None, strike: float | None, con_id: int | None) -> str:
    if con_id is not None:
        return str(con_id)
    return f"{ticker}-{expiry or 'unknown'}-{right or 'option'}-{strike if strike is not None else 'na'}"


def latest_rth_window(session_date: str) -> tuple[datetime, datetime]:
    parsed = datetime.strptime(session_date, "%Y-%m-%d").date()
    ny = ZoneInfo("America/New_York")
    start = datetime.combine(parsed, dtime(9, 30), tzinfo=ny).astimezone(ZoneInfo("UTC"))
    end = datetime.combine(parsed, dtime(16, 0), tzinfo=ny).astimezone(ZoneInfo("UTC"))
    return start, end


@dataclass
class IbkrOptionsClient:
    config: BridgeConfig

    def __post_init__(self) -> None:
        self._lock = RLock()
        self._ib = None
        self._last_error: str | None = None
        self._last_success_at: str | None = None
        self._latest_tick_at: str | None = None

    def _load_ib_insync(self) -> Any:
        try:
            from ib_insync import IB, Option, Stock  # type: ignore
        except Exception as exc:  # pragma: no cover - exercised only without optional runtime dependency
            raise RuntimeError(f"ib-insync is not installed or failed to import: {exc}") from exc
        return IB, Option, Stock

    def _connect(self) -> Any:
        with self._lock:
            IB, _, _ = self._load_ib_insync()
            if self._ib is None:
                self._ib = IB()
            if not self._ib.isConnected():
                self._ib.connect(
                    self.config.ibkr_host,
                    self.config.ibkr_port,
                    clientId=self.config.ibkr_client_id,
                    timeout=self.config.connect_timeout_seconds,
                    readonly=self.config.ibkr_readonly,
                    account=self.config.ibkr_account or "",
                )
                self._ib.reqMarketDataType(self.config.ibkr_market_data_type)
            return self._ib

    def health(self) -> dict[str, Any]:
        try:
            ib = self._connect()
            connected = bool(ib.isConnected())
            self._last_error = None if connected else self._last_error
            return {
                "ok": connected,
                "version": __version__,
                "bridgeRunning": True,
                "ibkr": {
                    "authenticated": connected,
                    "running": connected,
                    "host": self.config.ibkr_host,
                    "port": self.config.ibkr_port,
                    "readonly": self.config.ibkr_readonly,
                },
                "marketData": {
                    "entitled": None,
                    "quoteMode": self._market_data_mode_label(),
                },
                "latestTickAt": self._latest_tick_at,
                "historicalPacing": {"status": "ok"},
                "lastSuccessfulProbeAt": self._last_success_at,
                "lastError": None,
            }
        except Exception as exc:
            self._last_error = str(exc)
            return {
                "ok": False,
                "version": __version__,
                "bridgeRunning": True,
                "ibkr": {
                    "authenticated": False,
                    "running": False,
                    "host": self.config.ibkr_host,
                    "port": self.config.ibkr_port,
                    "readonly": self.config.ibkr_readonly,
                },
                "marketData": {
                    "entitled": None,
                    "quoteMode": self._market_data_mode_label(),
                },
                "latestTickAt": self._latest_tick_at,
                "historicalPacing": {"status": "unknown"},
                "lastSuccessfulProbeAt": self._last_success_at,
                "lastError": self._last_error,
            }

    def chains(self, request: ChainRequest) -> dict[str, Any]:
        ib = self._connect()
        _, Option, Stock = self._load_ib_insync()
        results: list[dict[str, Any]] = []
        max_per_ticker = min(request.maxContractsPerTicker, self.config.max_contracts_per_ticker)

        for raw_ticker in request.tickers:
            ticker = normalize_ticker(raw_ticker)
            if not ticker:
                continue
            warnings: list[str] = []
            stock = Stock(ticker, "SMART", "USD")
            qualified_stock = ib.qualifyContracts(stock)
            if not qualified_stock:
                results.append({
                    "ticker": ticker,
                    "status": "no_underlying",
                    "optionsAvailable": False,
                    "warnings": ["IBKR did not qualify the stock contract."],
                    "contracts": [],
                })
                continue
            stock = qualified_stock[0]
            underlying_price, underlying_time = self._snapshot_underlying(ib, stock)
            params = ib.reqSecDefOptParams(ticker, "", stock.secType, stock.conId)
            selected_params = self._select_option_params(params)
            if selected_params is None:
                results.append({
                    "ticker": ticker,
                    "status": "no_options",
                    "underlyingPrice": underlying_price,
                    "underlyingQuoteTime": underlying_time,
                    "optionsAvailable": False,
                    "warnings": ["IBKR returned no option security definition parameters."],
                    "contracts": [],
                })
                continue

            expiries = self._filter_expiries(selected_params.expirations, request.minDte, request.maxDte)
            strikes = self._filter_strikes(selected_params.strikes, underlying_price)
            contracts = []
            for expiry in expiries:
                for strike in strikes:
                    contracts.append(Option(ticker, expiry.replace("-", ""), strike, "C", "SMART", currency="USD"))
                    contracts.append(Option(ticker, expiry.replace("-", ""), strike, "P", "SMART", currency="USD"))
                    if len(contracts) >= max_per_ticker:
                        break
                if len(contracts) >= max_per_ticker:
                    break

            qualified_options = ib.qualifyContracts(*contracts) if contracts else []
            rows = self._snapshot_options(ib, qualified_options[:max_per_ticker])
            if not rows and contracts:
                warnings.append("No option quote rows were returned before the snapshot timeout.")
            results.append({
                "ticker": ticker,
                "provider": "ibkr_bridge",
                "status": "ok",
                "underlyingPrice": underlying_price,
                "underlyingQuoteTime": underlying_time,
                "optionsAvailable": bool(rows),
                "ivRank52w": None,
                "ivPercentile52w": None,
                "dataMode": self._market_data_mode_label(),
                "warnings": warnings,
                "contracts": rows,
            })

        self._last_success_at = datetime.utcnow().isoformat() + "Z"
        return {"results": results}

    def historical_bid_ask(self, request: HistoricalBidAskRequest) -> dict[str, Any]:
        if request.tickType.upper() != "BID_ASK":
            raise ValueError("Only BID_ASK historical ticks are supported.")
        ib = self._connect()
        _, Option, _ = self._load_ib_insync()
        start, end = latest_rth_window(request.sessionDate)
        rows: list[dict[str, Any]] = []
        sample_target = max(10, min(1000, request.sampleTarget))

        for item in request.contracts:
            contract = self._option_from_request(Option, item)
            if contract is None:
                rows.append({
                    "contractKey": item.contractKey or item.localSymbol or "unknown",
                    "sessionDate": request.sessionDate,
                    "spreadBasis": "unavailable",
                    "sampleCount": 0,
                    "warnings": ["Insufficient contract identity for IBKR historical tick request."],
                })
                continue
            qualified = ib.qualifyContracts(contract)
            if not qualified:
                rows.append({
                    "contractKey": item.contractKey or item.localSymbol or "unknown",
                    "sessionDate": request.sessionDate,
                    "spreadBasis": "unavailable",
                    "sampleCount": 0,
                    "warnings": ["IBKR did not qualify the option contract."],
                })
                continue
            ticks = ib.reqHistoricalTicks(
                qualified[0],
                start.strftime("%Y%m%d %H:%M:%S UTC"),
                end.strftime("%Y%m%d %H:%M:%S UTC"),
                sample_target,
                "BID_ASK",
                bool(request.useRth),
                True,
                [],
            )
            samples = [
                BidAskSample(
                    time=getattr(tick, "time", None),
                    bid=as_float(getattr(tick, "priceBid", None)),
                    ask=as_float(getattr(tick, "priceAsk", None)),
                )
                for tick in ticks
            ]
            metrics = summarize_bid_ask_samples(samples)
            rows.append({
                "contractKey": item.contractKey or item.localSymbol or str(getattr(qualified[0], "conId", "")),
                "ibkrConId": getattr(qualified[0], "conId", item.ibkrConId),
                "localSymbol": getattr(qualified[0], "localSymbol", item.localSymbol),
                "sessionDate": request.sessionDate,
                "spreadBasis": "historical_bid_ask" if metrics["sampleCount"] else "unavailable",
                **metrics,
                "warnings": [] if metrics["sampleCount"] else ["IBKR returned no BID_ASK ticks for the requested RTH window."],
            })
            if self.config.historical_request_spacing_seconds > 0:
                time.sleep(self.config.historical_request_spacing_seconds)

        self._last_success_at = datetime.utcnow().isoformat() + "Z"
        return {"contracts": rows}

    def _market_data_mode_label(self) -> str:
        return {
            1: "realtime",
            2: "frozen",
            3: "delayed",
            4: "delayed_frozen",
        }.get(self.config.ibkr_market_data_type, "unknown")

    def _snapshot_underlying(self, ib: Any, stock: Any) -> tuple[float | None, str | None]:
        ticker = ib.reqMktData(stock, "", False, False)
        ib.sleep(self.config.market_snapshot_seconds)
        price = as_float(ticker.marketPrice()) or as_float(getattr(ticker, "last", None)) or as_float(getattr(ticker, "close", None))
        quote_time = datetime.utcnow().isoformat() + "Z"
        self._latest_tick_at = quote_time if price is not None else self._latest_tick_at
        ib.cancelMktData(stock)
        return price, quote_time if price is not None else None

    def _select_option_params(self, params: list[Any]) -> Any | None:
        if not params:
            return None
        for row in params:
            if getattr(row, "exchange", "") == "SMART":
                return row
        return params[0]

    def _filter_expiries(self, expirations: set[str], min_dte: int, max_dte: int) -> list[str]:
        out = []
        for expiry in sorted(expirations):
            days = dte(expiry)
            if days is not None and min_dte <= days <= max_dte:
                parsed = parse_expiry(expiry)
                if parsed:
                    out.append(parsed.strftime("%Y-%m-%d"))
        return out

    def _filter_strikes(self, strikes: set[float], underlying_price: float | None) -> list[float]:
        clean = sorted(float(strike) for strike in strikes if as_float(strike) is not None)
        if underlying_price is None or underlying_price <= 0:
            return clean
        low = underlying_price * (1 - self.config.chain_moneyness_pct)
        high = underlying_price * (1 + self.config.chain_moneyness_pct)
        filtered = [strike for strike in clean if low <= strike <= high]
        return filtered or clean

    def _snapshot_options(self, ib: Any, contracts: list[Any]) -> list[dict[str, Any]]:
        if not contracts:
            return []
        tickers = []
        for contract in contracts:
            tickers.append(ib.reqMktData(contract, "100,101,104,106", False, False))
        ib.sleep(self.config.market_snapshot_seconds)
        rows = [self._row_from_option_ticker(contract, ticker) for contract, ticker in zip(contracts, tickers)]
        for contract in contracts:
            ib.cancelMktData(contract)
        return rows

    def _row_from_option_ticker(self, contract: Any, ticker: Any) -> dict[str, Any]:
        right = right_from_ib(getattr(contract, "right", None))
        greeks = getattr(ticker, "modelGreeks", None) or getattr(ticker, "askGreeks", None) or getattr(ticker, "bidGreeks", None)
        volume = as_int(getattr(ticker, "callVolume" if right == "call" else "putVolume", None)) or as_int(getattr(ticker, "volume", None))
        open_interest = as_int(getattr(ticker, "callOpenInterest" if right == "call" else "putOpenInterest", None))
        bid = as_float(getattr(ticker, "bid", None))
        ask = as_float(getattr(ticker, "ask", None))
        last = as_float(getattr(ticker, "last", None))
        mid = (bid + ask) / 2 if bid is not None and ask is not None and ask >= bid else last
        quote_time = datetime.utcnow().isoformat() + "Z"
        self._latest_tick_at = quote_time
        expiry = parse_expiry(getattr(contract, "lastTradeDateOrContractMonth", None))
        expiry_text = expiry.strftime("%Y-%m-%d") if expiry else None
        con_id = as_int(getattr(contract, "conId", None))
        return {
            "ticker": getattr(contract, "symbol", None),
            "contractKey": contract_key(getattr(contract, "symbol", ""), expiry_text, right, as_float(getattr(contract, "strike", None)), con_id),
            "ibkrConId": con_id,
            "localSymbol": getattr(contract, "localSymbol", None),
            "expiry": expiry_text,
            "right": right,
            "strike": as_float(getattr(contract, "strike", None)),
            "quote": {
                "bid": bid,
                "ask": ask,
                "mid": mid,
                "last": last,
                "quoteTime": quote_time,
            },
            "volume": volume,
            "openInterest": open_interest,
            "iv": as_float(getattr(greeks, "impliedVol", None)) if greeks else None,
            "greeks": {
                "delta": as_float(getattr(greeks, "delta", None)) if greeks else None,
                "gamma": as_float(getattr(greeks, "gamma", None)) if greeks else None,
                "theta": as_float(getattr(greeks, "theta", None)) if greeks else None,
                "vega": as_float(getattr(greeks, "vega", None)) if greeks else None,
            },
            "dataMode": self._market_data_mode_label(),
            "warnings": [] if bid is not None or ask is not None or last is not None else ["No top-of-book option quote returned."],
        }

    def _option_from_request(self, option_cls: Any, item: OptionContractRequest) -> Any | None:
        ticker = normalize_ticker(item.ticker)
        right = right_to_ib(item.right)
        expiry = expiry_to_ib(item.expiry)
        if ticker and expiry and right and item.strike is not None:
            return option_cls(ticker, expiry, float(item.strike), right, "SMART", currency="USD")
        return None
