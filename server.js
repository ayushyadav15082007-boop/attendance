const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HEARTBEAT_TIMEOUT_MS = 3_000_000;
const TOKEN_TTL_MS = 15 * 60 * 60 * 1000;
const envNumber = (name, fallback) => process.env[name] === undefined ? fallback : Number(process.env[name]);
const DEFAULT_CONFIG = {
  latitude: envNumber("CAMPUS_LATITUDE", 25.8316832),
  longitude: envNumber("CAMPUS_LONGITUDE", 82.6800657),
  radius: envNumber("CAMPUS_RADIUS", 100),
  label: "VBSPU Main Campus"
};
const sessions = new Map();
const loginAttempts = new Map();
let store;
let db;

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(self)",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  });
  next();
});
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || typeof storedHash !== "string") return false;
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function createDemoStore() {
  const demoPassword = process.env.DEMO_PASSWORD || "Demo123!";
  const students = [
    { rollNo: "230101", name: "Aarav Singh", branch: "Computer Science", className: "B.Tech · Semester 5" },
    { rollNo: "230102", name: "Ananya Yadav", branch: "Information Technology", className: "B.Tech · Semester 5" },
    { rollNo: "230103", name: "Rohan Mishra", branch: "Computer Science", className: "B.Tech · Semester 3" }
  ].map((student) => ({
    ...student,
    role: "student",
    passwordHash: hashPassword(demoPassword)
  }));
  return {
    config: DEFAULT_CONFIG,
    users: [
      ...students,
      {
        rollNo: "admin",
        name: "Portal Administrator",
        role: "admin",
        passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "Admin123!")
      }
    ],
    records: []
  };
}

function userDocumentId(rollNo) {
  return Buffer.from(rollNo).toString("base64url");
}

async function saveUser(user) {
  await db.collection("users").doc(userDocumentId(user.rollNo)).set(user);
}

async function saveRecord(record) {
  await db.collection("attendance").doc(record.id).set(record);
}

async function initializeStore() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT must contain the Firebase service-account JSON.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (error) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON.", { cause: error });
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = getFirestore();

  const configRef = db.collection("settings").doc("campus");
  const [configSnapshot, usersSnapshot, attendanceSnapshot] = await Promise.all([
    configRef.get(),
    db.collection("users").get(),
    db.collection("attendance").get()
  ]);
  const initial = createDemoStore();

  if (!configSnapshot.exists) await configRef.set(DEFAULT_CONFIG);
  if (usersSnapshot.empty) {
    const batch = db.batch();
    for (const user of initial.users) {
      batch.set(db.collection("users").doc(userDocumentId(user.rollNo)), user);
    }
    await batch.commit();
  }

  const loadedUsers = usersSnapshot.empty
    ? initial.users
    : usersSnapshot.docs.map((document) => document.data());
  return {
    config: configSnapshot.exists ? { ...DEFAULT_CONFIG, ...configSnapshot.data() } : DEFAULT_CONFIG,
    users: loadedUsers,
    records: attendanceSnapshot.docs.map((document) => document.data())
  };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusMeters = 6_371_000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const rawA = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const a = Math.min(1, Math.max(0, rawA));
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCoordinates(body) {
  const { latitude, longitude } = body || {};
  if (typeof latitude !== "number" || typeof longitude !== "number"
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }
  return { latitude, longitude };
}

function durationSeconds(record, now = Date.now()) {
  return Math.max(0, Math.floor(((record.exitTime ? Date.parse(record.exitTime) : now) - Date.parse(record.checkInTime)) / 1000));
}

function exitRecord(record, when = new Date()) {
  if (record.status !== "EXITED") {
    record.status = "EXITED";
    record.exitTime = when.toISOString();
    record.durationSpent = durationSeconds(record, when.getTime());
  }
}

async function expireStaleSessions() {
  const now = Date.now();
  const changed = [];
  for (const record of store.records) {
    if (record.status === "PRESENT" && now - Date.parse(record.lastActivePing) > HEARTBEAT_TIMEOUT_MS) {
      exitRecord(record, new Date(Date.parse(record.lastActivePing) + HEARTBEAT_TIMEOUT_MS));
      changed.push(saveRecord(record));
    }
  }
  await Promise.all(changed);
}

