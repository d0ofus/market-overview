from app.config import BridgeConfig
from app.ibkr_client import IbkrOptionsClient
from app.schemas import HistoricalBidAskRequest, OptionContractRequest


class FakeContract:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class FakeEvent:
    def __init__(self):
        self.listeners = []

    def connect(self, listener):
        self.listeners.append(listener)

    def disconnect(self, listener):
        self.listeners.remove(listener)

    def emit(self, *args):
        for listener in list(self.listeners):
            listener(*args)


class FakeIb:
    errorEvent = FakeEvent()

    def qualifyContracts(self, contract):
        return [contract]

    def reqHistoricalTicks(self, *_args, **_kwargs):
        raise RuntimeError("No market data permissions for historical BID_ASK.")


class FakeIbApiError:
    def __init__(self):
        self.errorEvent = FakeEvent()

    def qualifyContracts(self, contract):
        return [contract]

    def reqHistoricalTicks(self, *_args, **_kwargs):
        self.errorEvent.emit(
            42,
            162,
            "Historical Market Data Service error message: No market data permissions.",
            None,
        )
        return []

    def reqHistoricalData(self, *_args, **_kwargs):
        return []


class FakeTick:
    time = "2026-07-02 15:59:00"
    priceBid = 5.1
    priceAsk = 5.3


class FakeIbHistoricalSuccess:
    def __init__(self):
        self.errorEvent = FakeEvent()
        self.requests = []

    def qualifyContracts(self, contract):
        return [contract]

    def reqHistoricalTicks(self, contract, start, end, count, what_to_show, use_rth, ignore_size, options):
        self.requests.append({
            "start": start,
            "end": end,
            "whatToShow": what_to_show,
            "useRth": use_rth,
            "ignoreSize": ignore_size,
        })
        return [FakeTick()]


class FakeBidAskBar:
    date = "2026-07-02 15:59:00"
    open = 5.0
    close = 5.25


class FakeIbHistoricalBarFallback:
    def __init__(self):
        self.errorEvent = FakeEvent()
        self.tick_requests = []
        self.bar_requests = []

    def qualifyContracts(self, contract):
        return [contract]

    def reqHistoricalTicks(self, contract, start, end, count, what_to_show, use_rth, ignore_size, options):
        self.tick_requests.append({
            "start": start,
            "end": end,
            "whatToShow": what_to_show,
            "useRth": use_rth,
        })
        return []

    def reqHistoricalData(self, contract, **kwargs):
        self.bar_requests.append(kwargs)
        return [FakeBidAskBar()]


class FakeIbDirectConIdFallback:
    def __init__(self):
        self.errorEvent = FakeEvent()
        self.historical_contract = None

    def qualifyContracts(self, _contract):
        return []

    def reqHistoricalTicks(self, contract, *_args, **_kwargs):
        self.historical_contract = contract
        return [FakeTick()]


class FakeTicker:
    last = None
    close = None

    def marketPrice(self):
        return None


class FakeBar:
    date = "2026-07-02"
    close = 213.45


class FakeUnderlyingIb:
    def reqMktData(self, *_args):
        return FakeTicker()

    def sleep(self, *_args):
        return None

    def cancelMktData(self, *_args):
        return None

    def reqHistoricalData(self, *_args, **_kwargs):
        return [FakeBar()]


def test_historical_bid_ask_contract_failure_returns_unavailable_row(monkeypatch):
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret"))
    monkeypatch.setattr(client, "_connect", lambda: FakeIb())
    monkeypatch.setattr(client, "_load_ib_insync", lambda: (None, None, None, FakeContract))

    result = client.historical_bid_ask(HistoricalBidAskRequest(
        sessionDate="2026-07-02",
        contracts=[{
            "ticker": "AAPL",
            "contractKey": "898623750",
            "ibkrConId": 898623750,
            "localSymbol": "AAPL  260720C00285000",
        }],
    ))

    row = result["contracts"][0]
    assert row["contractKey"] == "898623750"
    assert row["spreadBasis"] == "unavailable"
    assert row["sampleCount"] == 0
    assert "historical BID_ASK request failed" in row["warnings"][0]


