/**
 * ラクロー打刻ボタン - content script
 *
 * 仕様:
 *  - https://www.raku-ro.com/* の任意のページにフローティング打刻ボタンを表示
 *  - クリック時の挙動:
 *      1日のうち 1 回目: 「出勤」として記録
 *      2 回目以降    : 「退勤」として記録 (退勤は最後の打刻で上書き)
 *  - 現在時刻を chrome.storage.local に保存
 *  - 自己申告時間ページ (input[type=time] が見つかるページ) にいる場合は、
 *    今日の行の開始/終了欄に DOM 操作で時刻を流し込む
 */

(() => {
  // 二重注入ガード (SPA 対応)
  if (window.__rakuroPuncherInjected) return;
  window.__rakuroPuncherInjected = true;

  const STORAGE_KEY = "raku_ro_punches";
  const SETTINGS_KEY = "raku_ro_settings";

  // ---------- ユーティリティ ----------
  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  };

  const nowHHMM = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
      2,
      "0"
    )}`;
  };

  const getAllPunches = async () => {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || {};
  };

  const getTodayPunches = async () => {
    const all = await getAllPunches();
    return all[todayKey()] || [];
  };

  const savePunch = async (type, time) => {
    const all = await getAllPunches();
    const key = todayKey();
    const list = all[key] || [];
    list.push({ type, time, recordedAt: new Date().toISOString() });
    all[key] = list;
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
    return list;
  };

  const determineType = (count) => (count === 0 ? "出勤" : "退勤");

  // ---------- フローティングボタン ----------
  const fab = document.createElement("button");
  fab.id = "rakuro-puncher-fab";
  fab.type = "button";
  fab.title = "ラクロー打刻";
  fab.innerHTML = `
    <span class="rakuro-puncher-fab-icon" aria-hidden="true">🕒</span>
    <span class="rakuro-puncher-fab-label">打刻</span>
    <span class="rakuro-puncher-fab-count" data-count>0</span>
  `;

  // ※ TDZ を避けるため refreshFabBadge は attachFab より先に宣言する
  const refreshFabBadge = async () => {
    try {
      const punches = await getTodayPunches();
      const el = fab.querySelector("[data-count]");
      if (el) el.textContent = String(punches.length);
    } catch {}
  };

  // body が無いタイミングがあるため待機
  const attachFab = () => {
    if (!document.body) {
      requestAnimationFrame(attachFab);
      return;
    }
    document.body.appendChild(fab);
    refreshFabBadge();
  };
  attachFab();

  // ストレージ変更を監視 (popup 側から削除した場合などにバッジ更新)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      refreshFabBadge();
    }
  });

  // ---------- モーダル ----------
  const showModal = async () => {
    const punches = await getTodayPunches();
    const type = determineType(punches.length);
    const time = nowHHMM();

    const overlay = document.createElement("div");
    overlay.className = "rakuro-puncher-overlay";
    overlay.innerHTML = `
      <div class="rakuro-puncher-modal" role="dialog" aria-modal="true">
        <h2>ラクロー打刻</h2>
        <div class="rakuro-puncher-info">
          <span class="label">本日の打刻回数</span>
          <span class="value">${punches.length} 回</span>
          <span class="label">種別</span>
          <span class="value"><span class="rakuro-puncher-type ${
            type === "出勤" ? "in" : "out"
          }">${type}</span></span>
          <span class="label">時刻</span>
          <span class="value rakuro-puncher-time-big">${time}</span>
        </div>
        <div class="rakuro-puncher-actions">
          <button type="button" class="rakuro-puncher-cancel">キャンセル</button>
          <button type="button" class="rakuro-puncher-confirm">${type}として打刻</button>
        </div>
        <div class="rakuro-puncher-history">
          <details ${punches.length > 0 ? "open" : ""}>
            <summary>本日の履歴 (${punches.length})</summary>
            <ul>
              ${
                punches.length === 0
                  ? "<li><span>まだ打刻はありません</span><span></span></li>"
                  : punches
                      .map(
                        (p, i) =>
                          `<li><span>${i + 1}. ${p.type}</span><span>${p.time}</span></li>`
                      )
                      .join("")
              }
            </ul>
          </details>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    overlay.querySelector(".rakuro-puncher-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener(
      "keydown",
      function escHandler(e) {
        if (e.key === "Escape") {
          close();
          document.removeEventListener("keydown", escHandler);
        }
      }
    );

    overlay.querySelector(".rakuro-puncher-confirm").addEventListener("click", async () => {
      try {
        await savePunch(type, time);
        close();
        const filled = tryFillForm(type, time);
        refreshFabBadge();
        if (filled) {
          showToast(`${type}を ${time} に記録し、自己申告時間に反映しました`);
        } else {
          showToast(`${type}を ${time} に記録しました (反映: 自己申告時間ページで実行)`);
        }
      } catch (err) {
        console.error("[raku-ro-puncher]", err);
        showToast("打刻に失敗しました", true);
      }
    });
  };

  fab.addEventListener("click", showModal);

  // ---------- 自己申告時間欄への自動入力 (ベストエフォート) ----------

  /**
   * デバッグログ。`window.__rakuroPuncherDebug = true` をコンソールで設定すると
   * 詳細を console.warn で出力する。
   * @param {string} msg
   * @param {unknown} [data]
   */
  const debugLog = (msg, data) => {
    if (window.__rakuroPuncherDebug) {
      // eslint-disable-next-line no-console
      console.warn("[raku-ro-puncher]", msg, data ?? "");
    }
  };

  /**
   * 今日の日付かどうかを判定する。
   * 「30」のような単独の数字は誤検知 (SVG タイムラインの目盛りなど) になるので
   * **必ず月を伴った形式 (4/30, 04/30, 4-30, 4月30, 2026-04-30, 30日)** を要求する。
   * @param {string} text
   * @returns {boolean}
   */
  const matchesToday = (text) => {
    if (!text) return false;
    const t = String(text).trim();
    if (!t) return false;
    const d = new Date();
    const dayNum = d.getDate();
    const monthNum = d.getMonth() + 1;
    const yyyy_mm_dd = `${d.getFullYear()}-${String(monthNum).padStart(2, "0")}-${String(
      dayNum
    ).padStart(2, "0")}`;

    // ISO 形式 (2026-04-30)
    if (t.includes(yyyy_mm_dd)) return true;
    // ◯日 (例: 30日) — 前後が数字でないこと
    if (new RegExp(`(?:^|[^0-9])${dayNum}日`).test(t)) return true;
    // 月/日 形式 (4/30, 04/30, 4-30, 04-30, 4月30 など)
    // 月にゼロパディングが付くケース (04/30) を許容するため `0?` を付ける
    // ただし `(?:^|[^0-9])` で先頭境界を確保し、`14/30` のような誤マッチは防ぐ
    const dd = String(dayNum).padStart(2, "0");
    const monthDayRe = new RegExp(
      `(?:^|[^0-9])0?${monthNum}\\s*[/月\\-]\\s*(?:${dd}|${dayNum})(?:[^0-9]|$)`
    );
    if (monthDayRe.test(t)) return true;
    return false;
  };

  /**
   * SVG ツリーの中にある要素かどうか (タイムラインの目盛り等を弾くため)
   * @param {Element} el
   * @returns {boolean}
   */
  const isInsideSvg = (el) => {
    let cur = /** @type {Element | null} */ (el);
    while (cur) {
      if (cur.tagName && cur.tagName.toLowerCase() === "svg") return true;
      cur = cur.parentElement;
    }
    return false;
  };

  /**
   * 今日の日付テキストを含む最も具体的な要素を返す。
   * SVG 内の要素は除外する。
   * @returns {HTMLElement | null}
   */
  const findTodayDateElement = () => {
    /** @type {HTMLElement[]} */
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const v = (n.nodeValue || "").trim();
        if (!v || v.length > 60) return NodeFilter.FILTER_REJECT;
        return matchesToday(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    /** @type {Node | null} */
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (isInsideSvg(parent)) continue; // SVG タイムラインの目盛りなどを除外
      candidates.push(parent);
    }
    if (candidates.length === 0) return null;
    // 表示されているものを優先、その上で短いテキスト = 具体的な日付セル
    const visible = candidates.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const list = visible.length > 0 ? visible : candidates;
    list.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    return list[0];
  };

  /**
   * 今日の "行" となる要素を返す (data-date のみで判定する厳密版)。
   * 見つからない場合は座標ベース検出にフォールバックされるため null OK。
   * @returns {HTMLElement | null}
   */
  const findTodayRow = () => {
    const d = new Date();
    const yyyy_mm_dd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

    // data-date / data-day 属性で完全一致
    const dataAttrCandidates = document.querySelectorAll(
      "[data-date], [data-day], [data-target-date], [data-work-date]"
    );
    for (const el of dataAttrCandidates) {
      const v =
        el.getAttribute("data-date") ||
        el.getAttribute("data-day") ||
        el.getAttribute("data-target-date") ||
        el.getAttribute("data-work-date") ||
        "";
      if (v.includes(yyyy_mm_dd)) {
        debugLog("data-date で今日の行を検出", el);
        return /** @type {HTMLElement} */ (el);
      }
    }
    // tr の場合のみ正攻法
    const trs = document.querySelectorAll("tr");
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll("td, th")).slice(0, 4);
      if (cells.some((c) => matchesToday((c.textContent || "").trim()))) {
        return /** @type {HTMLElement} */ (tr);
      }
    }
    return null;
  };

  /**
   * 座標ベース: 今日の日付セルと Y 軸が重なる input をすべて返す。
   * Vue / React の div グリッドレイアウト等、行 DOM が無いケース向け。
   * @returns {{dateEl: HTMLElement | null, inputs: HTMLInputElement[]}}
   */
  const findTodayInputsByCoord = () => {
    const dateEl = findTodayDateElement();
    if (!dateEl) return { dateEl: null, inputs: [] };
    const dr = dateEl.getBoundingClientRect();
    if (dr.height === 0) return { dateEl, inputs: [] };
    const dateMid = (dr.top + dr.bottom) / 2;
    const tolerance = Math.max(dr.height, 8) * 0.7;

    /** @type {{inp: HTMLInputElement, x: number}[]} */
    const matched = [];
    const all = /** @type {NodeListOf<HTMLInputElement>} */ (
      document.querySelectorAll("input")
    );
    for (const inp of all) {
      if (!isUsableInput(inp)) continue;
      const r = inp.getBoundingClientRect();
      if (r.height === 0 || r.width === 0) continue;
      const inpMid = (r.top + r.bottom) / 2;
      if (Math.abs(dateMid - inpMid) <= tolerance) {
        matched.push({ inp, x: r.left });
      }
    }
    matched.sort((a, b) => a.x - b.x);
    debugLog(`座標ベースで ${matched.length} 件の input を検出`, matched);
    return { dateEl, inputs: matched.map((m) => m.inp) };
  };

  /**
   * テーブルのヘッダー行から「列インデックス -> ヘッダーテキスト」のマップを取得。
   * rowspan / colspan を考慮して仮想グリッドを構築する。
   * (例: 始業 colspan=2 → 客観的記録 / 自己申告 のサブ見出しを「始業 客観的記録」「始業 自己申告」と結合)
   * @param {HTMLTableElement | null} table
   * @returns {string[]}
   */
  const buildHeaderMap = (table) => {
    if (!table) return [];
    const headerRows = Array.from(table.querySelectorAll("thead tr"));
    if (headerRows.length === 0) return [];

    /** @type {string[][]} grid[row][col] = テキスト */
    const grid = [];
    /** @type {Set<string>} 既に占有されているセル "row,col" */
    const occupied = new Set();

    headerRows.forEach((tr, rowIdx) => {
      grid[rowIdx] = grid[rowIdx] || [];
      let colIdx = 0;
      Array.from(tr.children).forEach((cell) => {
        // 既に rowspan で占有されている列はスキップ
        while (occupied.has(`${rowIdx},${colIdx}`)) colIdx++;

        const colspan = parseInt(cell.getAttribute("colspan") || "1", 10) || 1;
        const rowspan = parseInt(cell.getAttribute("rowspan") || "1", 10) || 1;
        const text = (cell.textContent || "").trim().replace(/\s+/g, " ");

        for (let r = 0; r < rowspan; r++) {
          for (let c = 0; c < colspan; c++) {
            grid[rowIdx + r] = grid[rowIdx + r] || [];
            grid[rowIdx + r][colIdx + c] = text;
            occupied.add(`${rowIdx + r},${colIdx + c}`);
          }
        }
        colIdx += colspan;
      });
    });

    // 各列について、上から下まで全行のテキストを結合
    const colCount = Math.max(...grid.map((r) => (r ? r.length : 0)), 0);
    /** @type {string[]} */
    const headers = [];
    for (let c = 0; c < colCount; c++) {
      const parts = [];
      for (let r = 0; r < grid.length; r++) {
        const v = grid[r] && grid[r][c];
        if (v && (parts.length === 0 || parts[parts.length - 1] !== v)) parts.push(v);
      }
      headers[c] = parts.join(" ");
    }
    return headers;
  };

  /**
   * 入力欄が始業/就業/その他のどれに該当するかを推定する。
   * @param {HTMLInputElement} inp
   * @param {string[]} headerMap
   * @returns {"start" | "end" | null}
   */
  const classifyInput = (inp, headerMap) => {
    const cell = inp.closest("td, th, [role='cell'], [role='gridcell']");
    let headerText = "";
    if (cell && headerMap.length > 0) {
      const idx = "cellIndex" in cell ? cell.cellIndex : -1;
      if (idx >= 0 && headerMap[idx]) headerText = headerMap[idx];
    }
    // ラベル要素 (label[for=...] / 親 label)
    let labelText = "";
    if (inp.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
      if (lab) labelText = (lab.textContent || "").trim();
    }
    const parentLabel = inp.closest("label");
    if (parentLabel) labelText += " " + (parentLabel.textContent || "");

    const meta = [
      inp.getAttribute("aria-label"),
      inp.getAttribute("placeholder"),
      inp.getAttribute("name"),
      inp.getAttribute("title"),
      inp.id,
      headerText,
      labelText,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (/始業|出勤|開始|start|in[^a-z]?time|begin/.test(meta)) return "start";
    if (/就業|終業|退勤|終了|end[^a-z]?time|finish|out[^a-z]?time/.test(meta)) return "end";
    return null;
  };

  /**
   * input が編集可能かを判定する。
   * 表示判定は緩める (click-to-edit な UI では非表示の input が裏側にあるパターンがあるため)
   * @param {HTMLInputElement} inp
   * @returns {boolean}
   */
  const isUsableInput = (inp) => {
    const t = (inp.type || "").toLowerCase();
    // type が明示的に hidden/checkbox/radio などの場合は除外、それ以外は受け付ける
    const blocked = [
      "hidden",
      "checkbox",
      "radio",
      "submit",
      "button",
      "reset",
      "file",
      "image",
      "color",
      "range",
    ];
    if (t && blocked.includes(t)) return false;
    if (inp.disabled || inp.readOnly) return false;
    return true;
  };

  /**
   * input に値をセットして React/Vue が拾えるようにイベントを発火する。
   * @param {HTMLInputElement | null | undefined} inp
   * @param {string} value
   * @returns {boolean}
   */
  const setInputValue = (inp, value) => {
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    inp.focus();
    if (setter) {
      setter.call(inp, value);
    } else {
      inp.value = value;
    }
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    inp.dispatchEvent(new Event("blur", { bubbles: true }));
    inp.classList.add("rakuro-puncher-filled");
    setTimeout(() => inp.classList.remove("rakuro-puncher-filled"), 2500);
    return true;
  };

  /**
   * input の x 座標から始業/就業を分類する。
   * 座標ベースで取得した input 群について、最左端 = 始業、最右端 = 就業 とする。
   * 始業 客観的記録 / 終業 客観的記録 の見出しテキストが近くにあれば優先する。
   * @param {HTMLInputElement[]} inputs (x 昇順済み)
   * @param {string[]} headerMap
   * @returns {{startInput: HTMLInputElement | null, endInput: HTMLInputElement | null}}
   */
  const classifyInputs = (inputs, headerMap) => {
    /** @type {HTMLInputElement | null} */
    let startInput = null;
    /** @type {HTMLInputElement | null} */
    let endInput = null;

    // 1. ラベル/属性ベースで分類
    for (const inp of inputs) {
      const kind = classifyInput(inp, headerMap);
      if (kind === "start" && !startInput) startInput = inp;
      else if (kind === "end" && !endInput) endInput = inp;
    }

    // 2. 座標ベースのフォールバック: 最左 = 始業, 最右 = 就業
    if (!startInput && inputs.length > 0) startInput = inputs[0];
    if (!endInput && inputs.length > 1) endInput = inputs[inputs.length - 1];

    // 3. 座標ベースで分類した結果が同じ input を指してしまったら、もう一方を別の input にずらす
    if (startInput && endInput && startInput === endInput && inputs.length >= 2) {
      const others = inputs.filter((i) => i !== startInput);
      endInput = others[others.length - 1] || endInput;
    }

    return { startInput, endInput };
  };

  /**
   * ラクロー固有: timecard-row[data-spec-date="YYYY-MM-DD"] 配下の
   * 始業 (.td-daytime) / 終業 (.td-latenight) の自己申告 input を直接取得する。
   * @returns {{row: HTMLElement | null, startInput: HTMLInputElement | null, endInput: HTMLInputElement | null} | null}
   */
  const detectRakuroTimecardInputs = () => {
    const d = new Date();
    const yyyy_mm_dd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    /** @type {HTMLElement | null} */
    const row = document.querySelector(`.timecard-row[data-spec-date="${yyyy_mm_dd}"]`);
    if (!row) {
      debugLog("ラクロー timecard-row[data-spec-date] が見つかりません", yyyy_mm_dd);
      return null;
    }
    /** @type {HTMLInputElement | null} */
    const startInput = row.querySelector(
      ".td-daytime input.timecard-input:not(.is-note), .td-daytime input[type='text']:not(.is-note)"
    );
    /** @type {HTMLInputElement | null} */
    const endInput = row.querySelector(
      ".td-latenight input.timecard-input:not(.is-note), .td-latenight input[type='text']:not(.is-note)"
    );
    return { row, startInput, endInput };
  };

  /**
   * 当日行の自己申告 始業 / 就業 入力欄を検出して返す。
   * 1. ラクロー固有セレクタ (.timecard-row[data-spec-date]) を最優先
   * 2. 失敗時のみ汎用ロジック (data-date / tr / 座標ベース) にフォールバック
   * @returns {{row: HTMLElement | null, startInput: HTMLInputElement | null, endInput: HTMLInputElement | null, strategy: string, inputCount: number}}
   */
  const detectTodayInputs = () => {
    // === ラクロー専用パス (最優先) ===
    const rakuro = detectRakuroTimecardInputs();
    if (rakuro && rakuro.row && (rakuro.startInput || rakuro.endInput)) {
      debugLog("ラクロー専用セレクタで検出", rakuro);
      const inputCount = rakuro.row.querySelectorAll("input.timecard-input:not(.is-note)").length;
      return {
        row: rakuro.row,
        startInput: rakuro.startInput,
        endInput: rakuro.endInput,
        strategy: "rakuro",
        inputCount,
      };
    }

    // === 汎用フォールバック ===
    /** @type {HTMLElement | null} */
    let row = findTodayRow();
    /** @type {HTMLInputElement[]} */
    let inputs = [];
    /** @type {HTMLTableElement | null} */
    let table = null;
    let strategy = "row";

    if (row) {
      table = row.closest("table");
      inputs = Array.from(row.querySelectorAll("input")).filter(isUsableInput);
      if (inputs.length === 0) {
        debugLog("行は見つかったが input が無いため座標ベースに切替", row);
        const coord = findTodayInputsByCoord();
        if (coord.inputs.length > 0) {
          inputs = coord.inputs;
          row = coord.dateEl;
          strategy = "row+coord";
        }
      }
    } else {
      const coord = findTodayInputsByCoord();
      row = coord.dateEl;
      inputs = coord.inputs;
      strategy = "coord";
    }

    if (!row || inputs.length === 0) {
      return { row, startInput: null, endInput: null, strategy, inputCount: inputs.length };
    }

    const headerMap = buildHeaderMap(table);
    debugLog("ヘッダーマップ", headerMap);
    debugLog(`戦略: ${strategy}, input 数: ${inputs.length}`, inputs);

    const { startInput, endInput } = classifyInputs(inputs, headerMap);
    debugLog("検出結果", { startInput, endInput });
    return { row, startInput, endInput, strategy, inputCount: inputs.length };
  };

  /**
   * 失敗時に毎回出す診断ログ (デバッグフラグに関わらず常に出す)。
   * @param {string} reason
   * @param {Record<string, unknown>} details
   */
  const failureLog = (reason, details) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[raku-ro-puncher] 自動入力に失敗:",
      reason,
      "\n詳細:",
      details,
      "\n対処法: 拡張ポップアップの「🔎 検出結果をハイライト (デバッグ)」を押して当日行 HTML を確認してください。"
    );
  };

  /**
   * 1回の打刻 (出勤 or 退勤) を該当する input に書き込む。
   * @param {"出勤" | "退勤"} type
   * @param {string} time HH:MM
   * @returns {boolean}
   */
  const tryFillForm = (type, time) => {
    const detection = detectTodayInputs();
    const { row, startInput, endInput, strategy, inputCount } = detection;
    if (!row) {
      failureLog("今日の行を検出できませんでした", { type, time, strategy });
      return false;
    }
    const target = type === "出勤" ? startInput : endInput;
    if (!target) {
      failureLog(`${type} の入力欄が見つかりません`, {
        type,
        time,
        strategy,
        inputCount,
        rowSnippet: row.outerHTML.slice(0, 800),
        startFound: !!startInput,
        endFound: !!endInput,
      });
      return false;
    }
    const ok = setInputValue(target, time);
    if (!ok) {
      failureLog("入力欄への書き込みに失敗", { type, time, target, strategy });
    }
    return ok;
  };

  /**
   * 当日履歴を全部まとめて 始業 / 就業 に反映する (popup から呼ばれる)。
   * @param {Array<{type: string, time: string}>} punches
   * @returns {{filled: number, reason?: string}}
   */
  const fillFromPunches = (punches) => {
    if (!punches || punches.length === 0) {
      return { filled: 0, reason: "本日の打刻履歴がありません" };
    }
    const { row, startInput, endInput } = detectTodayInputs();
    if (!row) return { filled: 0, reason: "本日の行を検出できませんでした" };

    const startTime = punches[0]?.time;
    const endTime = punches.length > 1 ? punches[punches.length - 1].time : null;

    let filled = 0;
    if (startTime && setInputValue(startInput, startTime)) filled++;
    if (endTime && setInputValue(endInput, endTime)) filled++;
    if (filled === 0) return { filled: 0, reason: "入力欄を検出できませんでした" };
    return { filled };
  };

  // ---------- トースト ----------
  const showToast = (msg, isError = false, ms = 3500) => {
    const toast = document.createElement("div");
    toast.className = "rakuro-puncher-toast" + (isError ? " error" : "");
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 280);
    }, ms);
  };

  // ---------- popup からのメッセージ受信 (再反映ボタン / デバッグ) ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "rakuro-fill-from-storage") {
      (async () => {
        const punches = await getTodayPunches();
        const result = fillFromPunches(punches);
        if (result.filled > 0) {
          showToast(`自己申告時間に反映しました (${result.filled}件)`);
          sendResponse({ ok: true, filled: result.filled });
        } else {
          showToast(result.reason || "入力欄を検出できませんでした", true);
          sendResponse({ ok: false, reason: result.reason });
        }
      })();
      return true; // async
    }

    if (msg.type === "rakuro-debug-detect") {
      const { row, startInput, endInput, strategy, inputCount } = detectTodayInputs();
      // 検出された要素をハイライト
      [row, startInput, endInput].forEach((el) => {
        if (!el) return;
        const orig = el.style.outline;
        el.style.outline = "3px solid #ef4444";
        setTimeout(() => {
          el.style.outline = orig;
        }, 4000);
      });
      sendResponse({
        ok: !!row,
        rowFound: !!row,
        startFound: !!startInput,
        endFound: !!endInput,
        strategy,
        inputCount,
        rowSnippet: row ? row.outerHTML.slice(0, 1500) : null,
      });
      return true;
    }
  });
})();
