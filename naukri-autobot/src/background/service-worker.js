// ============================================================
// service-worker.js — background service worker
// ============================================================

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    // Set default settings on first install
    await chrome.storage.sync.set({
      settings: {
        botRunning: false,
        autoSubmit: true,
        pauseOnUnknown: true,
        humanDelay: true,
        delayMin: 5,
        delayMax: 15,
        skipExternal: true,
        skipAlreadyApplied: true,
        salaryFilter: false,
        remoteOnly: false,
        minExpMatch: true,
      },
      profile: {
        fullName: "",
        email: "",
        phone: "",
        totalExpYears: "",
        currentCTC: "",
        expectedCTC: "",
        noticePeriodDays: "30",
        currentLocation: "",
        preferredLocations: "",
        resumeHeadline: "",
      },
    });
    await chrome.storage.local.set({
      appLog: [],
      appliedIds: [],
      stats: { applied: 0, skipped: 0, failed: 0 },
    });
    console.log("[NaukriBot] Installed and defaults set.");
  }
});

// Relay messages between popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_TO_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message.payload);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tab: tabs[0] || null });
    });
    return true;
  }
});

// Keep service worker alive during bot runs using alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // No-op ping to keep SW alive
    console.log("[NaukriBot SW] keepAlive ping");
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "BOT_STARTED") {
    chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
  }
  if (msg.type === "BOT_STOPPED") {
    chrome.alarms.clear("keepAlive");
  }
});
