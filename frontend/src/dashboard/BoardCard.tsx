// Honour board on the host page: top gift givers and buyers, and recording a purchase
// (orders are never guessed from comments or gifts — the host records them here).

import { useEffect, useState } from "react";
import { api, ApiError, formatVnd } from "../lib/api";
import type { LeaderboardView } from "../types/protocol";

export interface PurchasePrefill {
  name: string;
  key: string | null;
  productId: string | null;
  nonce: number;
}

interface ProductLite {
  id: string;
  name: string;
  price: number | null;
}

export function BoardCard({ board, prefill }: { board: LeaderboardView | null; prefill: PurchasePrefill | null }) {
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState(1);
  const [amount, setAmount] = useState("");
  const [thank, setThank] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<ProductLite[]>("/products").then((p) => {
      setProducts(p);
      setProductId((cur) => cur || p[0]?.id || "");
    });
  }, []);
  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name);
    setKey(prefill.key);
    if (prefill.productId) setProductId(prefill.productId);
    setMsg(null);
    document.getElementById("purchase-name")?.focus();
  }, [prefill]);
  const product = products.find((p) => p.id === productId);
  const suggested = product?.price != null ? product.price * qty : null;

  const submit = async () => {
    setErr(null);
    setMsg(null);
    try {
      await api.post("/leaderboard/purchase", {
        name,
        viewer_key: key,
        product_id: productId || null,
        qty,
        amount: amount.trim() ? Number(amount.replace(/\D/g, "")) : null,
        thank,
      });
      setMsg(`Đã ghi: ${name} mua ${qty} ${product?.name ?? ""}.`);
      setName("");
      setKey(null);
      setQty(1);
      setAmount("");
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  };

  return (
    <div className="board-card" data-testid="board-card">
      <div className="board-cols">
        <div>
          <h3>Tặng quà</h3>
          {board?.gifts.length ? (
            <ol className="board-list">
              {board.gifts.map((g, i) => (
                <li key={`${g.name}-${i}`}>
                  <span className="board-rank">{i + 1}</span>
                  <span className="board-name">{g.name}</span>
                  <span className="board-val">{g.coins > 0 ? `${g.coins.toLocaleString("vi-VN")} xu` : `${g.gifts} quà`}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Chưa có ai tặng quà.</p>
          )}
        </div>
        <div>
          <h3>Mua hàng</h3>
          {board?.buyers.length ? (
            <ol className="board-list">
              {board.buyers.map((b, i) => (
                <li key={`${b.name}-${i}`}>
                  <span className="board-rank">{i + 1}</span>
                  <span className="board-name">{b.name}</span>
                  <span className="board-val">{b.amount > 0 ? formatVnd(b.amount) : `${b.items} sản phẩm`}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Chưa ghi đơn nào.</p>
          )}
        </div>
      </div>

      <h3>Ghi nhận khách mua hàng</h3>
      <p className="muted small">Phần mềm không tự đoán đơn từ bình luận. Bấm “Ghi đơn” cạnh bình luận của khách, hoặc nhập tên ở đây.</p>
      <div className="purchase-form">
        <label>
          Tên khách
          <input id="purchase-name" value={name} onChange={(e) => (setName(e.target.value), setKey(null))} placeholder="VD: Lan Anh" aria-label="Tên khách" />
        </label>
        <label>
          Sản phẩm
          <select value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Sản phẩm đã mua">
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Số lượng
          <input type="number" min={1} max={999} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} aria-label="Số lượng" />
        </label>
        <label>
          Thành tiền (đ)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={suggested != null ? `${suggested.toLocaleString("vi-VN")}` : "Chưa có giá"} inputMode="numeric" aria-label="Thành tiền" />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={thank} onChange={(e) => setThank(e.target.checked)} />
        Chủ quán cảm ơn khách trên LIVE
      </label>
      <div className="row wrap">
        <button className="primary" disabled={!name.trim() || !productId} onClick={submit}>
          Ghi đơn
        </button>
        {msg && <span className="muted" data-testid="purchase-msg">{msg}</span>}
        {err && <span className="error">{err}</span>}
      </div>

      {board && board.recent_purchases.length > 0 && (
        <>
          <h3>Đơn đã ghi gần đây</h3>
          <ul className="recent-orders">
            {board.recent_purchases.slice(0, 8).map((p) => (
              <li key={p.id}>
                <span>
                  <b>{p.name}</b> · {p.qty} {p.product} {p.amount > 0 && <span className="muted">({formatVnd(p.amount)})</span>}
                </span>
                <button className="icon-text" onClick={() => api.del(`/leaderboard/purchase/${p.id}`).catch(() => undefined)}>
                  Xóa
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row wrap">
        <button
          onClick={() => {
            if (confirm("Xóa toàn bộ bảng vàng (quà tặng và đơn đã ghi)?")) api.post("/leaderboard/reset").catch(() => undefined);
          }}
        >
          Làm mới bảng vàng
        </button>
        <span className="muted small">{board?.scope === "all" ? "Bảng giữ qua các buổi LIVE cho tới khi làm mới." : "Bảng tự làm mới mỗi buổi LIVE."}</span>
      </div>
    </div>
  );
}
