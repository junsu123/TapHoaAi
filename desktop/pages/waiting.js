const q = new URLSearchParams(location.search);
window.setStatus = (m) => (document.getElementById("status").textContent = m);
window.setStatus(q.get("msg") || "Đang kết nối…");
document.getElementById("server").textContent = q.get("server") || "";
