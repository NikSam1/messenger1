# 💬 Messenger

Браузерный мессенджер с системой регистрации и подтверждения почты.

## Стек

| Часть       | Технологии                                      |
|-------------|--------------------------------------------------|
| **Backend** | Python 3.11+, FastAPI, aiosqlite, aiosmtplib, passlib[bcrypt], slowapi |
| **Frontend**| HTML5, CSS3, Vanilla JavaScript (без фреймворков)|
| **БД**      | SQLite (файл `backend/database.db`)              |

---

## Структура проекта

```
mes/
├── backend/
│   ├── main.py                  # Точка входа FastAPI
│   ├── database.py              # Инициализация SQLite
│   ├── models.py                # Pydantic-схемы запросов/ответов
│   ├── routers/
│   │   └── auth.py              # Маршруты /register, /verify-email, /resend-code
│   ├── services/
│   │   └── email_service.py     # Отправка писем через SMTP
│   ├── requirements.txt
│   ├── .env.example             # Шаблон переменных окружения
│   └── .env                     # Ваши настройки (не коммитить!)
└── frontend/
    ├── register.html            # Страница регистрации
    ├── verify.html              # Страница подтверждения почты
    ├── css/
    │   └── style.css
    └── js/
        ├── register.js
        └── verify.js
```

---

## Быстрый старт

### 1. Клонирование / открытие проекта

```bash
cd mes
```

### 2. Настройка бэкенда

#### 2.1 Создать виртуальное окружение

```bash
cd backend
python -m venv venv
```

Активация:
- **Windows:** `venv\Scripts\activate`
- **macOS / Linux:** `source venv/bin/activate`

#### 2.2 Установить зависимости

```bash
pip install -r requirements.txt
```

#### 2.3 Настроить переменные окружения

Скопируйте `.env.example` в `.env` и заполните своими данными:

```bash
cp .env.example .env
```

Откройте `.env` и отредактируйте:

```env
PORT=8000
FRONTEND_URL=http://127.0.0.1:5500

# SMTP (пример для Gmail)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM=Messenger <your_email@gmail.com>
```

> **Gmail:** включите двухфакторную аутентификацию и создайте
> [пароль приложения](https://myaccount.google.com/apppasswords).
> Используйте его в `SMTP_PASS` вместо обычного пароля.

#### 2.4 Запустить сервер

```bash
python main.py
```

Или через uvicorn с авто-перезагрузкой при изменении файлов:

```bash
uvicorn main:app --reload --port 8000
```

Сервер будет доступен по адресу: **http://localhost:8000**  
Документация API (Swagger UI): **http://localhost:8000/api/docs**

---

### 3. Запуск фронтенда

Откройте папку `frontend/` любым способом:

**Вариант A — VS Code Live Server (рекомендуется)**
1. Установите расширение [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer)
2. Откройте `frontend/register.html` и нажмите **Go Live**
3. Страница откроется на `http://127.0.0.1:5500`

**Вариант B — Python HTTP сервер**
```bash
cd frontend
python -m http.server 5500
```
Затем откройте: http://localhost:5500/register.html

---

## API эндпоинты

| Метод | URL | Описание |
|-------|-----|----------|
| `GET`  | `/` | Health check |
| `POST` | `/api/auth/register` | Регистрация нового пользователя |
| `POST` | `/api/auth/verify-email` | Подтверждение почты по коду |
| `POST` | `/api/auth/resend-code` | Повторная отправка кода |

### POST `/api/auth/register`

```json
// Запрос
{
  "username": "ivan_99",
  "email": "ivan@example.com",
  "password": "secret123"
}

// Успех 201
{ "message": "Код подтверждения отправлен на вашу почту" }

// Ошибки
// 400 — невалидные поля
// 409 — никнейм или почта уже заняты
// 500 — не удалось отправить письмо (проверьте SMTP)
```

### POST `/api/auth/verify-email`

```json
// Запрос
{
  "email": "ivan@example.com",
  "code": "482917"
}

// Успех 200
{ "message": "Почта подтверждена! Теперь вы можете войти." }

// Ошибки
// 400 — код неверный или истёк (живёт 10 минут)
```

### POST `/api/auth/resend-code`

```json
// Запрос
{ "email": "ivan@example.com" }

// Успех 200
{ "message": "Новый код отправлен на вашу почту" }

// Ошибки
// 404 — аккаунт не найден
// 429 — повторный запрос раньше чем через 60 секунд
```

---

## Правила валидации

| Поле | Правила |
|------|---------|
| Никнейм | 3–20 символов, только буквы, цифры, `_` |
| Email | Стандартный формат `user@domain.tld` |
| Пароль | Минимум 6 символов |
| Повтор пароля | Должен совпадать с паролем |

---

## Безопасность

- Пароли хранятся в виде **bcrypt**-хэшей (10 раундов)
- Коды подтверждения действительны **10 минут**
- Повторный запрос кода — не чаще **1 раза в 60 секунд**
- Rate limiting: `/api/auth/register` — 10 req/min, `/api/auth/resend-code` — 5 req/min
- CORS ограничен адресом из переменной `FRONTEND_URL`
- Файл `.env` **не должен попадать в репозиторий**

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `8000` | Порт сервера |
| `FRONTEND_URL` | `*` | Разрешённый origin для CORS |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP сервер |
| `SMTP_PORT` | `587` | SMTP порт |
| `SMTP_SECURE` | `false` | `true` для порта 465 (implicit TLS) |
| `SMTP_USER` | — | Логин SMTP |
| `SMTP_PASS` | — | Пароль / App Password |
| `SMTP_FROM` | — | Отображаемый отправитель |