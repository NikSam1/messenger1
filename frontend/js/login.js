"use strict";
const API = window.APP_API || "http://localhost:8000";

// If already logged in, redirect
if (localStorage.getItem("token")) {
  window.location.href = "chat.html";
}

// DOM refs
const form = document.getElementById("loginForm");
const emailInput = document.getElementById("loginEmail");
const passwordInput = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginMessage = document.getElementById("loginMessage");
const toggleBtn = document.querySelector(".toggle-password");

// Eye toggle logic
if (toggleBtn) {
  toggleBtn.addEventListener("click", () => {
    const isHidden = passwordInput.type === "password";
    passwordInput.type = isHidden ? "text" : "password";
    const eyeOpen = toggleBtn.querySelector(".icon-eye");
    const eyeOff = toggleBtn.querySelector(".icon-eye-off");
    if (eyeOpen) eyeOpen.style.display = isHidden ? "none" : "";
    if (eyeOff) eyeOff.style.display = isHidden ? "" : "none";
  });
}

function showMessage(text, type) {
  loginMessage.textContent = text;
  loginMessage.className = type === "success" ? "alert-success" : "alert-error";
  loginMessage.style.display = "block";
}

function setLoading(loading) {
  loginBtn.disabled = loading;
  const spinner = loginBtn.querySelector(".spinner");
  const btnText = loginBtn.querySelector(".btn-text");
  if (spinner) spinner.style.display = loading ? "inline-block" : "none";
  if (btnText) btnText.textContent = loading ? "Вход..." : "Войти";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginMessage.style.display = "none";

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showMessage("Заполните все поля", "error");
    return;
  }

  setLoading(true);

  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      localStorage.setItem("token", data.access_token);
      localStorage.setItem("user", JSON.stringify(data.user));
      window.location.href = "chat.html";
    } else {
      const msg =
        typeof data.detail === "string"
          ? data.detail
          : Array.isArray(data.detail)
            ? data.detail.map((e) => e.msg).join("; ")
            : data.error || "Ошибка входа";
      showMessage(msg, "error");
    }
  } catch {
    showMessage("Не удалось подключиться к серверу", "error");
  } finally {
    setLoading(false);
  }
});
