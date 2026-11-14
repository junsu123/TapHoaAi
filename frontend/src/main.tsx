import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { DashboardApp } from "./dashboard/DashboardApp";
import { GamePage } from "./game/GamePage";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import { installErrorReporter } from "./lib/errorReporter";
import "./styles.css";

installErrorReporter(location.pathname.startsWith("/game") ? "game" : "dashboard");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route
          path="/game/live"
          element={
            <ErrorBoundary quiet>
              <GamePage />
            </ErrorBoundary>
          }
        />
        <Route
          path="/dashboard/*"
          element={
            <ErrorBoundary>
              <DashboardApp />
            </ErrorBoundary>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
