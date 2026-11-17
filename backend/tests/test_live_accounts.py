"""The shop's LIVE accounts are remembered: no typing the link or the name again."""

from app.providers.url_validator import InvalidLiveUrl, parse_live_url
from tests.test_tiktok_adapter import make  # fake TikTokLive client


def test_a_bare_account_name_is_enough():
    for raw in ("@shoptra", "shoptra", " @tra.ngon_88 "):
        p = parse_live_url(raw)
        name = raw.strip().lstrip("@")
        assert p.unique_id == name and p.url == f"https://www.tiktok.com/@{name}/live"
    for raw in ("tiktok.com", "www.tiktok.com", "@a", "shop tra"):
        try:
            parse_live_url(raw)
        except InvalidLiveUrl:
            continue
        raise AssertionError(raw)


def test_connected_accounts_are_remembered_most_recent_first(admin_client):
    c = admin_client
    factory, _ = make()
    c.app.state.container.tiktok_client_factory = factory
    assert c.get("/api/v1/live/accounts").json() == {"accounts": []}
    for raw in ("https://www.tiktok.com/@shoptra/live", "@tiemtra2", "shoptra"):
        r = c.post("/api/v1/live/connect", json={"url": raw, "policy_ack": True})
        assert r.status_code == 200, r.text
        c.post("/api/v1/live/disconnect")
    names = [a["unique_id"] for a in c.get("/api/v1/live/accounts").json()["accounts"]]
    assert names == ["shoptra", "tiemtra2"]  # no duplicates, the last one used first
    # a refused link is not remembered
    c.post("/api/v1/live/connect", json={"url": "https://evil.example/", "policy_ack": True})
    c.post("/api/v1/live/connect", json={"url": "@khac", "policy_ack": False})
    assert len(c.get("/api/v1/live/accounts").json()["accounts"]) == 2
    # forget one
    left = c.delete("/api/v1/live/accounts/TIEMTRA2").json()["accounts"]
    assert [a["unique_id"] for a in left] == ["shoptra"]
    assert c.delete("/api/v1/live/accounts/shoptra").json() == {"accounts": []}


def test_accounts_need_login(app_client):
    assert app_client.get("/api/v1/live/accounts").status_code == 401
    assert app_client.delete("/api/v1/live/accounts/shoptra").status_code == 401
