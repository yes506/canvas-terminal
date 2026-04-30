import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

// Day 1 spike: minimal SPA scaffold so the auth round-trip and rust-embed
// integration can be verified end-to-end. Day 3 expands to the three-region
// layout (conversation / task board / drawer) + completion-evidence panel.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
