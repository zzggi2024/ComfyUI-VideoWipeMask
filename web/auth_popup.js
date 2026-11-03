
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const PLUGIN_NAME = "ComfyUI-VideoWipeMask";
const SAFE_PLUGIN_NAME = "ComfyUI-VideoWipeMask";
const AUTH_API = `/${SAFE_PLUGIN_NAME}/auth`;
let showing = false;
let refreshTimer = null;
let updateNoticeShown = "";

async function requestJson(url, options) {
    const response = await api.fetchApi(url, options);
    const data = await response.json();
    if (!response.ok || data?.ok === false) throw new Error(data?.message || "请求失败");
    return data;
}

async function getStatus() {
    return requestJson(`${AUTH_API}/status`);
}

function clearLegacyAccessKey() {
    try {
        localStorage.removeItem(`Shaobkj_${SAFE_PLUGIN_NAME}_access_key`);
    } catch (_error) {
    }
}

function scheduleRefresh(status) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const expiresAt = Number(status?.expires_at || 0) * 1000;
    if (!expiresAt) return;
    const delay = Math.max(60000, expiresAt - Date.now() - 3600000);
    refreshTimer = setTimeout(refreshOrCheck, delay);
}

async function refreshLease() {
    const data = await requestJson(`${AUTH_API}/refresh`, { method: "POST" });
    scheduleRefresh(data);
    return data;
}

async function refreshOrCheck() {
    try {
        const refreshed = await refreshLease();
        showUpdateNotice(refreshed?.update);
    } catch (_error) {
        try {
            const status = await getStatus();
            if (!status?.ok) {
                showAuthDialog(status?.message || "授权需要重新验证");
                return;
            }
            showUpdateNotice(status?.update);
        } catch (_statusError) {
        }
    }
}

function showUpdateNotice(update) {
    const noticeId = String(update?.notice_id || update?.latest_version || "").trim();
    if (!update?.notify || !noticeId || updateNoticeShown === noticeId) return;
    updateNoticeShown = noticeId;
    const notice = document.createElement("div");
    notice.style.cssText = "position:fixed;top:16px;right:16px;width:min(360px,calc(100vw - 32px));box-sizing:border-box;background:#202124;border:1px solid #3b3d42;border-radius:8px;padding:14px;color:#fff;box-shadow:0 12px 36px rgba(0,0,0,.35);z-index:999998;display:grid;gap:10px;";
    notice.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <strong data-role="title" style="font-size:14px;"></strong>
            <button type="button" data-action="close" aria-label="关闭" style="border:0;background:transparent;color:#aaa;font-size:18px;cursor:pointer;line-height:1;">×</button>
        </div>
        <div data-role="detail" style="font-size:12px;color:#c7c8cc;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
            <a data-action="open" href="#" target="_blank" rel="noopener noreferrer" style="padding:7px 11px;border-radius:6px;background:#4ec7b9;color:#082420;text-decoration:none;font-weight:700;font-size:12px;">查看更新</a>
            <button type="button" data-action="close" style="padding:7px 11px;border-radius:6px;border:1px solid #555;background:#333;color:#fff;font-size:12px;cursor:pointer;">关闭</button>
        </div>`;
    notice.querySelector('[data-role="title"]').textContent = `${PLUGIN_NAME} 有新版本`;
    notice.querySelector('[data-role="detail"]').textContent = "当前 " + (update.current_version || "旧版本") + "，最新 " + (update.latest_version || "");
    async function dismiss() {
        notice.remove();
        try {
            await requestJson(`${AUTH_API}/update-notice/dismiss`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ notice_id: noticeId }),
            });
        } catch (_error) {
        }
    }
    notice.querySelectorAll('[data-action="close"]').forEach((button) => {
        button.addEventListener("click", dismiss);
    });
    const openLink = notice.querySelector('[data-action="open"]');
    const downloadUrl = String(update.download_url || "").trim();
    if (openLink && downloadUrl) {
        try {
            const parsedUrl = new URL(downloadUrl, window.location.href);
            if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new Error("unsupported");
            openLink.href = parsedUrl.href;
        } catch (_error) {
            openLink.remove();
        }
    } else if (openLink) {
        openLink.remove();
    }
    if (openLink?.isConnected) {
        openLink.addEventListener("click", dismiss);
    }
    document.body.appendChild(notice);
}

function showAuthDialog(initialMessage = "") {
    if (showing) return;
    showing = true;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:999999;padding:20px;";
    const panel = document.createElement("form");
    panel.style.cssText = "width:min(420px,100%);background:#222;border:1px solid #333;border-radius:10px;padding:18px;color:#fff;box-shadow:0 16px 50px rgba(0,0,0,.45);display:grid;gap:14px;";
    panel.innerHTML = `
        <h3 style="margin:0;font-size:17px;">${PLUGIN_NAME} 授权码</h3>
        <label style="display:grid;gap:6px;">
            <span style="font-size:13px;color:#aaa;">输入授权码</span>
            <input name="access_key" type="password" autocomplete="off" placeholder="请输入授权码..."
                style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:7px;border:1px solid #555;background:#111;color:#fff;outline:none;font-size:13px;" />
        </label>
        <div data-role="status" style="font-size:12px;min-height:18px;color:#ffb4b4;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button type="button" data-action="cancel" style="padding:8px 14px;border-radius:8px;border:1px solid #555;background:#333;color:#fff;">取消</button>
            <button type="submit" style="padding:8px 16px;border-radius:8px;border:none;background:#4ec7b9;color:#082420;font-weight:700;">确认</button>
        </div>`;
    const input = panel.querySelector('input[name="access_key"]');
    const status = panel.querySelector('[data-role="status"]');
    const cleanup = () => {
        showing = false;
        overlay.remove();
    };
    panel.querySelector('[data-action="cancel"]').addEventListener("click", () => {
        status.textContent = "请先输入正确的授权码。";
        input.focus();
    });
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            status.textContent = "请先输入正确的授权码。";
            input.focus();
        }
    });
    panel.addEventListener("submit", async (event) => {
        event.preventDefault();
        const accessKey = input.value.trim();
        if (!accessKey) {
            status.textContent = "授权码不能为空";
            return;
        }
        status.textContent = "正在验证...";
        try {
            const data = await requestJson(`${AUTH_API}/verify`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: accessKey }),
            });
            input.value = "";
            cleanup();
            window.alert(data.restart_required ? "授权成功，请重启 ComfyUI 以加载节点" : "授权成功");
        } catch (error) {
            input.value = "";
            status.textContent = error?.message || "授权码错误";
            input.focus();
        }
    });
    if (initialMessage) status.textContent = initialMessage;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
}

app.registerExtension({
    name: `shaobkj.strong_drm.${SAFE_PLUGIN_NAME}`,
    async setup() {
        clearLegacyAccessKey();
        try {
            const status = await getStatus();
            if (!status?.ok) {
                showAuthDialog(status?.message || "");
                return;
            }
            showUpdateNotice(status?.update);
            await refreshOrCheck();
        } catch (_error) {
            showAuthDialog("授权状态检查失败，请重新输入");
        }
    },
});