function safeUser(user) {
  return {
    rollNo: user.rollNo,
    name: user.name,
    branch: user.branch,
    className: user.className,
    role: user.role
  };
}

async function authenticate(req, res, next) {
  try {
    await expireStaleSessions();
  } catch (error) {
    return next(error);
  }
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return res.status(401).json({ error: "Please sign in again." });
  }
  req.user = store.users.find((user) => user.rollNo === session.rollNo);
  if (!req.user) return res.status(401).json({ error: "Account is no longer available." });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return res.status(403).json({ error: "You do not have permission to access this resource." });
    next();
  };
}

function publicRecord(record) {
  const student = store.users.find((user) => user.rollNo === record.rollNo);
  return {
    id: record.id,
    rollNo: record.rollNo,
    studentName: student ? student.name : "Unknown",
    branch: student ? student.branch : "",
    className: student ? student.className : "",
    date: record.date,
    checkInTime: record.checkInTime,
    lastActivePing: record.lastActivePing,
    exitTime: record.exitTime,
    durationSpent: record.status === "PRESENT" ? durationSeconds(record) : record.durationSpent,
    status: record.status
  };
}

function getDistance(coords) {
  return haversineMeters(coords.latitude, coords.longitude, store.config.latitude, store.config.longitude);
}

function todayString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip;
  const attempts = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 60_000 };
  if (attempts.resetAt < Date.now()) {
    attempts.count = 0;
    attempts.resetAt = Date.now() + 60_000;
  }
  if (attempts.count >= 10) return res.status(429).json({ error: "Too many sign-in attempts. Try again in a minute." });

  const { role, rollNo, name, branch, className, password } = req.body || {};
  if (!["student", "admin"].includes(role) || typeof password !== "string" || password.length > 200) {
    return res.status(400).json({ error: "Enter a valid role and password." });
  }
  const user = store.users.find((candidate) => candidate.rollNo === String(rollNo || "").trim()
    && candidate.role === role
    && verifyPassword(password, candidate.passwordHash));
  if (!user || (role === "student" && (
    user.name.toLowerCase() !== String(name || "").trim().toLowerCase()
    || (user.branch && user.branch !== String(branch || "").trim())
    || (user.className && user.className !== String(className || "").trim())
  ))) {
    attempts.count += 1;
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: "The login details do not match an account." });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { rollNo: user.rollNo, expiresAt: Date.now() + TOKEN_TTL_MS });
  res.json({ token, user: safeUser(user) });
});

