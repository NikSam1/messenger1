/**
 * verify.js — логика страницы подтверждения email
 * Обрабатывает ввод OTP-кода, отправку и повторную отправку
 */

"use strict";

/* ─────────────────────────────────────────────
   Константы и глобальные переменные
───────────────────────────────────────────── */

const API_BASE = (window.APP_API || "http://localhost:8000") + "/api/auth";
const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;

let countdownTimer = null; // Идентификатор интервала обратного отсчёта
let currentEmail = ""; // Email текущего пользователя

/* ─────────────────────────────────────────────
   Ссылки на DOM-элементы
───────────────────────────────────────────── */

const emailDisplay = document.getElementById("emailDisplay");
const codeInputs = Array.from(document.querySelectorAll(".code-input"));
const verifyBtn = document.getElementById("verifyBtn");
const verifyMessage = document.getElementById("verifyMessage");
const resendBtn = document.getElementById("resendBtn");
const resendCountdown = document.getElementById("resendCountdown");
const verifyForm = document.getElementById("verifyForm");
const authCard = document.querySelector(".auth-card");

/* ─────────────────────────────────────────────
   Инициализация при загрузке страницы
───────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  // Получаем email из sessionStorage
  const storedEmail = sessionStorage.getItem("pendingVerifyEmail");

  if (!storedEmail) {
    // Email не найден — перенаправляем на регистрацию
    window.location.href = "register.html";
    return;
  }

  currentEmail = storedEmail;

  // Отображаем email на странице
  if (emailDisplay) {
    emailDisplay.textContent = currentEmail;
  }

  // Фокусируем первое поле ввода
  if (codeInputs.length > 0) {
    codeInputs[0].focus();
  }

  // Запускаем обратный отсчёт для повторной отправки
  startCountdown(RESEND_SECONDS);

  // Вешаем обработчики на поля OTP
  setupCodeInputs();

  // Обработчик формы
  if (verifyForm) {
    verifyForm.addEventListener("submit", handleVerifySubmit);
  }

  // Обработчик кнопки повторной отправки
  if (resendBtn) {
    resendBtn.addEventListener("click", handleResend);
  }
});

/* ─────────────────────────────────────────────
   Обратный отсчёт для повторной отправки
───────────────────────────────────────────── */

/**
 * Запускает обратный отсчёт на заданное количество секунд.
 * Пока идёт отсчёт — кнопка «Отправить повторно» заблокирована.
 * По истечении времени кнопка активируется.
 *
 * @param {number} seconds - Количество секунд для отсчёта
 */
function startCountdown(seconds) {
  // Очищаем предыдущий таймер, если он был
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  // Блокируем кнопку на время отсчёта
  resendBtn.disabled = true;
  resendBtn.classList.add("disabled");

  let remaining = seconds;

  // Сразу показываем первое значение
  updateCountdownDisplay(remaining);

  countdownTimer = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      // Отсчёт завершён
      clearInterval(countdownTimer);
      countdownTimer = null;

      resendBtn.disabled = false;
      resendBtn.classList.remove("disabled");

      if (resendCountdown) {
        resendCountdown.textContent = "";
      }
    } else {
      updateCountdownDisplay(remaining);
    }
  }, 1000);
}

/**
 * Обновляет текст обратного отсчёта.
 *
 * @param {number} seconds - Оставшееся количество секунд
 */
function updateCountdownDisplay(seconds) {
  if (resendCountdown) {
    resendCountdown.textContent = `Повторить через ${seconds}с`;
  }
}

/* ─────────────────────────────────────────────
   Логика OTP-полей ввода
───────────────────────────────────────────── */

/**
 * Навешивает все обработчики событий на поля ввода OTP-кода.
 */
function setupCodeInputs() {
  codeInputs.forEach((input, index) => {
    // Событие ввода символа
    input.addEventListener("input", (e) => handleCodeInput(e, index));

    // Событие нажатия клавиши (для Backspace)
    input.addEventListener("keydown", (e) => handleCodeKeydown(e, index));

    // Событие вставки из буфера обмена
    input.addEventListener("paste", (e) => handleCodePaste(e));

    // При фокусе выделяем содержимое поля
    input.addEventListener("focus", () => {
      input.select();
    });
  });
}

