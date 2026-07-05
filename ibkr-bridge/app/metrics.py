from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from statistics import median
from typing import Iterable


@dataclass(frozen=True)
class BidAskSample:
    time: datetime | str | None
    bid: float | None
    ask: float | None


def spread_pct(bid: float | None, ask: float | None) -> float | None:
    if bid is None or ask is None or bid <= 0 or ask <= 0 or ask < bid:
        return None
    mid = (bid + ask) / 2
    return ((ask - bid) / mid) * 100 if mid > 0 else None


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * q))))
    return ordered[index]


def iso_time(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def summarize_bid_ask_samples(samples: Iterable[BidAskSample]) -> dict[str, float | int | str | None]:
    valid = [
        (sample, pct)
        for sample in samples
        if (pct := spread_pct(sample.bid, sample.ask)) is not None
    ]
    spreads = [pct for _, pct in valid]
    last = valid[-1][0] if valid else None
    return {
        "lastBid": last.bid if last else None,
        "lastAsk": last.ask if last else None,
        "medianSpreadPct": median(spreads) if spreads else None,
        "p75SpreadPct": _quantile(spreads, 0.75),
        "maxSpreadPct": max(spreads) if spreads else None,
        "sampleCount": len(valid),
        "firstSampleTime": iso_time(valid[0][0].time) if valid else None,
        "lastSampleTime": iso_time(last.time) if last else None,
    }
