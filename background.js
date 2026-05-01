/**
 * background.js - service worker
 *
 * 現状はインストール時の初期化と、必要に応じたバッジ更新のみを行う。
 */

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[raku-ro-puncher] installed");
  }
});

// ツールバーアイコンに本日の打刻回数バッジを表示
const STORAGE_KEY = "raku_ro_punches";

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
};

const updateBadge = async () => {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const all = data[STORAGE_KEY] || {};
    const count = (all[todayKey()] || []).length;
    if (count > 0) {
      await chrome.action.setBadgeText({ text: String(count) });
      await chrome.action.setBadgeBackgroundColor({ color: "#1759c4" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    console.error("[raku-ro-puncher] badge update failed", e);
  }
};

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    updateBadge();
  }
});
