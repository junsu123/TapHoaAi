// A rendering error shows a short message (and a reload button) instead of a blank page, and is
// reported to the error log.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "./errorReporter";

export class ErrorBoundary extends Component<{ children: ReactNode; quiet?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError("react", `${error.name}: ${error.message}`, `${error.stack ?? ""}\n--- component stack ---${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.quiet) return null; // the OBS page: better empty than an error box on the LIVE
    return (
      <div className="crash" role="alert">
        <h2>Có lỗi khi hiển thị trang này</h2>
        <p>
          Lỗi đã được ghi vào <b>Nhật ký lỗi</b>: {this.state.error.message}
        </p>
        <button className="primary" onClick={() => location.reload()}>
          Tải lại trang
        </button>
      </div>
    );
  }
}
