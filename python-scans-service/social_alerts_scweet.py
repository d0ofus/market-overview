from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any


HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")


class SocialAlertsServiceError(Exception):
    def __init__(self, status: str, message: str, http_status: int = 500) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.http_status = http_status


def normalize_handle(value: Any) -> str:
    text = str(value or "").strip().lstrip("@")
    text = text.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    if not HANDLE_RE.match(text):
        raise ValueError("Invalid X/Twitter handle.")
    return text.lower()


def classify_error(error: BaseException) -> tuple[str, str]:
    message = str(error) or error.__class__.__name__
    lower = message.lower()
    if "rate" in lower or "too many" in lower or "429" in lower or "cooldown" in lower:
        return "rate_limited", message
    if (
        "unauthorized" in lower
        or "forbidden" in lower
        or "auth" in lower
        or "token" in lower
        or "cookie" in lower
        or "401" in lower
        or "403" in lower
        or "no usable accounts" in lower
    ):
        return "expired", message
    return "error", message


def json_response(handler: Any, status_code: int, payload: dict[str, Any]) -> None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def read_json_body(handler: Any) -> dict[str, Any]:
    length = int(handler.headers.get("content-length") or 0)
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def require_service_auth(handler: Any) -> None:
    expected = os.environ.get("SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN", "").strip()
    if not expected:
        raise SocialAlertsServiceError("missing_config", "SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN is not configured.", 503)
    auth = handler.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or auth[7:] != expected:
        raise SocialAlertsServiceError("unauthorized", "Unauthorized.", 401)


