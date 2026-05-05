from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
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


def _dig(source: Any, path: list[str]) -> Any:
    current = source
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


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


def normalize_tweet(raw: Any, fallback_handle: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    legacy = raw.get("legacy") if isinstance(raw.get("legacy"), dict) else {}
    core_user = _dig(raw, ["core", "user_results", "result", "legacy"])
    user_legacy = core_user if isinstance(core_user, dict) else {}

    tweet_id = _first_string(
        raw.get("tweetId"),
        raw.get("tweet_id"),
        raw.get("rest_id"),
        raw.get("id_str"),
        legacy.get("id_str"),
        str(raw.get("id")) if raw.get("id") is not None else None,
    )
    text = _first_string(
        raw.get("text"),
        raw.get("full_text"),
        legacy.get("full_text"),
        legacy.get("text"),
        _dig(raw, ["note_tweet", "note_tweet_results", "result", "text"]),
        _find_first_recursive(raw, {"full_text", "text"}),
    )
    handle = _first_string(
        raw.get("handle"),
        raw.get("username"),
        raw.get("screen_name"),
        user_legacy.get("screen_name"),
        fallback_handle,
    )
    created_at = _first_string(
        raw.get("createdAt"),
        raw.get("created_at"),
        legacy.get("created_at"),
    )
    url = _first_string(raw.get("url"), raw.get("tweet_url"), raw.get("permalink"))

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
        "raw": raw,
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


def call_search(scweet: Any, handle: str, start_date: str, limit: int) -> list[Any]:
    query = f"from:{handle}"
    attempts = [
        lambda: scweet.search(query, since=start_date, from_users=[handle], display_type="Latest", limit=limit, save=False),
        lambda: scweet.search(query, since=start_date, from_users=[handle], limit=limit, save=False),
        lambda: scweet.search(query, since=start_date, display_type="Latest", limit=limit, save=False),
        lambda: scweet.search(query, since=start_date, limit=limit, save=False),
        lambda: scweet.search(query, since=start_date, limit=limit),
    ]
    last_error: BaseException | None = None
    for attempt in attempts:
        try:
            result = attempt()
            return result if isinstance(result, list) else list(result or [])
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
        tweets = call_search(scweet, handle, "2026-01-01", 1)
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
    limit = max(1, min(100, int(limit_per_handle or 25)))
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
            tweets = call_search(scweet, handle, start_date, limit)
            for tweet in tweets:
                normalized = normalize_tweet(tweet, handle)
                if normalized:
                    posts.append(normalized)
        except Exception as error:
            item_status, message = classify_error(error)
            if item_status != "error":
                status = item_status
            failures.append({"handle": handle, "status": item_status, "error": message})

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
            int(payload.get("limitPerHandle") or 25),
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
