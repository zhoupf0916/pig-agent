import { RefreshCw } from "lucide-react";
import { applyUpdate, usePwa } from "./pwa";
import "./pwa.css";

export function PwaUpdateToast() {
  const pwa = usePwa();
  if (!pwa.updateReady) return null;
  return (
    <div className="pwa-toast" role="status">
      <span>工作台有新版本</span>
      <button type="button" onClick={applyUpdate}>
        <RefreshCw size={14} aria-hidden /> 刷新
      </button>
    </div>
  );
}
