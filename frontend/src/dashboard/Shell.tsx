// Dashboard frame: grouped navigation, the always-visible "on air" tile and the page header.

import {
  BookOpen,
  Bot,
  Headset,
  LayoutDashboard,
  LayoutGrid,
  Leaf,
  LogOut,
  MonitorPlay,
  Package,
  Radio,
  ScrollText,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { LiveStatus, Metrics } from "./useDashboardFeed";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  title: string;
  desc: string;
}

export const NAV_GROUPS: { name: string; items: NavItem[] }[] = [
  {
    name: "Trong buổi LIVE",
    items: [
      { to: "", label: "Tổng quan", icon: LayoutDashboard, title: "Tổng quan", desc: "Tình trạng buổi LIVE và những việc cần làm trước khi lên sóng." },
      { to: "host", label: "Người trực & Demo", icon: Headset, title: "Người trực", desc: "Trả lời câu hỏi của khách, điều khiển giọng đọc và theo dõi bình luận." },
      { to: "connect", label: "Kết nối TikTok", icon: Radio, title: "Kết nối TikTok", desc: "Nối phần mềm với buổi LIVE của tài khoản shop, hoặc chạy Demo để thử." },
    ],
  },
  {
    name: "Bán hàng",
    items: [
      { to: "products", label: "Sản phẩm", icon: Package, title: "Sản phẩm", desc: "Tên, giá, ảnh các mặt hộp và từ khóa để nhận ra sản phẩm trong bình luận." },
      { to: "shelves", label: "Bản đồ kệ", icon: LayoutGrid, title: "Bản đồ kệ", desc: "Xếp sản phẩm lên các kệ của cửa hàng 3D." },
      { to: "knowledge", label: "Hội thoại & câu đã học", icon: BookOpen, title: "Hội thoại & câu đã học", desc: "Câu trả lời học được từ các buổi LIVE. Câu đơn giản được trả lời ngay, không cần gọi Claude." },
    ],
  },
  {
    name: "Thiết lập",
    items: [
      { to: "ai", label: "Trợ lý AI & giọng đọc", icon: Bot, title: "Trợ lý AI & giọng đọc", desc: "Khóa Claude, giọng Vbee, lời chào người xem và cách đọc bình luận." },
      { to: "game", label: "Game 3D & OBS", icon: MonitorPlay, title: "Game 3D & OBS", desc: "Màn hình LIVE 9:16 cho OBS, không gian cửa hàng và banner sản phẩm." },
      { to: "settings", label: "Cài đặt & sao lưu", icon: Settings, title: "Cài đặt & sao lưu", desc: "Thời gian hiển thị, sao lưu và khôi phục dữ liệu cửa hàng." },
      { to: "logs", label: "Nhật ký lỗi", icon: ScrollText, title: "Nhật ký lỗi", desc: "Mọi lỗi xảy ra khi phần mềm chạy, mới nhất ở trên." },
    ],
  },
];

const ALL = NAV_GROUPS.flatMap((g) => g.items);

function onAir(live: LiveStatus | null): { state: "live" | "demo" | "warn" | "off"; word: string; note: string } {
  if (!live || live.status === "Chưa kết nối") return { state: "off", word: "Chưa lên sóng", note: "Chưa nối với buổi LIVE nào" };
  if (live.is_demo) return { state: "demo", word: "Đang chạy Demo", note: "Sự kiện mô phỏng, không phải khách thật" };
  if (live.status === "Đã kết nối") return { state: "live", word: "Đang LIVE", note: live.unique_id ? `@${live.unique_id}` : "Đã nối với TikTok" };
  return { state: "warn", word: live.status, note: live.detail || "Xem trang Kết nối TikTok" };
}

export function OnAirTile({ live, metrics, connected }: { live: LiveStatus | null; metrics: Metrics | null; connected: boolean }) {
  const a = onAir(live);
  const viewers = metrics?.viewer_count;
  return (
    <NavLink to="/dashboard/connect" className={`onair onair-${a.state}`} data-testid="onair">
      <span className="onair-head">
        <span className="onair-dot" aria-hidden />
        <span className="onair-word">{a.word}</span>
      </span>
      <span className="onair-note">{a.note}</span>
      <span className="onair-stats">
        <span>
          <b>{viewers ?? "–"}</b> người xem
        </span>
        <span>
          <b>{metrics?.events?.COMMENT ?? 0}</b> bình luận
        </span>
      </span>
      {!connected && <span className="onair-sync">Đang nối lại với máy chủ…</span>}
    </NavLink>
  );
}

export function SideNav({ logBadge }: { logBadge: number }) {
  return (
    <nav aria-label="Trang quản trị">
      {NAV_GROUPS.map((g) => (
        <div className="nav-group" key={g.name}>
          <div className="nav-group-name">{g.name}</div>
          {g.items.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={`/dashboard/${to}`} end={to === ""}>
              <Icon size={17} strokeWidth={1.8} aria-hidden />
              <span className="nav-label">{label}</span>
              {to === "logs" && logBadge > 0 && (
                <span className="nav-badge" data-testid="log-badge">
                  {logBadge > 99 ? "99+" : logBadge}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden>
        <Leaf size={18} strokeWidth={2} />
      </span>
      <span>
        <span className="brand-name">Chibi Live Shop</span>
        <span className="brand-sub">Bảng điều khiển LIVE</span>
      </span>
    </div>
  );
}

export function UserFoot({ name, onLogout }: { name: string; onLogout: () => void }) {
  return (
    <div className="user-foot">
      <span className="user-avatar" aria-hidden>
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="user-name">{name}</span>
      <button className="icon-btn" onClick={onLogout} title="Đăng xuất" aria-label="Đăng xuất">
        <LogOut size={16} aria-hidden />
      </button>
    </div>
  );
}

export function PageHeader({ right }: { right?: ReactNode }) {
  const { pathname } = useLocation();
  const key = pathname.replace(/^\/dashboard\/?/, "").split("/")[0];
  const item = ALL.find((i) => i.to === key) ?? ALL[0];
  return (
    <header className="page-head">
      <div>
        <h1>{item.title}</h1>
        <p>{item.desc}</p>
      </div>
      {right && <div className="page-head-right">{right}</div>}
    </header>
  );
}
