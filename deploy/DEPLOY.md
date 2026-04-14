# 🚀 Руководство по развёртыванию Messenger

В этом файле описаны **два способа** запустить сайт в интернете:

| Способ | Сложность | Цена | Подходит для |
|---|---|---|---|
| [Railway.app](#способ-1-railwayapp--самый-быстрый) | ⭐ Легко | Бесплатно / ~$5/мес | Быстрого старта |
| [VPS + Nginx](#способ-2-vps--nginx--рекомендуется) | ⭐⭐⭐ Средне | ~€5-10/мес | Продакшна |

---

## Подготовка (общая для обоих способов)

### 1. Установи Git

Скачай с [git-scm.com](https://git-scm.com/) и установи.

### 2. Залей проект на GitHub

```bash
cd mes
git init
git add .
git commit -m "Initial commit"
```

Создай репозиторий на [github.com](https://github.com/new), затем:

```bash
git remote add origin https://github.com/ТВО_ИМЯ/messenger.git
git branch -M main
git push -u origin main
```

> ⚠️ Файл `backend/.env` **не попадёт** в GitHub (он в `.gitignore`) — это правильно!

---

## Способ 1: Railway.app — самый быстрый

Railway запустит бэкенд в контейнере за несколько кликов.
Для фронтенда используем Vercel (бесплатно).

### Шаг 1 — Деплой бэкенда на Railway

1. Зайди на [railway.app](https://railway.app) и зарегистрируйся (можно через GitHub)
2. Нажми **"New Project"** → **"Deploy from GitHub repo"**
3. Выбери свой репозиторий `messenger`
4. Railway спросит какую папку использовать — укажи **`backend`**
5. Дождись сборки (1-2 минуты)

#### Настрой переменные окружения в Railway

В разделе **Variables** добавь:

```
PORT=8000
FRONTEND_URL=https://ТВО_ПРИЛОЖЕНИЕ.vercel.app
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=твоя_почта@gmail.com
SMTP_PASS=пароль_приложения_gmail
SMTP_FROM=Messenger <твоя_почта@gmail.com>
JWT_SECRET=замени_на_случайную_строку_минимум_32_символа
ADMIN_EMAIL=твоя_почта@gmail.com
```

> 💡 Для `JWT_SECRET` сгенерируй случайную строку:
> ```python
> python -c "import secrets; print(secrets.token_hex(32))"
> ```

6. В разделе **Settings** → **Networking** нажми **"Generate Domain"**
7. Скопируй URL вида `https://messenger-production-xxxx.up.railway.app`

### Шаг 2 — Деплой фронтенда на Vercel

1. Зайди на [vercel.com](https://vercel.com) и войди через GitHub
2. Нажми **"New Project"** → выбери репозиторий `messenger`
3. В настройках:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Other
   - Build command: *(оставь пустым)*
   - Output directory: *(оставь пустым)*
4. Нажми **"Deploy"**
5. Скопируй URL вида `https://messenger-xxxx.vercel.app`

### Шаг 3 — Свяжи фронтенд с бэкендом

Вернись в Railway → Variables, обнови:
```
FRONTEND_URL=https://messenger-xxxx.vercel.app
```

### Шаг 4 — Обнови config.js (Railway URL)

Открой `frontend/js/config.js` и добавь свой Railway URL:

```javascript
// Временный способ для Railway+Vercel (разные домены)
if (isLocal) {
  window.APP_API = "http://localhost:8000";
  window.APP_WS  = "ws://localhost:8000/ws";
} else {
  window.APP_API = "https://ТВОЙ-URL.up.railway.app";
  window.APP_WS  = "wss://ТВОЙ-URL.up.railway.app/ws";
}
```

Закоммить и запушить:
```bash
git add .
git commit -m "Set production API URLs"
git push
```

Vercel и Railway подхватят изменения автоматически.

---

## Способ 2: VPS + Nginx — рекомендуется

Этот способ даёт полный контроль, работает надёжнее и дешевле при росте.

### Где взять VPS

| Провайдер | Цена | Рекомендую |
|---|---|---|
| [Hetzner](https://www.hetzner.com/cloud) | от €3.79/мес | ✅ Лучшее соотношение |
| [DigitalOcean](https://digitalocean.com) | от $6/мес | ✅ Удобно |
| [Timeweb Cloud](https://timeweb.cloud) | от 219₽/мес | ✅ Русский провайдер |
| [Reg.ru](https://www.reg.ru/vps/) | от 249₽/мес | ✅ Русский провайдер |

**Минимальные требования**: Ubuntu 22.04, 1 CPU, 1 GB RAM, 20 GB SSD

### Шаг 1 — Подключись к серверу

```bash
ssh root@IP_ТВОЕГО_СЕРВЕРА
```

### Шаг 2 — Установи зависимости

```bash
# Обновление системы
apt update && apt upgrade -y

# Python 3.12, Nginx, Git, Certbot
apt install -y python3.12 python3.12-venv python3-pip nginx git certbot python3-certbot-nginx

# Проверка
python3.12 --version  # Python 3.12.x
nginx -v              # nginx/x.x.x
```

### Шаг 3 — Создай структуру папок

```bash
mkdir -p /var/www/messenger
cd /var/www/messenger
```

### Шаг 4 — Склонируй проект с GitHub

```bash
git clone https://github.com/ТВО_ИМЯ/messenger.git .
```

### Шаг 5 — Настрой Python окружение

```bash
cd /var/www/messenger

# Создаём виртуальное окружение
python3.12 -m venv venv

# Активируем и устанавливаем зависимости
source venv/bin/activate
pip install -r backend/requirements.txt
```

### Шаг 6 — Создай файл .env

```bash
nano /var/www/messenger/backend/.env
```

Вставь и заполни:

```env
PORT=8000
FRONTEND_URL=https://ТВО_ДОМЕН.com

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=твоя_почта@gmail.com
SMTP_PASS=пароль_приложения_gmail
SMTP_FROM=Messenger <твоя_почта@gmail.com>

JWT_SECRET=замени_на_случайную_строку_минимум_32_символа
ADMIN_EMAIL=твоя_почта@gmail.com
```

> Сохрани: `Ctrl+O` → Enter → `Ctrl+X`

### Шаг 7 — Настрой Nginx

```bash
# Копируем конфиг
cp /var/www/messenger/deploy/nginx/messenger.conf /etc/nginx/sites-available/messenger.conf

# Редактируем — меняем YOUR_DOMAIN на твой домен
nano /etc/nginx/sites-available/messenger.conf
# Замени все вхождения YOUR_DOMAIN на твой домен, например example.com

# Активируем сайт
ln -s /etc/nginx/sites-available/messenger.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default  # убираем дефолтный сайт

# Проверяем конфиг
nginx -t

# Перезапускаем
systemctl reload nginx
```

### Шаг 8 — Получи SSL-сертификат (HTTPS)

```bash
# Укажи свой домен — он должен уже указывать на IP сервера!
certbot --nginx -d ТВО_ДОМЕН.com -d www.ТВО_ДОМЕН.com

# Следуй инструкциям: введи email, согласись с условиями
# Certbot сам обновит nginx конфиг для HTTPS
```

> ⚠️ Перед этим шагом домен **должен** указывать на IP сервера.
> Проверь: `nslookup ТВО_ДОМЕН.com` должен вернуть IP сервера.

### Шаг 9 — Настрой автозапуск бэкенда (systemd)

```bash
# Копируем файл службы
cp /var/www/messenger/deploy/messenger-backend.service /etc/systemd/system/

# Меняем права на папку
chown -R www-data:www-data /var/www/messenger

# Активируем и запускаем
systemctl daemon-reload
systemctl enable messenger-backend
systemctl start messenger-backend

# Проверяем статус
systemctl status messenger-backend
```

Ожидаемый вывод:
```
● messenger-backend.service - Messenger FastAPI Backend
     Loaded: loaded (/etc/systemd/system/messenger-backend.service; enabled)
     Active: active (running) since ...
```

### Шаг 10 — Проверь что всё работает

```bash
# Бэкенд отвечает?
curl http://localhost:8000/
# Ожидаем: {"status":"ok","app":"Messenger API v2"}

# Nginx работает?
curl https://ТВО_ДОМЕН.com/api/
```

Открой в браузере: `https://ТВО_ДОМЕН.com`

---

## Настройка домена

Где купить домен (дёшево):
- [namecheap.com](https://namecheap.com) — от $8/год
- [reg.ru](https://reg.ru) — от 199₽/год
- [nic.ru](https://nic.ru) — от 199₽/год

После покупки в панели DNS-провайдера добавь записи:

| Тип | Имя | Значение |
|---|---|---|
| A | @ | IP_СЕРВЕРА |
| A | www | IP_СЕРВЕРА |

Изменения DNS применяются от 15 минут до 24 часов.

---

## Обновление приложения на сервере

Когда ты сделал изменения локально и запушил на GitHub:

```bash
ssh root@IP_СЕРВЕРА

cd /var/www/messenger

# Получаем новый код
git pull origin main

# Обновляем зависимости Python (если изменился requirements.txt)
source venv/bin/activate
pip install -r backend/requirements.txt

# Перезапускаем бэкенд
systemctl restart messenger-backend

# Nginx перезагружаем только если менялся его конфиг
systemctl reload nginx
```

---

## Полезные команды на сервере

```bash
# Логи бэкенда в реальном времени
journalctl -u messenger-backend -f

# Статус всех сервисов
systemctl status messenger-backend nginx

# Перезапустить бэкенд
systemctl restart messenger-backend

# Логи Nginx
tail -f /var/log/nginx/messenger_error.log

# Проверить SSL-сертификат
certbot certificates

# Обновить SSL-сертификат вручную (обычно обновляется автоматически)
certbot renew --dry-run
```

---

## Часто задаваемые вопросы

### ❓ Почему SMTP не работает?

Для Gmail нужен **пароль приложения**, не обычный пароль:
1. [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Включи двухфакторную аутентификацию
3. Создай пароль приложения → тип "Почта"
4. Скопируй 16-значный код в `SMTP_PASS`

### ❓ Как стать администратором?

В `.env` на сервере укажи свой email:
```env
ADMIN_EMAIL=твоя_почта@gmail.com
```
После перезапуска бэкенда твой аккаунт получит права администратора.

### ❓ Где хранятся загруженные файлы?

В папке `/var/www/messenger/backend/uploads/` на сервере.
Для резервного копирования:
```bash
tar -czf backup_uploads.tar.gz /var/www/messenger/backend/uploads/
```

### ❓ Как сделать резервную копию базы данных?

```bash
# Бэкап SQLite базы
cp /var/www/messenger/backend/database.db ~/database_backup_$(date +%Y%m%d).db
```

### ❓ WebSocket не работает после деплоя

Проверь что в `nginx.conf` есть location `/ws` с заголовками `Upgrade` и `Connection`. Без них WebSocket работать не будет.

---

## Структура деплоя

```
Пользователь (браузер)
        │
        ▼
  Nginx (порт 443/HTTPS)
   │         │         │
   ▼         ▼         ▼
frontend/  /api/*    /ws
(статика)    │         │
             └────┬────┘
                  ▼
        FastAPI (порт 8000)
                  │
                  ▼
           database.db
           uploads/
```
