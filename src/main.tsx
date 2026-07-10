import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { runResilienceBootstrap } from "./lib/resilience/bootstrap";
import "./styles/globals.css";

// Resilience Phase A gates the FIRST render (webcontent-death-recovery node
// 12): the durable pending-recovery probe must seed isReloadInProgress()
// before any mount (teardown suppression), and a pending restoreShell() must
// seed the stores before TerminalTabs' default-tab effect can observe an
// empty tab list. runResilienceBootstrap() never rejects — a resilience
// failure degrades to a normal boot.
function renderApp(): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>
  );
}

void runResilienceBootstrap().finally(renderApp);
