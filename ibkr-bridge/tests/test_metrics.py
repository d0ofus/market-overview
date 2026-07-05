from app.metrics import BidAskSample, spread_pct, summarize_bid_ask_samples


def test_spread_pct_uses_midpoint():
    assert round(spread_pct(5.0, 5.5), 4) == round((0.5 / 5.25) * 100, 4)
    assert spread_pct(0, 5.5) is None
    assert spread_pct(5.5, 5.0) is None


def test_summarize_bid_ask_samples_ignores_invalid_rows():
    result = summarize_bid_ask_samples([
        BidAskSample(time="2026-07-02T14:00:00Z", bid=5.0, ask=5.2),
        BidAskSample(time="2026-07-02T14:01:00Z", bid=0, ask=5.2),
        BidAskSample(time="2026-07-02T14:02:00Z", bid=5.1, ask=5.4),
    ])

    assert result["sampleCount"] == 2
    assert result["lastBid"] == 5.1
    assert result["lastAsk"] == 5.4
    assert result["medianSpreadPct"] is not None
    assert result["firstSampleTime"] == "2026-07-02T14:00:00Z"
    assert result["lastSampleTime"] == "2026-07-02T14:02:00Z"
