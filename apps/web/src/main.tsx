import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CloudConsole } from "./cloud/CloudConsole";
import { CloudAppShell } from "./cloud/CloudAppShell";
import { App } from "./App";
import "./index.css";

function Surface() {
  const [mode, setMode] = useState<
    "loading" | "desktop" | "local-dev" | "cloud"
  >(window.pigDesktop ? "desktop" : "loading");

  useEffect(() => {
    if (window.pigDesktop) return;
    let active = true;
    fetch("/api/deployment")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active) setMode(d?.surface === "local-dev" ? "local-dev" : "cloud");
      })
      .catch(() => {
        if (active) setMode("cloud");
      });
    return () => {
      active = false;
    };
  }, []);
  if (mode === "loading") return <p role="status">正在连接工作台…</p>;
  if (location.pathname === "/debug/runs") return <CloudConsole />;
  if (mode === "cloud") return <CloudAppShell />;
  return <App />;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Surface />
  </StrictMode>,
);
