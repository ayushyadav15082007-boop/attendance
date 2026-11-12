const form = document.querySelector("#register-form");
const message = document.querySelector("#register-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.hidden = true;
  message.classList.remove("success");
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Creating account…";

  try {
    const response = await fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to register.");
    message.textContent = result.message;
    message.classList.add("success");
    message.hidden = false;
    form.reset();
  } catch (error) {
    message.textContent = error.message || "Unable to reach the server.";
    message.hidden = false;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Create account <span aria-hidden="true">→</span>';
  }
});