def test_historical_bid_ask_includes_ibkr_api_error_warnings(monkeypatch):
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret"))
    monkeypatch.setattr(client, "_connect", lambda: FakeIbApiError())
    monkeypatch.setattr(client, "_load_ib_insync", lambda: (None, None, None, FakeContract))

    result = client.historical_bid_ask(HistoricalBidAskRequest(
        sessionDate="2026-07-02",
        contracts=[{
            "ticker": "AAPL",
            "contractKey": "898626037",
            "ibkrConId": 898626037,
            "localSymbol": "AAPL  260720P00310000",
        }],
    ))

    warnings = result["contracts"][0]["warnings"]
    assert "IBKR returned no Bid_Ask ticks for the requested RTH window." in warnings
    assert "IBKR API 162: Historical Market Data Service error message: No market data permissions." in warnings


def test_historical_bid_ask_uses_end_only_bid_ask_request(monkeypatch):
    fake_ib = FakeIbHistoricalSuccess()
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret"))
    monkeypatch.setattr(client, "_connect", lambda: fake_ib)
    monkeypatch.setattr(client, "_load_ib_insync", lambda: (None, None, None, FakeContract))

    result = client.historical_bid_ask(HistoricalBidAskRequest(
        sessionDate="2026-07-02",
        contracts=[{
            "ticker": "AAPL",
            "contractKey": "898625843",
            "ibkrConId": 898625843,
            "localSymbol": "AAPL  260720P00295000",
        }],
    ))

    request = fake_ib.requests[0]
    assert request["start"] == ""
    assert request["end"].endswith("20:00:00 UTC")
    assert request["whatToShow"] == "Bid_Ask"
    assert request["useRth"] is True
    assert result["contracts"][0]["spreadBasis"] == "historical_bid_ask"
    assert result["contracts"][0]["sampleCount"] == 1


def test_historical_bid_ask_falls_back_to_bid_ask_bars(monkeypatch):
    fake_ib = FakeIbHistoricalBarFallback()
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret", historical_request_spacing_seconds=0))
    monkeypatch.setattr(client, "_connect", lambda: fake_ib)
    monkeypatch.setattr(client, "_load_ib_insync", lambda: (None, None, None, FakeContract))

    result = client.historical_bid_ask(HistoricalBidAskRequest(
        sessionDate="2026-07-02",
        contracts=[{
            "ticker": "AAPL",
            "contractKey": "898625843",
            "ibkrConId": 898625843,
            "localSymbol": "AAPL  260720P00295000",
        }],
    ))

    row = result["contracts"][0]
    assert len(fake_ib.tick_requests) == 2
    assert fake_ib.bar_requests[0]["whatToShow"] == "BID_ASK"
    assert fake_ib.bar_requests[0]["barSizeSetting"] == "1 min"
    assert fake_ib.bar_requests[0]["useRTH"] is True
    assert row["spreadBasis"] == "historical_bid_ask"
    assert row["sampleCount"] == 1
    assert row["medianSpreadPct"] > 0
    assert "used 1-minute historical BID_ASK bars" in " ".join(row["warnings"])


def test_historical_bid_ask_uses_supplied_conid_when_requalification_fails(monkeypatch):
    fake_ib = FakeIbDirectConIdFallback()
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret", historical_request_spacing_seconds=0))
    monkeypatch.setattr(client, "_connect", lambda: fake_ib)
    monkeypatch.setattr(client, "_load_ib_insync", lambda: (None, None, None, FakeContract))

    result = client.historical_bid_ask(HistoricalBidAskRequest(
        sessionDate="2026-07-02",
        contracts=[{
            "ticker": "AAPL",
            "contractKey": "898625843",
            "ibkrConId": 898625843,
            "localSymbol": "AAPL  260720P00295000",
        }],
    ))

    assert fake_ib.historical_contract.conId == 898625843
    assert not hasattr(fake_ib.historical_contract, "localSymbol")
    assert result["contracts"][0]["spreadBasis"] == "historical_bid_ask"
    assert "used the supplied conId directly" in " ".join(result["contracts"][0]["warnings"])


def test_option_from_request_prefers_conid_without_localsymbol():
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret"))

    contract = client._option_from_request(
        FakeContract,
        None,
        OptionContractRequest(
            ticker="AAPL",
            ibkrConId=898625843,
            localSymbol="AAPL  260720P00295000",
            expiry="2026-07-20",
            strike=295,
            right="put",
        ),
    )

    assert contract.conId == 898625843
    assert contract.secType == "OPT"
    assert not hasattr(contract, "localSymbol")


def test_underlying_snapshot_uses_daily_close_when_top_of_book_is_unavailable():
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret"))

    price, quote_time, warning = client._snapshot_underlying(FakeUnderlyingIb(), object())

    assert price == 213.45
    assert quote_time == "2026-07-02T00:00:00Z"
    assert warning == "Underlying top-of-book unavailable; strike sampling used latest daily close."
