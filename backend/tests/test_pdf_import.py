"""Product faces from a print PDF (dieline at real scale)."""

from __future__ import annotations

import io

from PIL import Image, ImageDraw

DPI = 100
PT = 72 / 2.54  # points per cm
COLORS = {"left": (220, 40, 40), "front": (40, 160, 60), "right": (40, 60, 220), "back": (230, 200, 30),
          "top": (150, 60, 170), "bottom": (30, 180, 190)}


def dieline_pdf(w=12.0, h=17.0, d=5.2, margin=2.0, pages=1) -> tuple[bytes, dict[str, tuple[float, float, float, float]]]:
    """Unfolded box: [left][front][right][back][glue], top flap above front, bottom below.
    Returns the PDF and each face's frame in points (x, y, w, h), origin top-left."""
    px = DPI / 2.54
    frames_cm = {
        "left": (margin, margin + d, d, h),
        "front": (margin + d, margin + d, w, h),
        "right": (margin + d + w, margin + d, d, h),
        "back": (margin + 2 * d + w, margin + d, w, h),
        "top": (margin + d, margin, w, d),
        "bottom": (margin + d, margin + d + h, w, d),
    }
    W, H = 2 * margin + 2 * w + 2 * d + 1.5, 2 * margin + h + 2 * d
    img = Image.new("RGB", (round(W * px), round(H * px)), "white")
    dr = ImageDraw.Draw(img)
    for face, (x, y, fw, fh) in frames_cm.items():
        dr.rectangle([x * px, y * px, (x + fw) * px - 1, (y + fh) * px - 1], fill=COLORS[face])
        # a dark mark in each face's upper-left corner, to check orientation
        dr.rectangle([x * px, y * px, (x + 1) * px, (y + 1) * px], fill=(0, 0, 0))
    out = io.BytesIO()
    imgs = [img] * pages
    imgs[0].save(out, format="PDF", resolution=DPI, save_all=True, append_images=imgs[1:])
    return out.getvalue(), {k: (x * PT, y * PT, fw * PT, fh * PT) for k, (x, y, fw, fh) in frames_cm.items()}


def _upload(c, data: bytes):
    return c.post("/api/v1/pdf-imports", files={"file": ("in.pdf", data, "application/pdf")})


def _close(a, b, tol=40):
    return all(abs(x - y) <= tol for x, y in zip(a, b, strict=False))


def test_pdf_faces_render_at_real_scale_and_reach_the_product(admin_client):
    c = admin_client
    pdf, frames = dieline_pdf()
    r = _upload(c, pdf)
    assert r.status_code == 201, r.text
    body = r.json()
    page = body["pages"][0]
    assert abs(page["width_pt"] - (2 * 2 + 24 + 10.4 + 1.5) * PT) < 2  # page keeps its printed size
    prev = c.get(page["preview_url"])
    assert prev.status_code == 200 and prev.headers["content-type"] == "image/png"
    assert max(Image.open(io.BytesIO(prev.content)).size) == 1600
    assert c.get(f"/api/v1/pdf-imports/{body['id']}").json()["pages"] == body["pages"]

    # the print file is not reachable through the public /media mount
    data_dir = c.app.state.container.settings.data_dir
    assert list((data_dir / "pdf_imports").glob("*.pdf"))
    assert not list(c.app.state.container.settings.media_dir.rglob("*.pdf"))

    crops = [{"face": f, "page": 0, "x": x, "y": y, "w": w, "h": h} for f, (x, y, w, h) in frames.items()]
    crops[-1]["rotate"] = 180  # bottom flap is printed upside down on a dieline
    r = c.post(f"/api/v1/pdf-imports/{body['id']}/faces", json={"faces": crops})
    assert r.status_code == 200, r.text
    faces = r.json()["faces"]
    assert set(faces) == set(COLORS)
    for face, info in faces.items():
        img = Image.open(io.BytesIO(c.get(info["url"]).content)).convert("RGB")
        assert img.size == (info["width"], info["height"])
        cx, cy = img.width // 2, img.height // 2
        assert _close(img.getpixel((cx, cy)), COLORS[face]), face
        assert max(img.size) <= 1536
        mark = (img.width - 5, img.height - 5) if face == "bottom" else (5, 5)
        assert sum(img.getpixel(mark)) < 60, face  # rotation applied
    front = faces["front"]
    assert abs(front["width"] / front["height"] - 12 / 17) < 0.01

    r = c.patch("/api/v1/products/TRA_CA_GAI_LEO", json={
        "image_asset_id": front["id"],
        "face_assets": {f: faces[f]["id"] for f in ("left", "right", "back", "top", "bottom")}})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["image_url"].endswith(".jpg") and set(out["face_urls"]) == {"left", "right", "back", "top", "bottom"}


def test_pdf_import_rejects_bad_input(admin_client):
    c = admin_client
    r = _upload(c, b"not a pdf at all")
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_pdf"
    r = _upload(c, b"%PDF-1.4\n broken")
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_pdf"
    r = _upload(c, dieline_pdf(pages=31)[0])
    assert r.status_code == 422 and r.json()["error"]["code"] == "too_many_pages"

    pdf, frames = dieline_pdf()
    iid = _upload(c, pdf).json()["id"]
    x, y, w, h = frames["front"]
    url = f"/api/v1/pdf-imports/{iid}/faces"
    dup = {"faces": [{"face": "front", "page": 0, "x": x, "y": y, "w": w, "h": h}] * 2}
    assert c.post(url, json=dup).status_code == 422
    outside = {"faces": [{"face": "front", "page": 0, "x": 5000, "y": 5000, "w": w, "h": h}]}
    assert c.post(url, json=outside).json()["error"]["code"] == "face_outside"
    bad_rot = {"faces": [{"face": "front", "page": 0, "x": x, "y": y, "w": w, "h": h, "rotate": 45}]}
    assert c.post(url, json=bad_rot).json()["error"]["code"] == "bad_rotate"
    assert c.post(url, json={"faces": [{"face": "front", "page": 3, "x": x, "y": y, "w": w, "h": h}]}).status_code == 404
    assert c.get("/api/v1/pdf-imports/../../secret/pages/0.png").status_code == 404
    assert c.get("/api/v1/pdf-imports/0123456789abcdef01234567").status_code == 404


def test_pdf_import_requires_admin(app_client):
    pdf, _ = dieline_pdf()
    assert _upload(app_client, pdf).status_code in (401, 403)
    assert app_client.get("/api/v1/pdf-imports/0123456789abcdef01234567/pages/0.png").status_code in (401, 403)
