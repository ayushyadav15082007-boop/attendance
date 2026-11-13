# VBSPU Smart Attendance Portal

A mobile-friendly student attendance portal and staff dashboard built with Express, browser geolocation, and Cloud Firestore.

## Run locally

1. Install Node.js 18 or newer and create a Firebase project with Cloud Firestore enabled.
2. Create a Firebase service-account key with Firestore access.
3. Set `FIREBASE_SERVICE_ACCOUNT` to the complete service-account key as a JSON string. Keep this secret out of source control; configure it as an environment variable in Render.
4. From this folder, run `npm install` and then `npm start`.
5. Open [http://localhost:3000](http://localhost:3000). For location check-in, use `localhost` or serve the app over HTTPS. Browsers generally block geolocation on insecure origins.

The initial local demo accounts are:

| Role | Username / roll number | Password | Student details |
|---|---|---|---|
| Student | `230101` | `Demo123!` | Aarav Singh · Computer Science · B.Tech · Semester 5 |
| Student | `230102` | `Demo123!` | Ananya Yadav · Information Technology · B.Tech · Semester 5 |
| Student | `230103` | `Demo123!` | Rohan Mishra · Computer Science · B.Tech · Semester 3 |
| Admin | `admin` | `Admin123!` | — |

On first startup, the server creates `settings/campus` with the default geofence and seeds the `users` collection with the demo accounts when that collection is empty. Set `ADMIN_PASSWORD` and `DEMO_PASSWORD` before first startup to change seeded credentials. Add institution-approved student provisioning and authentication before a real deployment.

## Configuration

The initial geofence is configured with `CAMPUS_LATITUDE`, `CAMPUS_LONGITUDE`, and `CAMPUS_RADIUS` (meters; defaults: `25.8316832`, `82.6800657`, `100`). The default campus-center coordinates are based on the OpenStreetMap university listing (© OpenStreetMap contributors, ODbL). Confirm the exact approved classroom/campus coordinates before deployment. An authenticated administrator can change the label, center coordinates, and radius from the dashboard. Firestore stores the campus config in `settings/campus`, accounts in `users`, and attendance logs in `attendance`.

## Attendance behavior and limitations

- The server uses the Haversine formula to check each submitted coordinate against the configured geofence. The student page gets location permission only after the student starts a session and sends updates every 30 seconds.
- Moving outside the radius ends the active session. Sessions are also marked exited after 90 seconds without a successful heartbeat, covering a closed tab, lost connection, or revoked permission. A browser cannot guarantee a final request when it closes, so this timeout is authoritative.
- Browsers provide device-reported coordinates, not cryptographic proof of physical location. Mock-location tools, compromised devices, or modified clients can spoof GPS; this implementation is suitable as a local/demo system, not a high-assurance attendance control. Deploy with HTTPS, institutional identity verification, a managed database, backups, audit/retention policies, and appropriate privacy notices before production use.
- Bearer tokens expire after 12 hours or a server restart. The server loads Firestore data into memory at startup, so run a single app instance unless shared session handling and cross-instance data synchronization are added.

## API overview

- `POST /register` — Register a student with a name, roll number, and password; passwords are stored as salted scrypt hashes.
- `POST /api/auth/login` — Student/admin sign-in.
- `POST /api/attendance/ping` — Start/update/stop a student session; coordinates are validated server-side.
- `GET /api/attendance/live` — Active sessions (admin only).
- `GET /api/attendance/logs` — Attendance logs; students only see their own records; admins can filter by `branch`, `className`, `date`, and `q`.
- `GET /api/config`, `PUT /api/config` — Read geofence settings / update them (admin only for updates).
- `GET /api/attendance/options` — Admin filters and registered-student count.

Map data attribution: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
