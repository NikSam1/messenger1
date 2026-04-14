"use strict";

/* =========================================================
   register.js — логика страницы регистрации
   ========================================================= */

// ─── Получение элементов DOM ─────────────────────────────────────────────────

const form = document.getElementById("registerForm");
const usernameInput = document.getElementById("username");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const confirmInput = document.getElementById("confirmPassword");
const submitBtn = document.getElementById("submitBtn");
const formMessage = document.getElementById("formMessage");
const strengthBar = document.getElementById("strengthBar");
const strengthText = document.getElementById("strengthText");
const matchIndicator = document.getElementById("matchIndicator");

/* =========================================================
   ВАЛИДАЦИЯ
   ========================================================= */

/**
 * Валидация никнейма.
 * Допускаются латинские буквы, цифры, символ подчёркивания.
 * Длина: 3–20 символов.
 * @param {string} val
 * @returns {{ valid: boolean, error: string }}
 */
function validateUsername(val) {
  if (!val || val.trim().length === 0) {
    return { valid: false, error: "Никнейм обязателен" };
  }
  if (val.length < 3) {
    return {
      valid: false,
      error: "Никнейм должен содержать минимум 3 символа",
    };
  }
  if (val.length > 20) {
    return { valid: false, error: "Никнейм не может быть длиннее 20 символов" };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(val)) {
    return {
      valid: false,
      error: "Допускаются только буквы, цифры и символ «_»",
    };
  }
  return { valid: true, error: "" };
}

/**
 * Валидация email-адреса (расширенная RFC-подобная проверка).
 * @param {string} val
 * @returns {{ valid: boolean, error: string }}
 */
function validateEmail(val) {
  if (!val || val.trim().length === 0) {
    return { valid: false, error: "Email обязателен" };
  }
  // Расширенная проверка: локальная часть @ домен . TLD (2+ символа)
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(val.trim())) {
    return { valid: false, error: "Введите корректный email-адрес" };
  }
  return { valid: true, error: "" };
}

/**
 * Валидация пароля.
 * Минимальная длина: 6 символов.
 * @param {string} val
 * @returns {{ valid: boolean, error: string }}
 */
function validatePassword(val) {
  if (!val) {
    return { valid: false, error: "Пароль обязателен" };
  }
  if (val.length < 6) {
    return {
      valid: false,
      error: "Пароль должен содержать минимум 6 символов",
    };
  }
  return { valid: true, error: "" };
}

/**
 * Проверка совпадения пароля и его подтверждения.
 * @param {string} p1 — исходный пароль
 * @param {string} p2 — подтверждение пароля
 * @returns {{ valid: boolean, error: string }}
 */
function validatePasswordMatch(p1, p2) {
  if (!p2) {
    return { valid: false, error: "Подтвердите пароль" };
  }
  if (p1 !== p2) {
    return { valid: false, error: "Пароли не совпадают" };
  }
  return { valid: true, error: "" };
}

/* =========================================================
   СИЛА ПАРОЛЯ
   ========================================================= */

/**
 * Вычисляет «силу» пароля по нескольким критериям.
 * Возвращает числовой счёт (0–4), текстовую метку и цвет.
 * @param {string} password
 * @returns {{ score: number, label: string, color: string }}
 */
function getPasswordStrength(password) {
  if (!password) {
    return { score: 0, label: "", color: "transparent" };
  }

  let score = 0;

  // Критерии оценки
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  const isLong = password.length >= 12;
  const isMedium = password.length >= 8;

  if (hasLower) score++;
  if (hasUpper) score++;
  if (hasDigit) score++;
  if (hasSpecial) score++;
  if (isLong) score++; // бонус за длину

  // Нормализуем счёт до 4 уровней
  let level;
  if (score <= 1) {
    level = { score: 1, label: "Слабый", color: "#e05252" };
  } else if (score === 2) {
    level = { score: 2, label: "Средний", color: "#e0a652" };
  } else if (score === 3 || (score === 4 && !isMedium)) {
    level = { score: 3, label: "Хороший", color: "#52a8e0" };
  } else {
    level = { score: 4, label: "Надёжный", color: "#52c97a" };
  }

  return level;
}

/**
 * Обновляет визуальный индикатор силы пароля.
 * @param {string} password
 */
function updateStrengthBar(password) {
  if (!strengthBar || !strengthText) return;

  if (!password) {
    strengthBar.style.width = "0%";
    strengthBar.style.background = "transparent";
    strengthText.textContent = "";
    strengthText.style.color = "";
    return;
  }

  const { score, label, color } = getPasswordStrength(password);
  const widthMap = { 1: "25%", 2: "50%", 3: "75%", 4: "100%" };

  strengthBar.style.width = widthMap[score] || "0%";
  strengthBar.style.background = color;
  strengthText.textContent = label;
  strengthText.style.color = color;
}

