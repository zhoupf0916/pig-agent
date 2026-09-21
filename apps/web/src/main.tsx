import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CloudConsole } from "./cloud/CloudConsole";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === "/debug/runs" ? <CloudConsole /> : <App />}
  </StrictMode>,
);
