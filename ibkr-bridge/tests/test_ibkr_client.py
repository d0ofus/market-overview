from app.config import BridgeConfig
from app.ibkr_client import IbkrOptionsClient
from app.schemas import HistoricalBidAskRequest


class FakeContract:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class FakeIb:
    def qualifyContracts(self, contract):
        return [contract]

    def reqHistoricalTicks(self, *_args, **_kwargs):
        raise RuntimeError("No market data permissions for historical BID_ASK.")


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


def test_underlying_snapshot_uses_daily_close_when_top_of_book_is_unavailable():
    client = IbkrOptionsClient(BridgeConfig(bridge_token="secret"))

    price, quote_time, warning = client._snapshot_underlying(FakeUnderlyingIb(), object())

    assert price == 213.45
    assert quote_time == "2026-07-02T00:00:00Z"
    assert warning == "Underlying top-of-book unavailable; strike sampling used latest daily close."