/**
 * Обрабатывает ввод символа в OTP-поле.
 * Пропускает только цифры, автоматически переходит к следующему полю.
 *
 * @param {InputEvent} e     - Событие ввода
 * @param {number}     index - Индекс текущего поля
 */
function handleCodeInput(e, index) {
  const input = codeInputs[index];
  let value = input.value;

  // Оставляем только цифры
  value = value.replace(/\D/g, "");

  // Берём только последний введённый символ
  if (value.length > 1) {
    value = value.slice(-1);
  }

  input.value = value;

  // Если цифра введена — переходим к следующему полю
  if (value.length === 1 && index < CODE_LENGTH - 1) {
    codeInputs[index + 1].focus();
  }

  // Сбрасываем сообщение об ошибке при вводе
  clearMessage();
}

/**
 * Обрабатывает нажатие клавиши в OTP-поле.
 * При нажатии Backspace на пустом поле переходим к предыдущему.
 *
 * @param {KeyboardEvent} e     - Событие клавиши
 * @param {number}        index - Индекс текущего поля
 */
function handleCodeKeydown(e, index) {
  if (e.key === "Backspace") {
    const input = codeInputs[index];

    if (input.value === "" && index > 0) {
      // Поле пустое — переходим назад и очищаем предыдущее
      e.preventDefault();
      codeInputs[index - 1].value = "";
      codeInputs[index - 1].focus();
    }
  }

  // Переход по стрелкам влево/вправо
  if (e.key === "ArrowLeft" && index > 0) {
    e.preventDefault();
    codeInputs[index - 1].focus();
  }
  if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) {
    e.preventDefault();
    codeInputs[index + 1].focus();
  }
}

/**
 * Обрабатывает вставку текста из буфера обмена.
 * Распределяет цифры по полям, начиная с первого.
 *
 * @param {ClipboardEvent} e - Событие вставки
 */
function handleCodePaste(e) {
  e.preventDefault();

  const pasted = e.clipboardData.getData("text");
  // Извлекаем только цифры из вставленного текста
  const digits = pasted.replace(/\D/g, "").slice(0, CODE_LENGTH);

  if (digits.length === 0) return;

  // Распределяем цифры по полям
  digits.split("").forEach((digit, i) => {
    if (codeInputs[i]) {
      codeInputs[i].value = digit;
    }
  });

  // Фокусируем следующее пустое поле или последнее заполненное
  const nextEmpty =
    digits.length < CODE_LENGTH ? digits.length : CODE_LENGTH - 1;
  codeInputs[nextEmpty].focus();
}

/**
 * Собирает введённый код из всех полей в одну строку.
 *
 * @returns {string} - Строка из 0-6 цифр
 */
function getEnteredCode() {
  return codeInputs.map((input) => input.value).join("");
}

/**
 * Очищает все поля OTP и фокусирует первое.
 */
function clearCodeInputs() {
  codeInputs.forEach((input) => {
    input.value = "";
  });
  codeInputs[0].focus();
}

/* ─────────────────────────────────────────────
   Отправка формы подтверждения
───────────────────────────────────────────── */

/**
 * Обрабатывает отправку формы подтверждения кода.
 *
 * @param {SubmitEvent} e - Событие отправки формы
 */
