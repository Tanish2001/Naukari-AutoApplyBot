// ============================================================
// storage.js — shared profile + log helpers (chrome.storage)
// ============================================================

export const DEFAULT_PROFILE = {
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
};

export const DEFAULT_SETTINGS = {
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
};

export async function getProfile() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("profile", (data) => {
      resolve({ ...DEFAULT_PROFILE, ...(data.profile || {}) });
    });
  });
}

export async function saveProfile(profile) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ profile }, resolve);
  });
}

export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("settings", (data) => {
      resolve({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
    });
  });
}

export async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ settings }, resolve);
  });
}

// Applied job IDs (local, large set)
export async function getAppliedIds() {
  return new Promise((resolve) => {
    chrome.storage.local.get("appliedIds", (data) => {
      resolve(new Set(data.appliedIds || []));
    });
  });
}

export async function addAppliedId(jobId) {
  const ids = await getAppliedIds();
  ids.add(String(jobId));
  return new Promise((resolve) => {
    chrome.storage.local.set({ appliedIds: [...ids] }, resolve);
  });
}

// Application log (capped at 500 entries)
export async function getLog() {
  return new Promise((resolve) => {
    chrome.storage.local.get("appLog", (data) => {
      resolve(data.appLog || []);
    });
  });
}

export async function appendLog(entry) {
  const log = await getLog();
  log.unshift({ ...entry, time: new Date().toISOString() });
  const trimmed = log.slice(0, 500);
  return new Promise((resolve) => {
    chrome.storage.local.set({ appLog: trimmed }, resolve);
  });
}

export async function clearLog() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ appLog: [] }, resolve);
  });
}

// Stats
export async function getStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get("stats", (data) => {
      resolve(data.stats || { applied: 0, skipped: 0, failed: 0 });
    });
  });
}

export async function incrementStat(key) {
  const stats = await getStats();
  stats[key] = (stats[key] || 0) + 1;
  return new Promise((resolve) => {
    chrome.storage.local.set({ stats }, resolve);
  });
}
