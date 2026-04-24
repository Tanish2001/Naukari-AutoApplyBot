// popup.js — controller for the extension popup

(function () {
  "use strict";

  // ── Storage helpers ────────────────────────────────────────
  const getStorage = (keys) => new Promise((r) => chrome.storage.sync.get(keys, r));
  const setStorage = (obj) => new Promise((r) => chrome.storage.sync.set(obj, r));
  const getLocal = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  const setLocal = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

  // ── Tab navigation ─────────────────────────────────────────
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });

  // ── Naukri page check ──────────────────────────────────────
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    const onNaukri = tab?.url?.includes("naukri.com");
    document.getElementById("page-warn").style.display = onNaukri ? "none" : "block";
    document.getElementById("bot-btn").disabled = !onNaukri;
  });

  // ── Load and render stats ──────────────────────────────────
  async function loadStats() {
    const { stats = { applied: 0, skipped: 0, failed: 0 } } = await getLocal("stats");
    document.getElementById("stat-applied").textContent = stats.applied;
    document.getElementById("stat-skipped").textContent = stats.skipped;
    const q = await getLocal("botQueue");
    const queue = q.botQueue || [];
    document.getElementById("stat-queue").textContent = queue.length;
    renderQueue(queue);
  }

  function renderQueue(queue) {
    const section = document.getElementById("queue-section");
    const list = document.getElementById("queue-list");
    if (!queue.length) { section.style.display = "none"; return; }
    section.style.display = "block";
    list.innerHTML = queue.map((j, i) =>
      `<div style="padding:5px 0;border-bottom:0.5px solid var(--border);font-size:12px;color:var(--text)">
        <span style="color:var(--text3);margin-right:6px">${i + 1}.</span>
        <span style="font-weight:500">${j.title || "Unknown"}</span>
        <span style="color:var(--text3)"> @ ${j.company || ""}</span>
      </div>`
    ).join("");
  }

  document.getElementById("clear-queue-btn").addEventListener("click", async () => {
    await setLocal({ botQueue: [], botRunning: false });
    await loadStats();
    updateBotBtn();
  });

  // ── Load and render log ────────────────────────────────────
  async function loadLog() {
    const { appLog = [] } = await getLocal("appLog");
    renderLog(appLog);
  }

  function renderLog(log) {
    const list = document.getElementById("log-list");
    if (!log.length) {
      list.innerHTML = '<div class="log-empty">No applications yet.</div>';
      return;
    }
    list.innerHTML = log
      .slice(0, 50)
      .map((entry) => {
        const status = entry.status || "unknown";
        const time = entry.time ? new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
        return `
        <div class="log-item">
          <span class="pill pill-${status}">${status}</span>
          <div style="flex:1;min-width:0">
            <div class="log-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${entry.title || "Unknown role"}</div>
            <div class="log-sub">${entry.company || ""}</div>
          </div>
          <span class="log-time">${time}</span>
        </div>`;
      })
      .join("");
  }

  // Clear log
  document.getElementById("clear-log-btn").addEventListener("click", async () => {
    await setLocal({ appLog: [], stats: { applied: 0, skipped: 0, failed: 0 } });
    await loadLog();
    await loadStats();
  });

  // ── Bot start/stop ─────────────────────────────────────────
  let botRunning = false;

  async function loadBotState() {
    const { settings = {} } = await getStorage("settings");
    botRunning = settings.botRunning || false;
    updateBotBtn();
  }

  function updateBotBtn() {
    const btn = document.getElementById("bot-btn");
    const dot = document.getElementById("status-dot");
    if (botRunning) {
      btn.textContent = "■ Stop Bot";
      btn.className = "bot-btn stop";
      dot.classList.add("running");
    } else {
      btn.textContent = "▶ Start Bot";
      btn.className = "bot-btn start";
      dot.classList.remove("running");
    }
  }

  document.getElementById("bot-btn").addEventListener("click", async () => {
    botRunning = !botRunning;
    // Save state
    const { settings = {} } = await getStorage("settings");
    settings.botRunning = botRunning;
    await setStorage({ settings });
    updateBotBtn();

    // Send message to content script
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          type: botRunning ? "BOT_START" : "BOT_STOP",
        }).catch(() => {
          // Content script may not be ready — reload tab
        });
      }
    });

    // Notify background for alarm management
    chrome.runtime.sendMessage({
      type: botRunning ? "BOT_STARTED" : "BOT_STOPPED",
    });
  });

  // ── Profile load/save ──────────────────────────────────────
  const PROFILE_FIELDS = [
    "fullName", "email", "phone", "totalExpYears",
    "currentCTC", "expectedCTC", "noticePeriodDays",
    "currentCompany", "currentLocation", "preferredLocations",
    "dateOfBirth", "gender", "skills", "qualification",
    "linkedinUrl", "githubUrl", "portfolioUrl",
  ];

  async function loadProfile() {
    const { profile = {} } = await getStorage("profile");
    PROFILE_FIELDS.forEach((key) => {
      const el = document.getElementById(`p-${key}`);
      if (el && profile[key] !== undefined) el.value = profile[key];
    });
  }

  document.getElementById("save-profile-btn").addEventListener("click", async () => {
    const profile = {};
    PROFILE_FIELDS.forEach((key) => {
      const el = document.getElementById(`p-${key}`);
      if (el) profile[key] = el.value.trim();
    });
    await setStorage({ profile });
    // Notify content script of updated profile
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", profile }).catch(() => {});
      }
    });
    const saved = document.getElementById("profile-saved");
    saved.style.display = "block";
    setTimeout(() => (saved.style.display = "none"), 2000);
  });

  // ── Export profile ─────────────────────────────────────────
  document.getElementById("export-profile-btn").addEventListener("click", async () => {
    const { profile = {} } = await getStorage("profile");
    const json = JSON.stringify(profile, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "naukri-bot-profile.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Import profile ─────────────────────────────────────────
  document.getElementById("import-profile-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const profile = JSON.parse(text);
      await setStorage({ profile });
      // Populate fields in UI
      PROFILE_FIELDS.forEach((key) => {
        const el = document.getElementById(`p-${key}`);
        if (el && profile[key] !== undefined) el.value = profile[key];
      });
      const status = document.getElementById("import-status");
      status.style.display = "block";
      setTimeout(() => (status.style.display = "none"), 2000);
    } catch (err) {
      alert("Invalid JSON file");
    }
    // Reset input so same file can be re-imported
    e.target.value = "";
  });

  // ── Settings load/save ─────────────────────────────────────
  const SETTINGS_TOGGLES = [
    "skipExternal", "skipAlreadyApplied", "autoSubmit", "pauseOnUnknown", "humanDelay",
  ];

  async function loadSettings() {
    const { settings = {} } = await getStorage("settings");
    SETTINGS_TOGGLES.forEach((key) => {
      const el = document.getElementById(`s-${key}`);
      if (el) el.checked = settings[key] !== false; // default true
    });
    if (settings.delayMin) {
      document.getElementById("s-delayMin").value = settings.delayMin;
      document.getElementById("delay-min-out").textContent = settings.delayMin + "s";
    }
    if (settings.delayMax) {
      document.getElementById("s-delayMax").value = settings.delayMax;
      document.getElementById("delay-max-out").textContent = settings.delayMax + "s";
    }
    if (settings.keywords) {
      document.getElementById("s-keywords").value = settings.keywords.join(", ");
    }
    toggleDelayRow();
  }

  function toggleDelayRow() {
    const on = document.getElementById("s-humanDelay").checked;
    document.getElementById("delay-controls").style.display = on ? "block" : "none";
  }

  // Wire slider labels (CSP blocks inline oninput= in extension popups)
  document.getElementById("s-delayMin").addEventListener("input", function () {
    document.getElementById("delay-min-out").textContent = this.value + "s";
  });
  document.getElementById("s-delayMax").addEventListener("input", function () {
    document.getElementById("delay-max-out").textContent = this.value + "s";
  });
  document.getElementById("s-humanDelay").addEventListener("change", toggleDelayRow);

  document.getElementById("save-settings-btn").addEventListener("click", async () => {
    const settings = {};
    SETTINGS_TOGGLES.forEach((key) => {
      const el = document.getElementById(`s-${key}`);
      if (el) settings[key] = el.checked;
    });
    settings.delayMin = parseInt(document.getElementById("s-delayMin").value, 10);
    settings.delayMax = parseInt(document.getElementById("s-delayMax").value, 10);
    settings.botRunning = botRunning;
    // Keywords — store as array of lowercase trimmed strings
    const kwRaw = document.getElementById("s-keywords").value;
    settings.keywords = kwRaw.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);

    await setStorage({ settings });

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", settings }).catch(() => {});
      }
    });

    const saved = document.getElementById("settings-saved");
    saved.style.display = "block";
    setTimeout(() => (saved.style.display = "none"), 2000);
  });

  // ── Live updates from content script ──────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "LOG_UPDATE") loadLog();
    if (msg.type === "STATS_UPDATE") loadStats();
  });

  // ── Storage change listener (cross-tab updates) ────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.appLog) renderLog(changes.appLog.newValue || []);
      if (changes.stats) {
        const s = changes.stats.newValue || {};
        document.getElementById("stat-applied").textContent = s.applied || 0;
        document.getElementById("stat-skipped").textContent = s.skipped || 0;
      }
      if (changes.botQueue) {
        const queue = changes.botQueue.newValue || [];
        document.getElementById("stat-queue").textContent = queue.length;
        renderQueue(queue);
      }
    }
  });

  // ── Init ───────────────────────────────────────────────────
  loadStats();
  loadLog();
  loadBotState();
  loadProfile();
  loadSettings();
})();
