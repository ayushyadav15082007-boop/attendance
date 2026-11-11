const TOKEN_KEY = "vbspuAttendanceToken";
const USER_KEY = "vbspuAttendanceUser";
const token = localStorage.getItem(TOKEN_KEY)||"test-token";
let user;
try {
  user = JSON.parse(localStorage.getItem(USER_KEY));
} catch {
  user = null;
}
if(!user){
  user = {
    name: "Test Student",
    rollNo: "123456",
    branch: "Computer Science",
    className: "B.Tech · Semester 3",
    role: "student"
  };
}
// if (!token || !user || user.role !== "student") window.location.replace("/");

const authHeaders = { Authorization: `Bearer ${token}` };
const sessionButton = document.querySelector("#session-button");
const presenceBadge = document.querySelector("#presence-badge");
let active = false;
let watchId = null;
let heartbeatTimer = null;
let latestPosition = null;
let sessionStart = null;
let timerInterval = null;
let sending = false;

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 4000);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...authHeaders, ...(options.headers || {}) }
  });
  const result = await response.json();
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.replace("/");
    throw new Error("Your session expired. Please sign in again.");
  }
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours, minutes, remaining].map((part) => String(part).padStart(2, "0")).join(":");
}

function distanceMeters(latitude, longitude, centerLatitude, centerLongitude) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = radians(centerLatitude - latitude);
  const deltaLongitude = radians(centerLongitude - longitude);
  const a = Math.min(1, Math.max(0,
    Math.sin(deltaLatitude / 2) ** 2
      + Math.cos(radians(latitude)) * Math.cos(radians(centerLatitude)) * Math.sin(deltaLongitude / 2) ** 2
  ));
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function setPresence(status, message, detail = "") {
  const inside = status === "PRESENT";
  presenceBadge.textContent = inside ? "PRESENT · IN CLASSROOM" : status === "OUTSIDE" ? "OUTSIDE CAMPUS" : "NOT ACTIVE";
  presenceBadge.classList.toggle("exited", !inside);
  document.querySelector("#gps-title").textContent = message;
  document.querySelector("#gps-detail").textContent = detail;
}

async function sendLocation(action = "ping") {
  if (!latestPosition || sending || !active) return;
  sending = true;
  try {
    const result = await api("/api/attendance/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        latitude: latestPosition.coords.latitude,
        longitude: latestPosition.coords.longitude
      })
    });
    document.querySelector("#distance-value").textContent = `${result.distance} m`;
    if (result.status === "PRESENT") {
      sessionStart = Date.parse(result.record.checkInTime);
      setPresence("PRESENT", "Inside campus geofence", `Within ${Math.round(window.campusConfig.radius)} m of ${window.campusConfig.label}.`);
      sessionButton.textContent = "Stop attendance session";
      await loadHistory();
    } else {
      active = false;
      clearTracking();
      setPresence("OUTSIDE", "Outside campus geofence", `You are ${result.distance} m from the campus center.`);
      sessionButton.innerHTML = 'Start attendance session <span aria-hidden="true">→</span>';
      if (result.record) showToast("You left the geofence. Your attendance session has ended.");
      await loadHistory();
    }
  } catch (error) {
    setPresence("OUTSIDE", "Location update failed", error.message);
    showToast(error.message);
  } finally {
    sending = false;
  }
}

function clearTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  if (timerInterval) window.clearInterval(timerInterval);
  watchId = null;
  heartbeatTimer = null;
  timerInterval = null;
}