async function handleVerifySubmit(e) {
  e.preventDefault();

  const code = getEnteredCode();

  // Проверяем, что код введён полностью
  if (code.length < CODE_LENGTH) {
    showMessage("Пожалуйста, введите все 6 цифр кода.", "error");
    shakeElement(document.querySelector(".code-inputs"));
    // Фокусируем первое незаполненное поле
    const firstEmpty = codeInputs.findIndex((input) => input.value === "");
    if (firstEmpty !== -1) {
      codeInputs[firstEmpty].focus();
    }
    return;
  }

  // Показываем состояние загрузки
  setVerifyButtonLoading(true);
  clearMessage();

  try {
    const response = await fetch(`${API_BASE}/verify-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: currentEmail,
        code: code,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      // Успешное подтверждение
      showMessage("✓ Почта подтверждена! Перенаправляем...", "success");

      // Очищаем sessionStorage
      sessionStorage.removeItem("pendingVerifyEmail");

      // Перенаправляем через 2 секунды
      setTimeout(() => {
        window.location.href = "login.html";
      }, 2000);
    } else {
      // Ошибка от сервера
      let errorText;
      if (typeof data.detail === "string") {
        errorText = data.detail;
      } else if (Array.isArray(data.detail) && data.detail.length > 0) {
        errorText = data.detail.map((e) => e.msg).join("; ");
      } else {
        errorText =
          data.message ||
          data.error ||
          "Неверный или истёкший код. Попробуйте ещё раз.";
      }
      showMessage(errorText, "error");
      shakeElement(document.querySelector(".code-inputs"));
      clearCodeInputs();
    }
  } catch (err) {
    // Сетевая ошибка
    showMessage(
      "Не удалось подключиться к серверу. Проверьте соединение.",
      "error",
    );
    shakeElement(document.querySelector(".code-inputs"));
    console.error("Ошибка сети:", err);
  } finally {
    setVerifyButtonLoading(false);
  }
}

/* ─────────────────────────────────────────────
   Повторная отправка кода
───────────────────────────────────────────── */

/**
 * Обрабатывает нажатие кнопки «Отправить повторно».
 */
async function handleResend() {
  if (resendBtn.disabled) return;

  // Блокируем кнопку сразу, чтобы не допустить двойного нажатия
  resendBtn.disabled = true;

  clearMessage();

  try {
    const response = await fetch(`${API_BASE}/resend-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: currentEmail,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      // Успешная повторная отправка
      showMessage("Новый код отправлен. Проверьте почту.", "success");
      clearCodeInputs();
      // Перезапускаем отсчёт
      startCountdown(RESEND_SECONDS);
    } else {
      let errorText;
      if (typeof data.detail === "string") {
        errorText = data.detail;
      } else if (Array.isArray(data.detail) && data.detail.length > 0) {
        errorText = data.detail.map((e) => e.msg).join("; ");
      } else {
        errorText =
          data.message ||
          data.error ||
          "Не удалось отправить код. Попробуйте позже.";
      }

      showMessage(errorText, "error");
      // Снова разблокируем кнопку при ошибке
      resendBtn.disabled = false;
    }
  } catch (err) {
    showMessage(
      "Не удалось подключиться к серверу. Проверьте соединение.",
      "error",
    );
    resendBtn.disabled = false;
    console.error("Ошибка сети:", err);
  }
}

/* ─────────────────────────────────────────────
   Вспомогательные функции UI
───────────────────────────────────────────── */

/**
 * Устанавливает состояние загрузки для кнопки подтверждения.
 *
 * @param {boolean} loading - true — показать спиннер, false — скрыть
 */
function setVerifyButtonLoading(loading) {
  if (!verifyBtn) return;

  const spinner = verifyBtn.querySelector(".spinner");
  const btnText = verifyBtn.querySelector(".btn-text");

  if (loading) {
    verifyBtn.disabled = true;
    if (spinner) spinner.style.display = "inline-block";
    if (btnText) btnText.textContent = "Проверка...";
  } else {
    verifyBtn.disabled = false;
    if (spinner) spinner.style.display = "none";
    if (btnText) btnText.textContent = "Подтвердить";
  }
}

/**
 * Показывает информационное сообщение под формой.
 *
 * @param {string} text - Текст сообщения
 * @param {'error'|'success'} type - Тип сообщения
 */
function showMessage(text, type) {
  if (!verifyMessage) return;

  verifyMessage.textContent = text;
  verifyMessage.className = ""; // Сбрасываем классы
  verifyMessage.classList.add(
    type === "success" ? "alert-success" : "alert-error",
  );
  verifyMessage.style.display = "block";
}

/**
 * Скрывает информационное сообщение.
 */
function clearMessage() {
  if (!verifyMessage) return;
  verifyMessage.style.display = "none";
  verifyMessage.textContent = "";
}

/**
 * Запускает анимацию тряски для указанного элемента.
 *
 * @param {HTMLElement|null} element - Элемент для анимации
 */
function shakeElement(element) {
  if (!element) return;

  element.classList.remove("shake");
  // Форсируем перерисовку, чтобы анимация сработала повторно
  void element.offsetWidth;
  element.classList.add("shake");

  // Удаляем класс после завершения анимации
  element.addEventListener(
    "animationend",
    () => {
      element.classList.remove("shake");
    },
    { once: true },
  );
}