def _first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _first_value(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def _dig(source: Any, path: list[str]) -> Any:
    current = source
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        mapped = value.model_dump()
        return mapped if isinstance(mapped, dict) else {}
    if hasattr(value, "dict"):
        mapped = value.dict()
        return mapped if isinstance(mapped, dict) else {}
    return {}


def _find_first_recursive(source: Any, keys: set[str]) -> Any:
    if isinstance(source, dict):
        for key, value in source.items():
            if key in keys and value not in (None, ""):
                return value
        for value in source.values():
            found = _find_first_recursive(value, keys)
            if found not in (None, ""):
                return found
    elif isinstance(source, list):
        for item in source:
            found = _find_first_recursive(item, keys)
            if found not in (None, ""):
                return found
    return None


def coerce_datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)):
        raw = float(value)
        if raw > 10_000_000_000:
            raw /= 1000
        try:
            dt = datetime.fromtimestamp(raw, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            try:
                dt = parsedate_to_datetime(text)
            except (TypeError, ValueError):
                return None
    else:
        return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso_utc(value: Any) -> str | None:
    dt = coerce_datetime(value)
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def is_on_or_after(value: str | None, since: datetime) -> bool:
    dt = coerce_datetime(value)
    return dt is None or dt >= since


def normalize_tweet(raw: Any, fallback_handle: str) -> dict[str, Any] | None:
    data = _as_dict(raw)
    if not data:
        return None

    raw_payload = _as_dict(data.get("raw"))
    legacy = _as_dict(data.get("legacy")) or _as_dict(raw_payload.get("legacy"))
    tweet_result = _as_dict(_dig(data, ["tweet_results", "result"])) or _as_dict(_dig(raw_payload, ["tweet_results", "result"]))
    tweet_legacy = _as_dict(tweet_result.get("legacy"))
    user = _as_dict(data.get("user"))
    core_user = _dig(data, ["core", "user_results", "result", "legacy"]) or _dig(raw_payload, ["core", "user_results", "result", "legacy"])
    user_legacy = core_user if isinstance(core_user, dict) else {}

    tweet_id = _first_string(
        data.get("tweetId"),
        data.get("tweet_id"),
        str(data.get("tweet_id")) if data.get("tweet_id") is not None else None,
        data.get("rest_id"),
        data.get("id_str"),
        tweet_result.get("rest_id"),
        tweet_result.get("id_str"),
        legacy.get("id_str"),
        tweet_legacy.get("id_str"),
        str(data.get("id")) if data.get("id") is not None else None,
    )
    text = _first_string(
        data.get("text"),
        data.get("full_text"),
        data.get("rawContent"),
        data.get("raw_content"),
        data.get("content"),
        data.get("embedded_text"),
        legacy.get("full_text"),
        legacy.get("text"),
        tweet_legacy.get("full_text"),
        tweet_legacy.get("text"),
        _dig(data, ["note_tweet", "note_tweet_results", "result", "text"]),
        _find_first_recursive(data, {"full_text", "rawContent", "raw_content", "content", "text"}),
    )
    handle = _first_string(
        data.get("handle"),
        data.get("username"),
        data.get("screen_name"),
        user.get("screen_name"),
        user.get("username"),
        user_legacy.get("screen_name"),
        fallback_handle,
    )
    created_at = iso_utc(
        _first_value(
            data.get("createdAt"),
            data.get("timestamp"),
            data.get("created_at"),
            data.get("date"),
            data.get("time"),
            legacy.get("created_at"),
            tweet_legacy.get("created_at"),
        )
    )
    url = _first_string(data.get("url"), data.get("tweet_url"), data.get("permalink"))

    if not text or not handle:
        return None

    normalized_handle = normalize_handle(handle)
    if not url and tweet_id:
        url = f"https://x.com/{normalized_handle}/status/{tweet_id}"
    if not url:
        return None

    return {
        "handle": normalized_handle,
        "tweetId": tweet_id,
        "createdAt": created_at,
        "text": text,
        "url": url,
        "raw": data,
    }


def create_scweet(auth_token: str) -> Any:
    from Scweet import Scweet

    kwargs: dict[str, Any] = {
        "auth_token": auth_token,
        "db_path": os.environ.get("SCWEET_DB_PATH", "/tmp/scweet_state.db"),
    }
    proxy = os.environ.get("SCWEET_PROXY", "").strip()
    if proxy:
        kwargs["proxy"] = proxy
    return Scweet(**kwargs)


def _iter_rows(rows: Any) -> list[Any]:
    if rows is None:
        return []
    if isinstance(rows, list):
        return rows
    if isinstance(rows, tuple):
        return list(rows)
    if hasattr(rows, "to_dict"):
        try:
            mapped = rows.to_dict("records")
        except TypeError:
            mapped = rows.to_dict()
        return mapped if isinstance(mapped, list) else [mapped]
    return [rows]


def fetch_profile_tweets(scweet: Any, handle: str, limit: int) -> list[Any]:
    attempts = [
        lambda: scweet.get_profile_tweets([handle], limit=limit, save=False),
        lambda: scweet.get_profile_tweets([handle], limit=limit),
    ]
    last_error: BaseException | None = None
    for attempt in attempts:
        try:
            result = attempt()
            return _iter_rows(result)
        except TypeError as error:
            last_error = error
            continue
    if last_error:
        raise last_error
    return []


def validate_token(auth_token: str, probe_handle: str | None = None) -> dict[str, Any]:
    if not auth_token or len(auth_token.strip()) < 8:
        return {"ok": False, "status": "missing_token", "message": "Scweet auth token is missing."}
    started = time.perf_counter()
    try:
        scweet = create_scweet(auth_token.strip())
        handle = normalize_handle(probe_handle or "githubstatus")
        tweets = fetch_profile_tweets(scweet, handle, 1)
        return {
            "ok": True,
            "status": "working",
            "message": None,
            "runtimeMs": int((time.perf_counter() - started) * 1000),
            "sampleCount": len(tweets),
            "scweetVersion": scweet_version(),
        }
    except Exception as error:
        status, message = classify_error(error)
        return {
            "ok": False,
            "status": status,
            "message": message,
            "runtimeMs": int((time.perf_counter() - started) * 1000),
            "scweetVersion": scweet_version(),
        }


def scrape_handles(auth_token: str, handles: list[Any], start_date: str, limit_per_handle: int) -> dict[str, Any]:
    if not auth_token or len(auth_token.strip()) < 8:
        return {"ok": False, "status": "missing_token", "message": "Scweet auth token is missing.", "posts": [], "failures": []}
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", start_date or ""):
        return {"ok": False, "status": "error", "message": "startDate must be YYYY-MM-DD.", "posts": [], "failures": []}

    normalized_handles = [normalize_handle(handle) for handle in handles][:10]
    since = datetime.fromisoformat(f"{start_date}T00:00:00+00:00")
    limit = max(1, min(500, int(limit_per_handle or 50)))
    started = time.perf_counter()
    posts: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    status = "working"

    try:
        scweet = create_scweet(auth_token.strip())
    except Exception as error:
        status, message = classify_error(error)
        return {"ok": False, "status": status, "message": message, "posts": [], "failures": [], "runtimeMs": int((time.perf_counter() - started) * 1000)}

    for handle in normalized_handles:
        try:
            tweets = fetch_profile_tweets(scweet, handle, limit)
            for tweet in tweets:
                normalized = normalize_tweet(tweet, handle)
                if normalized and is_on_or_after(normalized.get("createdAt"), since):
                    posts.append(normalized)
        except Exception as error:
            item_status, message = classify_error(error)
            if item_status != "error":
                status = item_status
            failures.append({"handle": handle, "status": item_status, "error": message})

    posts.sort(
        key=lambda post: (
            coerce_datetime(post.get("createdAt")) is not None,
            coerce_datetime(post.get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc),
        ),
        reverse=True,
    )

    return {
        "ok": status == "working" or bool(posts),
        "status": status,
        "message": None if status == "working" else "Scweet returned one or more handle failures.",
        "posts": posts,
        "failures": failures,
        "runtimeMs": int((time.perf_counter() - started) * 1000),
        "scweetVersion": scweet_version(),
    }


def scweet_version() -> str | None:
    try:
        from importlib.metadata import version

        return version("Scweet")
    except Exception:
        return None


def handle_payload(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    action = str(payload.get("action") or "health").strip().lower()
    if action == "health":
        return 200, {
            "ok": True,
            "status": "configured",
            "message": None,
            "serverTimeUtc": datetime.now(timezone.utc).isoformat(),
            "scweetVersion": scweet_version(),
        }
    if action == "validate":
        result = validate_token(str(payload.get("authToken") or ""), payload.get("probeHandle"))
        return (200 if result.get("ok") else 400), result
    if action == "scrape":
        result = scrape_handles(
            str(payload.get("authToken") or ""),
            payload.get("handles") if isinstance(payload.get("handles"), list) else [],
            str(payload.get("startDate") or ""),
            int(payload.get("limitPerHandle") or 50),
        )
        return (200 if result.get("ok") else 400), result
    return 400, {"ok": False, "status": "error", "message": "Unsupported action."}


def handle_http(handler: Any) -> None:
    try:
        require_service_auth(handler)
        payload = read_json_body(handler)
        status_code, response = handle_payload(payload)
        json_response(handler, status_code, response)
    except SocialAlertsServiceError as error:
        json_response(handler, error.http_status, {"ok": False, "status": error.status, "message": error.message})
    except Exception as error:
        status, message = classify_error(error)
        json_response(handler, 500, {"ok": False, "status": status, "message": message})
