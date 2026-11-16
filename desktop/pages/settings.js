const f = document.getElementById("f");
const msg = document.getElementById("msg");
(async () => {
  const { cfg, presets, size } = await window.chibiDesktop.getConfig();
  const sel = document.getElementById("size");
  for (const p of presets) sel.add(new Option(p.label, String(p.width)));
  if (!presets.some((p) => p.width === cfg.size)) sel.add(new Option(`${cfg.size} × ${Math.round((cfg.size * 16) / 9)} (đang dùng)`, String(cfg.size)));
  document.getElementById("now").textContent = `Đang hiện: ${size.width} × ${size.height} điểm ảnh.`;
  for (const [k, v] of Object.entries(cfg)) {
    const el = f.elements.namedItem(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = String(v ?? "");
  }
})();
document.getElementById("pick").onclick = async () => {
  const dir = await window.chibiDesktop.chooseDir();
  if (dir) f.elements.namedItem("serverDir").value = dir;
};
f.onsubmit = async (e) => {
  e.preventDefault();
  const d = new FormData(f);
  const saved = await window.chibiDesktop.saveConfig({
    server: d.get("server"),
    token: d.get("token"),
    quality: d.get("quality"),
    size: Number(d.get("size")),
    serverDir: d.get("serverDir"),
    startServer: f.elements.namedItem("startServer").checked,
  });
  f.elements.namedItem("server").value = saved.server;
  msg.textContent = "Đã lưu.";
};
