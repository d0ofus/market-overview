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
    class FakeScweet:
        def get_profile_tweets(self, users, limit=None, save=False):
            assert users == ["githubstatus"]
            assert limit == 1
            return [{"tweet_id": "1", "text": "ok", "tweet_url": "https://x.com/githubstatus/status/1"}]

        def search(self, *args, **kwargs):
            raise AssertionError("search should not be used for Social Alerts validation")

    monkeypatch.setattr(service, "create_scweet", lambda token: FakeScweet())

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


def test_normalize_tweet_supports_embedded_text_nested_user_and_numeric_id():
    normalized = service.normalize_tweet(
        {
            "id": 123456,
            "embedded_text": "Embedded long-form post mentions $META.",
            "date": "2026-05-05T09:30:00+00:00",
            "raw": {
                "core": {
                    "user_results": {
                        "result": {
                            "legacy": {"screen_name": "NestedUser"},
                        },
                    },
                },
            },
        },
        "fallback",
    )

    assert normalized is not None
    assert normalized["tweetId"] == "123456"
    assert normalized["handle"] == "nesteduser"
    assert normalized["text"] == "Embedded long-form post mentions $META."
    assert normalized["createdAt"] == "2026-05-05T09:30:00Z"
    assert normalized["url"] == "https://x.com/nesteduser/status/123456"


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
        {
            "tweet_id": "67890",
            "rawContent": "Later row with $AMD.",
            "timestamp": "2026-05-05T13:15:00Z",
            "user": {"screen_name": "sourceHandle"},
        },
        {
            "tweet_id": "old",
            "text": "Older row with $MSFT should be filtered.",
            "timestamp": "2026-04-30T23:59:00Z",
            "user": {"screen_name": "sourceHandle"},
        },
        {"text": "No URL or id should be dropped"},
    ]

    class FakeScweet:
        def get_profile_tweets(self, users, limit=None, save=False):
            assert users == ["sourcehandle"]
            assert limit == 5
            return tweets

        def search(self, *args, **kwargs):
            raise AssertionError("search should not be used for Social Alerts scraping")

    monkeypatch.setattr(service, "create_scweet", lambda token: FakeScweet())

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
    assert [post["tweetId"] for post in payload["posts"]] == ["67890", "12345"]
    assert payload["posts"][0]["createdAt"] == "2026-05-05T13:15:00Z"
    assert payload["posts"][0]["url"] == "https://x.com/sourcehandle/status/67890"
    assert payload["posts"][1]["handle"] == "sourcehandle"
    assert payload["posts"][1]["createdAt"] == "2026-05-05T12:00:00Z"
    assert payload["posts"][1]["url"] == "https://x.com/sourcehandle/status/12345"


def test_scrape_keeps_undated_rows_after_dated_rows(monkeypatch):
    class FakeScweet:
        def get_profile_tweets(self, users, limit=None, save=False):
            return [
                {"tweet_id": "undated", "text": "Undated $TSLA", "user": {"screen_name": "sourceHandle"}},
                {"tweet_id": "dated", "text": "Dated $NVDA", "timestamp": "2026-05-05T13:15:00Z", "user": {"screen_name": "sourceHandle"}},
            ]

        def search(self, *args, **kwargs):
            raise AssertionError("search should not be used for Social Alerts scraping")

    monkeypatch.setattr(service, "create_scweet", lambda token: FakeScweet())

    status_code, payload = service.handle_payload({
        "action": "scrape",
        "authToken": "valid-auth-token",
        "handles": ["sourceHandle"],
        "startDate": "2026-05-01",
        "limitPerHandle": 50,
    })

    assert status_code == 200
    assert [post["tweetId"] for post in payload["posts"]] == ["dated", "undated"]
    assert payload["posts"][1]["createdAt"] is None


def test_rate_limit_mapping():
    status, message = service.classify_error(RuntimeError("429 too many requests rate limit"))
    assert status == "rate_limited"
    assert "429" in message
