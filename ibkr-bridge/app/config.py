from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    value = os.getenv(name)
    try:
        parsed = int(str(value).strip()) if value is not None else default
    except ValueError:
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _float_env(name: str, default: float, minimum: float | None = None, maximum: float | None = None) -> float:
    value = os.getenv(name)
    try:
        parsed = float(str(value).strip()) if value is not None else default
    except ValueError:
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


@dataclass(frozen=True)
class BridgeConfig:
    bridge_token: str
    bridge_host: str = "127.0.0.1"
    bridge_port: int = 8765
    ibkr_host: str = "127.0.0.1"
    ibkr_port: int = 4002
    ibkr_client_id: int = 7712
    ibkr_readonly: bool = True
    ibkr_account: str = ""
    ibkr_market_data_type: int = 1
    chain_moneyness_pct: float = 0.35
    max_contracts_per_ticker: int = 800
    market_snapshot_seconds: float = 3.0
    historical_request_spacing_seconds: float = 1.0
    connect_timeout_seconds: float = 8.0

    @classmethod
    def from_env(cls, env_file: str | Path | None = None) -> "BridgeConfig":
        if env_file is None:
            env_file = Path(__file__).resolve().parents[1] / ".env"
        load_dotenv(env_file, override=False)
        return cls(
            bridge_token=os.getenv("IBKR_BRIDGE_TOKEN", "").strip(),
            bridge_host=os.getenv("IBKR_BRIDGE_HOST", "127.0.0.1").strip() or "127.0.0.1",
            bridge_port=_int_env("IBKR_BRIDGE_PORT", 8765, 1, 65535),
            ibkr_host=os.getenv("IBKR_HOST", "127.0.0.1").strip() or "127.0.0.1",
            ibkr_port=_int_env("IBKR_PORT", 4002, 1, 65535),
            ibkr_client_id=_int_env("IBKR_CLIENT_ID", 7712, 1, 999999),
            ibkr_readonly=_bool_env("IBKR_READONLY", True),
            ibkr_account=os.getenv("IBKR_ACCOUNT", "").strip(),
            ibkr_market_data_type=_int_env("IBKR_MARKET_DATA_TYPE", 1, 1, 4),
            chain_moneyness_pct=_float_env("IBKR_CHAIN_MONEYNESS_PCT", 0.35, 0.01, 5.0),
            max_contracts_per_ticker=_int_env("IBKR_MAX_CONTRACTS_PER_TICKER", 800, 1, 3000),
            market_snapshot_seconds=_float_env("IBKR_MARKET_SNAPSHOT_SECONDS", 3.0, 0.25, 30.0),
            historical_request_spacing_seconds=_float_env("IBKR_HISTORICAL_REQUEST_SPACING_SECONDS", 1.0, 0.0, 60.0),
            connect_timeout_seconds=_float_env("IBKR_CONNECT_TIMEOUT_SECONDS", 8.0, 1.0, 60.0),
        )

    def validate_for_server(self) -> None:
        if not self.bridge_token:
            raise RuntimeError("IBKR_BRIDGE_TOKEN is required.")
        if self.bridge_host not in {"127.0.0.1", "localhost"}:
            raise RuntimeError("IBKR_BRIDGE_HOST must remain 127.0.0.1/localhost for V1.")