/* =========================================================
   ПОКАЗ / СКРЫТИЕ ПАРОЛЯ
   ========================================================= */

/** SVG-иконка «глаз открыт» */
const iconEyeOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
  viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;

/** SVG-иконка «глаз закрыт» */
const iconEyeClosed = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
  viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8
           a18.45 18.45 0 0 1 5.06-5.94"/>
  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8
           a18.5 18.5 0 0 1-2.16 3.19"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;

/**
 * Переключает видимость пароля в поле ввода.
 * @param {HTMLInputElement} input — поле пароля
 * @param {HTMLButtonElement} btn  — кнопка-переключатель
 */
function togglePasswordVisibility(input, btn) {
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  btn.innerHTML = isHidden ? iconEyeClosed : iconEyeOpen;
  btn.setAttribute(
    "aria-label",
    isHidden ? "Скрыть пароль" : "Показать пароль",
  );
}

// Привязываем переключатели к кнопкам «глаз»
const togglePasswordBtn = document.getElementById("togglePassword");
const toggleConfirmBtn = document.getElementById("toggleConfirmPassword");

if (togglePasswordBtn) {
  togglePasswordBtn.addEventListener("click", () => {
    togglePasswordVisibility(passwordInput, togglePasswordBtn);
  });
}

if (toggleConfirmBtn) {
  toggleConfirmBtn.addEventListener("click", () => {
    togglePasswordVisibility(confirmInput, toggleConfirmBtn);
  });
}

/* =========================================================
   ОТОБРАЖЕНИЕ ОШИБОК НА ПОЛЯХ
   ========================================================= */

/**
 * Показывает инлайн-ошибку под полем ввода.
 * @param {HTMLInputElement} input
 * @param {string} message
 */
function showFieldError(input, message) {
  input.classList.add("error");
  input.classList.remove("success");

  // Ищем существующий элемент ошибки или создаём новый
  let errorEl = input.closest(".form-group")?.querySelector(".field-error");
  if (!errorEl) {
    errorEl = document.createElement("span");
    errorEl.className = "field-error";
    // Вставляем после враппера или после самого инпута
    const wrapper = input.closest(".input-wrapper") || input;
    wrapper.parentNode.insertBefore(errorEl, wrapper.nextSibling);
  }
  errorEl.textContent = message;
}

/**
 * Убирает инлайн-ошибку с поля ввода.
 * @param {HTMLInputElement} input
 */
function clearFieldError(input) {
  input.classList.remove("error");
  input.classList.add("success");

  const errorEl = input.closest(".form-group")?.querySelector(".field-error");
  if (errorEl) {
    errorEl.textContent = "";
  }
}

/**
 * Сбрасывает оба класса (при пустом поле — нейтральное состояние).
 * @param {HTMLInputElement} input
 */
function resetFieldState(input) {
  input.classList.remove("error", "success");
  const errorEl = input.closest(".form-group")?.querySelector(".field-error");
  if (errorEl) errorEl.textContent = "";
}

/* =========================================================
   АНИМАЦИЯ ТРЯСКИ (shake)
   ========================================================= */

/**
 * Добавляет класс анимации тряски к элементу, затем убирает его.
 * @param {HTMLElement} el
 */
function shakeElement(el) {
  el.classList.remove("shake"); // сброс, если уже применялась
  // Принудительный reflow для перезапуска анимации
  void el.offsetWidth;
  el.classList.add("shake");
  el.addEventListener("animationend", () => el.classList.remove("shake"), {
    once: true,
  });
}

/* =========================================================
   ВАЛИДАЦИЯ В РЕАЛЬНОМ ВРЕМЕНИ
   ========================================================= */

// Никнейм
usernameInput.addEventListener("input", () => {
  const val = usernameInput.value;
  if (!val) {
    resetFieldState(usernameInput);
    return;
  }
  const { valid, error } = validateUsername(val);
  valid ? clearFieldError(usernameInput) : showFieldError(usernameInput, error);
});

// Email
emailInput.addEventListener("input", () => {
  const val = emailInput.value;
  if (!val) {
    resetFieldState(emailInput);
    return;
  }
  const { valid, error } = validateEmail(val);
  valid ? clearFieldError(emailInput) : showFieldError(emailInput, error);
});

// Пароль + обновление индикатора силы
passwordInput.addEventListener("input", () => {
  const val = passwordInput.value;

  // Обновляем индикатор силы
  updateStrengthBar(val);

  if (!val) {
    resetFieldState(passwordInput);
    return;
  }
  const { valid, error } = validatePassword(val);
  valid ? clearFieldError(passwordInput) : showFieldError(passwordInput, error);

  // Если подтверждение уже заполнено — перепроверяем совпадение
  if (confirmInput.value) {
    updateMatchIndicator(val, confirmInput.value);
  }
});

