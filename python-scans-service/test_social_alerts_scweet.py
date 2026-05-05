from io import BytesIO

import pytest

import social_alerts_scweet as service


class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key.lower(), default)


class FakeHandler:
    def __init__(self, authorization="Bearer service-token"):
        self.headers = FakeHeaders({"authorization": authorization})
        self.rfile = BytesIO(b"{}")
        self.wfile = BytesIO()


def test_normalize_handle():
    assert service.normalize_handle("@NVDA") == "nvda"
    assert service.normalize_handle("TradeDesk/status/123") == "tradedesk"
    with pytest.raises(ValueError):
        service.normalize_handle("bad handle")


def test_service_token_auth(monkeypatch):
    monkeypatch.setenv("SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN", "service-token")
    service.require_service_auth(FakeHandler("Bearer service-token"))
    with pytest.raises(service.SocialAlertsServiceError) as exc:
        service.require_service_auth(FakeHandler("Bearer wrong"))
    assert exc.value.status == "unauthorized"


def test_validate_token_behavior_with_mocked_scweet(monkeypatch):
    monkeypatch.setattr(service, "create_scweet", lambda token: object())
    monkeypatch.setattr(service, "call_search", lambda scweet, handle, start_date, limit: [{"text": "ok"}])

    result = service.validate_token("valid-auth-token")

    assert result["ok"] is True
    assert result["status"] == "working"
    assert result["sampleCount"] == 1


def test_expired_token_mapping(monkeypatch):
    def raise_expired(_auth_token):
        raise RuntimeError("401 unauthorized auth token expired")

    monkeypatch.setattr(service, "create_scweet", raise_expired)

    status_code, payload = service.handle_payload({"action": "validate", "authToken": "old-token"})

    assert status_code == 400
    assert payload["ok"] is False
    assert payload["status"] == "expired"


def test_scrape_output_normalization(monkeypatch):
    tweets = [
        {
            "rest_id": "12345",
            "legacy": {
                "full_text": "Watching $nvda and $TSLA here.",
                "created_at": "Tue May 05 12:00:00 +0000 2026",
            },
            "core": {
                "user_results": {
                    "result": {
                        "legacy": {"screen_name": "sourceHandle"},
                    },
                },
            },
        },
        {"text": "No URL or id should be dropped"},
    ]
    monkeypatch.setattr(service, "create_scweet", lambda token: object())
    monkeypatch.setattr(service, "call_search", lambda scweet, handle, start_date, limit: tweets)

    status_code, payload = service.handle_payload({
        "action": "scrape",
        "authToken": "valid-auth-token",
        "handles": ["sourceHandle"],
        "startDate": "2026-05-01",
        "limitPerHandle": 5,
    })

    assert status_code == 200
    assert payload["ok"] is True
    assert payload["status"] == "working"
    assert len(payload["posts"]) == 1
    assert payload["posts"][0]["handle"] == "sourcehandle"
    assert payload["posts"][0]["tweetId"] == "12345"
    assert payload["posts"][0]["url"] == "https://x.com/sourcehandle/status/12345"


def test_rate_limit_mapping():
    status, message = service.classify_error(RuntimeError("429 too many requests rate limit"))
    assert status == "rate_limited"
    assert "429" in message
