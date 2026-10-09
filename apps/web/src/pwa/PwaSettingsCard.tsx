import { Bell, Download, Share, Smartphone } from "lucide-react";
import { promptInstall, setNotifications, usePwa } from "./pwa";
import "./pwa.css";

export function PwaSettingsCard() {
  const pwa = usePwa();
  return (
    <section className="pwa-card" aria-labelledby="pwa-card-title">
      <h3 id="pwa-card-title">
        <Smartphone size={16} aria-hidden /> 应用与通知
      </h3>
      <div className="pwa-row">
        <div>
          <strong>安装到桌面或主屏幕</strong>
          <small>
            {pwa.installed
              ? "已作为应用打开。"
              : pwa.iosHint
                ? "在 Safari 中点击「分享」，再选择「添加到主屏幕」。"
                : pwa.canInstall
                  ? "像原生应用一样从桌面或主屏幕打开，离线时也能进入工作台。"
                  : "浏览器暂未提供安装入口，可在浏览器菜单中选择「安装应用」或「添加到主屏幕」。"}
          </small>
        </div>
        {pwa.iosHint ? (
          <Share size={18} aria-hidden className="pwa-hint-icon" />
        ) : (
          pwa.canInstall && (
            <button type="button" className="secondary" onClick={() => void promptInstall()}>
              <Download size={14} aria-hidden /> 安装
            </button>
          )
        )}
      </div>
      <div className="pwa-row">
        <div>
          <strong>后台任务通知</strong>
          <small>
            {pwa.notifications === "unsupported"
              ? "当前浏览器不支持通知。"
              : pwa.notifications === "blocked"
                ? "通知已被浏览器禁止，请在浏览器的网站设置中允许后重试。"
                : "工作台在后台时，任务完成、失败或需要审批会提醒你。"}
          </small>
        </div>
        {(pwa.notifications === "on" || pwa.notifications === "off") && (
          <button
            type="button"
            className="secondary"
            aria-pressed={pwa.notifications === "on"}
            onClick={() => void setNotifications(pwa.notifications !== "on")}
          >
            <Bell size={14} aria-hidden /> {pwa.notifications === "on" ? "关闭通知" : "开启通知"}
          </button>
        )}
      </div>
    </section>
  );
}