// Подтверждение пароля + индикатор совпадения
confirmInput.addEventListener("input", () => {
  const val = confirmInput.value;
  if (!val) {
    resetFieldState(confirmInput);
    if (matchIndicator) matchIndicator.textContent = "";
    return;
  }
  updateMatchIndicator(passwordInput.value, val);
});

/**
 * Обновляет индикатор совпадения паролей.
 * @param {string} p1
 * @param {string} p2
 */
function updateMatchIndicator(p1, p2) {
  if (!matchIndicator) return;
  if (!p2) {
    matchIndicator.textContent = "";
    resetFieldState(confirmInput);
    return;
  }
  if (p1 === p2) {
    matchIndicator.textContent = "✓ Пароли совпадают";
    matchIndicator.style.color = "#52c97a";
    clearFieldError(confirmInput);
  } else {
    matchIndicator.textContent = "✗ Пароли не совпадают";
    matchIndicator.style.color = "#e05252";
    confirmInput.classList.add("error");
    confirmInput.classList.remove("success");
  }
}

/* =========================================================
   УПРАВЛЕНИЕ ГЛОБАЛЬНЫМ СООБЩЕНИЕМ ФОРМЫ
   ========================================================= */

/**
 * Показывает общее сообщение над/под формой.
 * @param {string} message  — текст сообщения
 * @param {'error'|'success'} type
 */
function showFormMessage(message, type = "error") {
  if (!formMessage) return;
  formMessage.textContent = message;
  formMessage.className = type === "success" ? "alert-success" : "alert-error";
  formMessage.style.display = "block";
  // Скроллим к сообщению
  formMessage.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Скрывает общее сообщение */
function hideFormMessage() {
  if (!formMessage) return;
  formMessage.style.display = "none";
  formMessage.textContent = "";
  formMessage.className = "";
}

/* =========================================================
   УПРАВЛЕНИЕ СОСТОЯНИЕМ КНОПКИ ОТПРАВКИ
   ========================================================= */

/**
 * Переводит кнопку в состояние загрузки.
 */
function setButtonLoading() {
  submitBtn.disabled = true;
  submitBtn.classList.add("loading");
  const spinner = submitBtn.querySelector(".spinner");
  if (spinner) spinner.style.display = "inline-block";
}

/**
 * Возвращает кнопку в нормальное состояние.
 */
function setButtonReady() {
  submitBtn.disabled = false;
  submitBtn.classList.remove("loading");
  const spinner = submitBtn.querySelector(".spinner");
  if (spinner) spinner.style.display = "none";
}

/* =========================================================
   ОТПРАВКА ФОРМЫ
   ========================================================= */

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideFormMessage();

  const username = usernameInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const confirm = confirmInput.value;

  // ── Полная валидация перед отправкой ──────────────────
  const checks = [
    { result: validateUsername(username), input: usernameInput },
    { result: validateEmail(email), input: emailInput },
    { result: validatePassword(password), input: passwordInput },
    { result: validatePasswordMatch(password, confirm), input: confirmInput },
  ];

  let hasErrors = false;
  checks.forEach(({ result, input }) => {
    if (!result.valid) {
      showFieldError(input, result.error);
      hasErrors = true;
    }
  });

  if (hasErrors) {
    // Трясём карточку, чтобы привлечь внимание
    const card = document.querySelector(".auth-card");
    if (card) shakeElement(card);
    return;
  }

  // ── Отправка запроса на сервер ────────────────────────
  setButtonLoading();

  try {
    const _API = window.APP_API || "http://localhost:8000";
    const response = await fetch(`${_API}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 201) {
      // Успех: сохраняем email для страницы верификации и переходим
      sessionStorage.setItem("pendingVerifyEmail", email);
      showFormMessage(
        "Аккаунт создан! Перенаправляем на подтверждение почты…",
        "success",
      );

      setTimeout(() => {
        window.location.href = "verify.html";
      }, 1200);
    } else {
      // Сервер вернул ошибку — показываем её текст
      // FastAPI возвращает ошибки в поле detail (строка или массив объектов)
      let errorText;
      if (typeof data.detail === "string") {
        errorText = data.detail;
      } else if (Array.isArray(data.detail) && data.detail.length > 0) {
        errorText = data.detail.map((e) => e.msg).join("; ");
      } else {
        errorText =
          data.message ||
          data.error ||
          `Ошибка сервера (${response.status}). Попробуйте ещё раз.`;
      }

      showFormMessage(errorText, "error");

      const card = document.querySelector(".auth-card");
      if (card) shakeElement(card);
    }
  } catch (networkError) {
    // Сетевая ошибка (сервер недоступен, нет интернета и т.д.)
    showFormMessage(
      "Не удалось подключиться к серверу. Проверьте интернет-соединение.",
      "error",
    );
    const card = document.querySelector(".auth-card");
    if (card) shakeElement(card);
  } finally {
    setButtonReady();
  }
});
