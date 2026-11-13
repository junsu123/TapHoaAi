import pytest

from app.providers.url_validator import InvalidLiveUrl, parse_live_url
from app.text_norm import clean_display_text, fold, normalize_vi


@pytest.mark.parametrize("raw,expected", [
    ("trà cà gai leo", "tra ca gai leo"),
    ("Trà Cà Gai Leo", "tra ca gai leo"),
    ("Shop ơi cho mình xem Trà Cà Gai Leo nhé!!", "tra ca gai leo"),
    ("  TRÀ   cà gai leo 😍😍 ", "tra ca gai leo"),
    ("đường", "duong"),
    ("trà cà gai leo ạ", "tra ca gai leo"),
])
def test_normalize_vi(raw, expected):
    assert normalize_vi(raw) == expected


def test_nfc_and_nfd_inputs_fold_identically():
    import unicodedata

    s = "trà cà gai leo"
    assert fold(unicodedata.normalize("NFD", s)) == fold(unicodedata.normalize("NFC", s))


def test_clean_display_text_keeps_diacritics_and_strips_controls():
    assert clean_display_text("xin​ chào\x07") == "xin chào"


# ---------------------------------------------------------------- T02 / LIVE-01 / NFR-05
@pytest.mark.parametrize("url,uid", [
    ("https://www.tiktok.com/@shop_tra.ngon/live", "shop_tra.ngon"),
    ("https://tiktok.com/@shoptra/live?lang=vi", "shoptra"),
    ("https://m.tiktok.com/@shoptra", "shoptra"),
])
def test_valid_live_urls(url, uid):
    parsed = parse_live_url(url)
    assert parsed.unique_id == uid
    assert parsed.url == f"https://www.tiktok.com/@{uid}/live"


@pytest.mark.parametrize("url,code", [
    ("https://evil.example/", "host"),
    ("http://www.tiktok.com/@shop/live", "scheme"),
    ("https://www.tiktok.com.evil.example/@shop/live", "host"),
    ("https://user:pw@www.tiktok.com/@shop/live", "host"),
    ("https://www.tiktok.com:8443/@shop/live", "host"),
    ("https://127.0.0.1/@shop/live", "host"),
    ("https://www.tiktok.com/shop/live", "path"),
    ("https://www.tiktok.com/@shop/video/123", "path"),
    ("https://www.tiktok.com/@a b/live", "username"),
    ("", "empty"),
    ("javascript:alert(1)", "scheme"),
])
def test_invalid_live_urls(url, code):
    with pytest.raises(InvalidLiveUrl) as e:
        parse_live_url(url)
    assert e.value.code == code


def test_short_link_needs_resolution_without_fetching():
    parsed = parse_live_url("https://vm.tiktok.com/ZSabc123/")
    assert parsed.needs_resolution and parsed.unique_id is None