app.post("/register", async (req, res, next) => {
  const { name, rollNo, password } = req.body || {};
  const normalizedName = typeof name === "string" ? name.trim() : "";
  const normalizedRollNo = typeof rollNo === "string" ? rollNo.trim() : "";
  if (!normalizedName || normalizedName.length > 100
      || !normalizedRollNo || normalizedRollNo.length > 40
      || typeof password !== "string" || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: "Enter a name, roll number, and password of at least 8 characters." });
  }
  if (store.users.some((user) => user.rollNo.toLowerCase() === normalizedRollNo.toLowerCase())) {
    return res.status(409).json({ error: "An account with that roll number already exists." });
  }

  const user = {
    rollNo: normalizedRollNo,
    name: normalizedName,
    branch: "",
    className: "",
    role: "student",
    passwordHash: hashPassword(password)
  };
  try {
    await saveUser(user);
    store.users.push(user);
    res.status(201).json({ message: "Registration successful. You can now sign in." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", authenticate, (req, res) => {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  sessions.delete(token);
  res.json({ ok: true });
});

app.get("/api/config", authenticate, (req, res) => {
  res.json(store.config);
});

app.put("/api/config", authenticate, requireRole("admin"), async (req, res, next) => {
  const { latitude, longitude, radius, label } = req.body || {};
  if (![latitude, longitude, radius].every(Number.isFinite)
      || latitude < -90 || latitude > 90
      || longitude < -180 || longitude > 180
      || radius < 10 || radius > 10_000) {
    return res.status(400).json({ error: "Enter valid coordinates and a radius from 10 to 10,000 meters." });
  }
  const config = {
    latitude,
    longitude,
    radius,
    label: typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : "Campus"
  };
  try {
    await db.collection("settings").doc("campus").set(config);
    store.config = config;
    res.json(store.config);
  } catch (error) {
    next(error);
  }
});

app.post("/api/attendance/ping", authenticate, requireRole("student"), async (req, res, next) => {
  const { action = "ping" } = req.body || {};
  if (!["start", "ping", "stop"].includes(action)) return res.status(400).json({ error: "Unknown attendance action." });
  const student = req.user;
  const active = store.records.find((record) => record.rollNo === student.rollNo && record.status === "PRESENT");
  if (action === "stop") {
    if (active) {
      exitRecord(active);
      try {
        await saveRecord(active);
      } catch (error) {
        return next(error);
      }
    }
    return res.json({ status: "EXITED", distance: null, record: active ? publicRecord(active) : null });
  }

  const coords = parseCoordinates(req.body);
  if (!coords) return res.status(400).json({ error: "A valid GPS location is required." });
  const distance = getDistance(coords);
  if (distance > store.config.radius) {
    if (active) {
      exitRecord(active);
      try {
        await saveRecord(active);
      } catch (error) {
        return next(error);
      }
    }
    return res.json({ status: "OUTSIDE", distance: Math.round(distance), record: active ? publicRecord(active) : null });
  }

  let record = active;
  const now = new Date();
  if (!record) {
    record = {
      id: crypto.randomUUID(),
      rollNo: student.rollNo,
      date: todayString(),
      checkInTime: now.toISOString(),
      lastActivePing: now.toISOString(),
      exitTime: null,
      durationSpent: 0,
      status: "PRESENT"
    };
  } else {
    record.lastActivePing = now.toISOString();
  }
  try {
    await saveRecord(record);
    if (!active) store.records.push(record);
    res.json({ status: "PRESENT", distance: Math.round(distance), record: publicRecord(record) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/attendance/live", authenticate, requireRole("admin"), (req, res) => {
  res.json(store.records.filter((record) => record.status === "PRESENT").map(publicRecord));
});

app.get("/api/attendance/logs", authenticate, (req, res) => {
  const filters = req.query;
  let records = store.records;
  if (req.user.role === "student") records = records.filter((record) => record.rollNo === req.user.rollNo);
  else {
    if (filters.branch) records = records.filter((record) => {
      const student = store.users.find((user) => user.rollNo === record.rollNo);
      return student && student.branch === filters.branch;
    });
    if (filters.className) records = records.filter((record) => {
      const student = store.users.find((user) => user.rollNo === record.rollNo);
      return student && student.className === filters.className;
    });
    if (filters.q) {
      const query = String(filters.q).toLowerCase();
      records = records.filter((record) => {
        const student = store.users.find((user) => user.rollNo === record.rollNo);
        return record.rollNo.toLowerCase().includes(query) || (student && student.name.toLowerCase().includes(query));
      });
    }
  }
  if (filters.date) records = records.filter((record) => record.date === filters.date);
  res.json(records.slice().sort((a, b) => Date.parse(b.checkInTime) - Date.parse(a.checkInTime)).map(publicRecord));
});

app.get("/api/attendance/options", authenticate, requireRole("admin"), (req, res) => {
  const students = store.users.filter((user) => user.role === "student");
  res.json({
    branches: [...new Set(students.map((user) => user.branch))].sort(),
    classes: [...new Set(students.map((user) => user.className))].sort(),
    totalStudents: students.length
  });
});

app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use((error, req, res, next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  res.status(status).json({ error: status === 500 ? "An unexpected server error occurred." : "The request body is invalid." });
});

initializeStore().then((loaded) => {
  store = loaded;
  app.listen(PORT, () => {
    console.log(`VBSPU Smart Attendance Portal listening on http://localhost:${PORT}`);
    if (!process.env.ADMIN_PASSWORD) console.warn("Using demo admin password; set ADMIN_PASSWORD before deployment.");
    if (!process.env.DEMO_PASSWORD) console.warn("Using demo student password; set DEMO_PASSWORD before deployment.");
  });
}).catch((error) => {
  console.error("Unable to initialize attendance data store:", error);
  process.exitCode = 1;
});

