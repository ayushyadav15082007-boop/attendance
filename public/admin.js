const TOKEN_KEY = "vbspuAttendanceToken";
const USER_KEY = "vbspuAttendanceUser";
const token = localStorage.getItem(TOKEN_KEY);
let user;
try { user = JSON.parse(localStorage.getItem(USER_KEY)); } catch { user = null; }
const loginView = document.querySelector("#admin-login-view");
const dashboard = document.querySelector("#admin-dashboard");
let refreshTimer;

if (token && user && user.role === "admin") {
  loginView.hidden = true;
  dashboard.hidden = false;
  initializeDashboard();
} else if (token) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const result = await response.json();
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.reload();
  }
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 4000);
}

document.querySelector("#admin-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = document.querySelector("#admin-login-error");
  const button = form.querySelector("button");
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), role: "admin" })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to sign in.");
    localStorage.setItem(TOKEN_KEY, result.token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    window.location.reload();
  } catch (error) {
    errorBox.textContent = error.message || "Unable to reach the server.";
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = "Sign in to dashboard →";
  }
});

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

function universityDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

function addCell(row, value, subtext) {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (subtext) {
    const small = document.createElement("small");
    small.textContent = subtext;
    cell.append(small);
  }
  row.append(cell);
}

function renderRecords(records) {
  const body = document.querySelector("#records-body");
  const empty = document.querySelector("#empty-records");
  body.replaceChildren();
  empty.hidden = records.length > 0;
  records.forEach((record) => {
    const row = document.createElement("tr");
    addCell(row, record.studentName, record.rollNo);
    addCell(row, record.branch, record.className);
    addCell(row, new Date(`${record.date}T00:00:00`).toLocaleDateString());
    addCell(row, formatTime(record.checkInTime));
    addCell(row, formatTime(record.lastActivePing));
    addCell(row, formatDuration(record.durationSpent));
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge${record.status === "PRESENT" ? "" : " exited"}`;
    badge.textContent = record.status === "PRESENT" ? "LIVE INSIDE" : "EXITED";
    statusCell.append(badge);
    row.append(statusCell);
    body.append(row);
  });
  document.querySelector("#record-count").textContent = `${records.length} ${records.length === 1 ? "record" : "records"}`;
}

async function refreshDashboard() {
  const params = new URLSearchParams();
  const branch = document.querySelector("#branch-filter").value;
  const className = document.querySelector("#class-filter").value;
  const date = document.querySelector("#date-filter").value;
  const q = document.querySelector("#search-filter").value.trim();
  if (branch) params.set("branch", branch);
  if (className) params.set("className", className);
  if (date) params.set("date", date);
  if (q) params.set("q", q);
  try {
    const [records, live, allRecords] = await Promise.all([
      api(`/api/attendance/logs?${params}`),
      api("/api/attendance/live"),
      api("/api/attendance/logs")
    ]);
    renderRecords(records);
    document.querySelector("#metric-active").textContent = live.length;
    document.querySelector("#metric-today").textContent = allRecords.filter((record) => record.date === universityDate()).length;
  } catch (error) {
    showToast(`Unable to refresh attendance data: ${error.message}`);
  }
}

async function loadFilters() {
  try {
    const options = await api("/api/attendance/options");
    for (const [id, values] of [["branch-filter", options.branches], ["class-filter", options.classes]]) {
      const select = document.querySelector(`#${id}`);
      values.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.append(option);
      });
    }
    document.querySelector("#metric-students").textContent = options.totalStudents;
  } catch (error) {
    showToast(`Unable to load dashboard filters: ${error.message}`);
  }
}

async function loadConfig() {
  try {
    const config = await api("/api/config");
    const form = document.querySelector("#config-form");
    for (const field of ["label", "latitude", "longitude", "radius"]) form.elements[field].value = config[field];
  } catch (error) {
    showToast(`Unable to load geofence settings: ${error.message}`);
  }
}

async function initializeDashboard() {
  await Promise.all([loadFilters(), loadConfig()]);
  await refreshDashboard();
  refreshTimer = window.setInterval(refreshDashboard, 10_000);
}

document.querySelectorAll("#search-filter,#branch-filter,#class-filter,#date-filter").forEach((control) => {
  control.addEventListener(control.id === "search-filter" ? "input" : "change", () => {
    window.clearTimeout(control._filterTimer);
    control._filterTimer = window.setTimeout(refreshDashboard, 250);
  });
});

document.querySelector("#export-button").addEventListener("click", async () => {
  try {
    const params = new URLSearchParams();
    for (const [key, id] of [["branch", "branch-filter"], ["className", "class-filter"], ["date", "date-filter"], ["q", "search-filter"]]) {
      const value = document.querySelector(`#${id}`).value.trim();
      if (value) params.set(key, value);
    }
    const records = await api(`/api/attendance/logs?${params}`);
    const columns = ["Student Name", "Roll No", "Branch", "Class", "Date", "Check-in Time", "Last Active Ping", "Exit Time", "Duration (seconds)", "Status"];
    const rows = records.map((r) => [r.studentName, r.rollNo, r.branch, r.className, r.date, formatTime(r.checkInTime), formatTime(r.lastActivePing), formatTime(r.exitTime), r.durationSpent, r.status]);
    const csv = [columns, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    link.download = `vbspu-attendance-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    showToast(`Unable to export attendance: ${error.message}`);
  }
});

document.querySelector("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#config-message");
  message.textContent = "";
  message.classList.remove("error");
  try {
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const config = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: fields.label,
        latitude: Number(fields.latitude),
        longitude: Number(fields.longitude),
        radius: Number(fields.radius)
      })
    });
    message.textContent = `Geofence saved: ${config.label} · ${config.radius} m radius`;
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  window.clearInterval(refreshTimer);
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* Clear local credentials even if the token expired. */ }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.location.replace("/admin.html");
});
