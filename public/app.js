const tokenKey = "vbspuAttendanceToken";
const userKey = "vbspuAttendanceUser";
const form = document.querySelector("#login-form");
const errorBox = document.querySelector("#login-error");

if (localStorage.getItem(tokenKey) && localStorage.getItem(userKey)) {
  try {
    const user = JSON.parse(localStorage.getItem(userKey));
    if (user.role === "student") window.location.replace("/student.html");
  } catch {
    localStorage.removeItem(userKey);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Signing in…";
  const details = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...details, role: "student" })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to sign in.");
    localStorage.setItem(tokenKey, result.token);
    localStorage.setItem(userKey, JSON.stringify(result.user));
    window.location.assign("/student.html");
  } catch (error) {
    errorBox.textContent = error.message || "Unable to reach the server.";
    errorBox.hidden = false;
    button.disabled = false;
    button.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
  }
});