function startTracking() {
  if (!navigator.geolocation) {
    showToast("This browser does not support location services.");
    return;
  }
  active = true;
  latestPosition = null;
  sessionButton.disabled = true;
  setPresence("DETECTING", "Detecting your location…", "Waiting for a GPS fix from your device.");
  watchId = navigator.geolocation.watchPosition((position) => {
    latestPosition = position;
    document.querySelector("#gps-detail").textContent = `GPS accuracy ±${Math.round(position.coords.accuracy)} m`;
    if (window.campusConfig) {
      const distance = distanceMeters(
        position.coords.latitude,
        position.coords.longitude,
        window.campusConfig.latitude,
        window.campusConfig.longitude
      );
      document.querySelector("#distance-value").textContent = `${Math.round(distance)} m`;
    }
    sendLocation(sessionStart ? "ping" : "start");
  }, async (error) => {
    active = false;
    clearTracking();
    setPresence("OUTSIDE", "Location unavailable", error.code === 1 ? "Location permission was denied. Allow location to check in." : "Check your device location settings and try again.");
    sessionButton.disabled = false;
    sessionButton.innerHTML = 'Start attendance session <span aria-hidden="true">→</span>';
    try {
      await api("/api/attendance/ping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
      await loadHistory();
    } catch (stopError) {
      showToast(`Could not close the server session: ${stopError.message}`);
    }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  heartbeatTimer = window.setInterval(() => {
    if (latestPosition) sendLocation("ping");
  }, 30_000);
  sessionButton.disabled = false;
  sessionButton.textContent = "Stop attendance session";
}

async function stopTracking() {
  active = false;
  clearTracking();
  sessionButton.disabled = true;
  try {
    await api("/api/attendance/ping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
    setPresence("EXITED", "Session ended", "Your attendance check-in has been recorded.");
    sessionStart = null;
    document.querySelector("#distance-value").textContent = "—";
    document.querySelector("#duration-value").textContent = "01:00:00";
    await loadHistory();
  } catch (error) {
    showToast(`Unable to stop your session: ${error.message}`);
  } finally {
    sessionButton.disabled = false;
    sessionButton.innerHTML = 'Start attendance session <span aria-hidden="true">→</span>';
  }
}

function renderHistory(records) {
  const list = document.querySelector("#history-list");
  const empty = document.querySelector("#history-empty");
  list.replaceChildren();
  empty.hidden = records.length > 0;
  records.slice(0, 6).forEach((record) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const day = document.createElement("span");
    day.className = "history-marker";
    day.textContent = record.status === "PRESENT" ? "●" : "✓";
    const detail = document.createElement("span");
    detail.className = "history-detail";
    const date = document.createElement("strong");
    date.textContent = new Date(`${record.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const times = document.createElement("small");
    times.textContent = `${new Date(record.checkInTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${formatDuration(record.durationSpent)}`;
    detail.append(date, times);
    item.append(day, detail);
    list.append(item);
  });
}

async function loadHistory() {
  try {
    renderHistory(await api("/api/attendance/logs"));
  } catch (error) {
    showToast(`Unable to load attendance history: ${error.message}`);
  }
}

async function initialize() {
  document.querySelector("#student-name").textContent = user.name;
  document.querySelector("#student-first-name").textContent = user.name.split(" ")[0];
  document.querySelector("#student-roll").textContent = `Roll number · ${user.rollNo}`;
  document.querySelector("#student-branch").textContent = user.branch;
  document.querySelector("#student-class").textContent = user.className;
  document.querySelector("#avatar-initials").textContent = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  document.querySelector("#student-subtitle").textContent = `${user.branch} · ${user.className}`;
  document.querySelector("#today-label").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  try {
    window.campusConfig = await api("/api/config");
    document.querySelector("#campus-label").textContent = window.campusConfig.label;
    await loadHistory();
  } catch (error) {
    showToast(`Unable to load portal settings: ${error.message}`);
  }
}

sessionButton.addEventListener("click", () => {
  if (active) stopTracking();
  else startTracking();
});
document.querySelector("#logout-button").addEventListener("click", async () => {
  if (active) await stopTracking();
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* The local session is cleared regardless. */ }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.location.replace("/");
});
window.addEventListener("beforeunload", () => {
  if (active) {
    fetch("/api/attendance/ping", {
      method: "POST",
      keepalive: true,
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" })
    });
  }
});
window.setInterval(() => {
  if (active && sessionStart) document.querySelector("#duration-value").textContent = formatDuration(Math.floor((Date.now() - sessionStart) / 1000));
}, 1000);
initialize();
