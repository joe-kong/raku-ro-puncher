/**
 * popup.js - 拡張機能ツールバーアイコンから開くポップアップ
 */
const STORAGE_KEY = "raku_ro_punches";

const $ = (sel) => document.querySelector(sel);

const fmtDateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

const fmtDateLabel = (d) => {
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} (${w})`;
};

const todayKey = () => fmtDateKey(new Date());

const getAll = async () => {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
};

const setAll = async (all) => {
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
};

const renderHistory = (listEl, punches, dateKey) => {
  listEl.innerHTML = "";
  if (!punches || punches.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "打刻はありません";
    listEl.appendChild(li);
    return;
  }
  punches.forEach((p, i) => {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "tag " + (p.type === "出勤" ? "in" : "out");
    tag.textContent = p.type;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = `${i + 1}. ${p.time}`;
    const del = document.createElement("button");
    del.className = "del-btn";
    del.title = "削除";
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      const all = await getAll();
      const arr = all[dateKey] || [];
      arr.splice(i, 1);
      if (arr.length === 0) delete all[dateKey];
      else all[dateKey] = arr;
      await setAll(all);
      await render();
    });
    li.appendChild(tag);
    li.appendChild(time);
    li.appendChild(del);
    listEl.appendChild(li);
  });
};

const render = async () => {
  const today = new Date();
  $("#today-label").textContent = fmtDateLabel(today);

  const all = await getAll();
  const todayPunches = all[todayKey()] || [];

  $("#count").textContent = String(todayPunches.length);
  $("#in-time").textContent = todayPunches[0]?.time ?? "--:--";
  $("#out-time").textContent =
    todayPunches.length > 1 ? todayPunches[todayPunches.length - 1].time : "--:--";

  renderHistory($("#history-list"), todayPunches, todayKey());

  // 過去履歴
  const picker = $("#date-picker");
  if (!picker.value) picker.value = todayKey();
  const otherPunches = all[picker.value] || [];
  renderHistory($("#history-list-other"), otherPunches, picker.value);
};

document.addEventListener("DOMContentLoaded", () => {
  render();

  $("#date-picker").addEventListener("change", render);

  $("#apply-btn").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.startsWith("https://www.raku-ro.com/")) {
      alert(
        "ラクローのタブで実行してください。\n(現在: " + (tab?.url || "不明") + ")"
      );
      return;
    }
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: "rakuro-fill-from-storage",
      });
      if (resp && resp.ok) {
        $("#apply-btn").textContent = `反映しました (${resp.filled}件)`;
        setTimeout(() => {
          $("#apply-btn").textContent = "現在のページの自己申告時間に反映";
        }, 2000);
      } else {
        alert(
          "反映できませんでした: " +
            (resp?.reason || "自己申告時間の入力欄を検出できませんでした")
        );
      }
    } catch (e) {
      alert("コンテンツスクリプトと通信できません。ページを再読み込みしてください。");
    }
  });

  $("#open-rakuro-btn").addEventListener("click", () => {
    chrome.tabs.create({
      url: "https://www.raku-ro.com/employees/work_stats/user/monthly",
    });
  });

  $("#debug-btn").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.startsWith("https://www.raku-ro.com/")) {
      alert("ラクローのタブで実行してください。");
      return;
    }
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: "rakuro-debug-detect",
      });
      const pre = $("#debug-pre");
      const sec = $("#debug-result");
      sec.hidden = false;
      const snippet = resp?.rowSnippet || "";
      pre.textContent = JSON.stringify(
        {
          rowFound: resp?.rowFound,
          startInputFound: resp?.startFound,
          endInputFound: resp?.endFound,
          rowSnippet: snippet.slice(0, 600) + (snippet.length > 600 ? "…" : ""),
        },
        null,
        2
      );
    } catch (e) {
      alert(
        "コンテンツスクリプトと通信できません。ラクローのタブを再読み込みしてください。"
      );
    }
  });

  $("#clear-today").addEventListener("click", async () => {
    if (!confirm("本日の打刻履歴を削除します。よろしいですか？")) return;
    const all = await getAll();
    delete all[todayKey()];
    await setAll(all);
    await render();
  });

  // ストレージ変更を監視
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      render();
    }
  });
});
