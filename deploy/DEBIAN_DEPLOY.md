# 🖥️ Пошаговый деплой Messenger на Debian — каждое действие

**Сервер:** 193.124.113.196  
**ОС:** Debian 12/13  
**RAM:** 0.5 GB (добавим своп)  
**Доступ:** root

---

## Шаг 1 — Подключись к серверу с компьютера

**Windows** — открой PowerShell (Win+X → Терминал) и введи:
```
ssh root@193.124.113.196
```
Введи пароль из панели хостинга. Если спросит "Are you sure you want to continue?" — напечатай `yes` и Enter.

Ты на сервере, когда видишь строку вида:
```
root@debian:~#
```

---

## Шаг 2 — Обновление системы

Выполняй команды одну за другой, жди завершения каждой:

```bash
apt update
```
```bash
apt upgrade -y
```

Если появится синий экран с вопросом про конфиги — нажми Enter (оставить текущий).

---

## Шаг 3 — Добавь своп (ОБЯЗАТЕЛЬНО при 0.5 GB RAM)

Без свопа сервер может упасть от нехватки памяти:

```bash
fallocate -l 1G /swapfile
```
```bash
chmod 600 /swapfile
```
```bash
mkswap /swapfile
```
```bash
swapon /swapfile
```
```bash
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Проверь что своп активен:
```bash
free -h
```
В строке `Swap:` должно быть `1.0G`.

---

## Шаг 4 — Установка нужных программ

```bash
apt install -y python3 python3-pip python3-venv nginx git curl nano
```

Проверь версии:
```bash
python3 --version
```
Должно быть Python 3.11+ или 3.12+.

```bash
nginx -v
```
Должно быть nginx/1.22+.

---

## Шаг 5 — Загрузка проекта на сервер

У тебя два варианта. Выбери один:

---

### Вариант А: Через GitHub (рекомендую)

Сначала на СВОЁМ компьютере (не сервере) создай репозиторий:

1. Зарегистрируйся/войди на [github.com](https://github.com)
2. Нажми **"+"** → **"New repository"** → назови `messenger` → **Create repository**
3. На своём компьютере открой папку `mes` в терминале:
   ```
   git init
   git add .
   git commit -m "first commit"
   git branch -M main
   git remote add origin https://github.com/ТВО_ЛОГИН/messenger.git
   git push -u origin main
   ```

Теперь на СЕРВЕРЕ:
```bash
mkdir -p /var/www/messenger
```
```bash
cd /var/www/messenger
```
```bash
git clone https://github.com/ТВО_ЛОГИН/messenger.git .
```

---

### Вариант Б: Через WinSCP (если нет GitHub)

1. Скачай и установи **WinSCP** с [winscp.net](https://winscp.net/eng/download.php)
2. Открой WinSCP, создай новое соединение:
   - **Protocol:** SFTP
   - **Host name:** `193.124.113.196`
   - **User name:** `root`
   - **Password:** твой пароль
   - Нажми **Login**
3. Сначала создай папку на сервере — в правой панели перейди в `/var/www/` и создай папку `messenger`
4. В левой панели (твой компьютер) перейди в папку `mes`
5. Выдели ВСЕ файлы и папки, перетащи в правую панель (`/var/www/messenger/`)
6. Дождись окончания копирования

На сервере проверь что файлы скопировались:
```bash
ls /var/www/messenger/
```
Должны быть папки `backend`, `frontend`, `deploy`.

---

## Шаг 6 — Настройка Python окружения

```bash
cd /var/www/messenger
```
```bash
python3 -m venv venv
```
```bash
source venv/bin/activate
```

Заметь: строка изменится на `(venv) root@debian:...` — значит окружение активно.

```bash
pip install --upgrade pip
```
```bash
pip install -r backend/requirements.txt
```

Установка займёт 1-2 минуты. В конце должно быть `Successfully installed ...`.

Выходим из окружения:
```bash
deactivate
```

---

## Шаг 7 — Создание файла .env

```bash
nano /var/www/messenger/backend/.env
```

В открывшемся редакторе напечатай (замени значения на свои):

```
PORT=8000
FRONTEND_URL=http://193.124.113.196

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=твоя_почта@gmail.com
SMTP_PASS=пароль_приложения_gmail
SMTP_FROM=Messenger <твоя_почта@gmail.com>

JWT_SECRET=сюда_вставь_случайную_строку_минимум_32_символа
ADMIN_EMAIL=твоя_почта@gmail.com
```

Сохрани файл: нажми `Ctrl+O` → Enter → `Ctrl+X`

### Сгенерируй случайный JWT_SECRET:

Открой второй терминал (или выполни прямо сейчас перед редактированием):
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```
Скопируй результат и вставь вместо `сюда_вставь_случайную_строку_минимум_32_символа`.

Чтобы проверить файл:
```bash
cat /var/www/messenger/backend/.env
```

---

## Шаг 8 — Создай папки для загрузок

```bash
mkdir -p /var/www/messenger/backend/uploads/avatars
```

---

## Шаг 9 — Настрой автозапуск бэкенда (systemd)

Создай файл службы:
```bash
nano /etc/systemd/system/messenger.service
```

Вставь следующее содержимое ТОЧНО как написано:

```
[Unit]
Description=Messenger FastAPI Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/messenger/backend
Environment="PATH=/var/www/messenger/venv/bin"
EnvironmentFile=/var/www/messenger/backend/.env
ExecStart=/var/www/messenger/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Сохрани: `Ctrl+O` → Enter → `Ctrl+X`

Активируй и запусти службу:
```bash
systemctl daemon-reload
```
```bash
systemctl enable messenger
```
```bash
systemctl start messenger
```

Проверь что запустился:
```bash
systemctl status messenger
```

Должно быть `Active: active (running)`. Если видишь ошибки — см. раздел "Устранение проблем" в конце.

Проверь что бэкенд отвечает:
```bash
curl http://127.0.0.1:8000/
```
Ответ должен быть: `{"status":"ok","app":"Messenger API v2"}`

---

## Шаг 10 — Настройка Nginx

Создай конфигурацию сайта:
```bash
nano /etc/nginx/sites-available/messenger
```

Вставь:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name 193.124.113.196 _;

    client_max_body_size 55M;

    access_log /var/log/nginx/messenger_access.log;
    error_log  /var/log/nginx/messenger_error.log warn;

    # Статические файлы фронтенда
    root /var/www/messenger/frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Кэш статики
    location ~* \.(css|js|woff2?|ttf|svg|png|jpg|jpeg|gif|ico|webp)$ {
        expires 7d;
        add_header Cache-Control "public";
        access_log off;
    }

    # API
    location /api/ {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout    60s;
    }

    # WebSocket
    location /ws {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 7d;
        proxy_send_timeout 7d;
    }

    # Загруженные файлы (аватары, медиа)
    location /uploads/ {
        proxy_pass       http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        expires 7d;
        access_log off;
    }
}
```

Сохрани: `Ctrl+O` → Enter → `Ctrl+X`

Активируй сайт:
```bash
ln -s /etc/nginx/sites-available/messenger /etc/nginx/sites-enabled/
```

Удали дефолтный сайт (иначе будет конфликт):
```bash
rm -f /etc/nginx/sites-enabled/default
```

Проверь что конфиг без ошибок:
```bash
nginx -t
```

Должно быть:
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

Если OK — перезапусти Nginx:
```bash
systemctl restart nginx
```

Проверь статус:
```bash
systemctl status nginx
```
Должно быть `Active: active (running)`.

---

## Шаг 11 — Настройка прав доступа

```bash
chmod -R 755 /var/www/messenger/frontend
```
```bash
chmod -R 755 /var/www/messenger/backend/uploads
```
```bash
chmod 600 /var/www/messenger/backend/.env
```

---

## Шаг 12 — Открой порты в файрволле

Проверь есть ли ufw:
```bash
ufw status
```

Если `Status: active` — открой порты:
```bash
ufw allow 80/tcp
```
```bash
ufw allow 443/tcp
```
```bash
ufw allow 22/tcp
```
```bash
ufw reload
```

Если `Status: inactive` — файрвол выключен, ничего делать не нужно.

---

## Шаг 13 — Финальная проверка

```bash
# Бэкенд работает?
curl http://127.0.0.1:8000/
# Ожидаем: {"status":"ok","app":"Messenger API v2"}

# Nginx отдаёт фронтенд?
curl -I http://193.124.113.196/
# Ожидаем: HTTP/1.1 200 OK

# API доступен через Nginx?
curl http://193.124.113.196/api/
# Ожидаем: {"status":"ok",...} или 404 (это нормально, главное не 502)
```

Открой в браузере: **http://193.124.113.196**

Должна открыться страница регистрации.

---

## Позже: добавить домен + HTTPS

Когда купишь домен (например `myapp.ru`):

### 1. Укажи домен на сервер

В панели DNS-провайдера добавь A-записи:
```
@   →  193.124.113.196
www →  193.124.113.196
```
Подожди 15-60 минут пока DNS распространится.

### 2. Установи Certbot

```bash
apt install -y certbot python3-certbot-nginx
```

### 3. Обнови Nginx конфиг

```bash
nano /etc/nginx/sites-available/messenger
```

Измени строку `server_name`:
```nginx
server_name myapp.ru www.myapp.ru;
```

```bash
nginx -t && systemctl reload nginx
```

### 4. Получи SSL-сертификат

```bash
certbot --nginx -d myapp.ru -d www.myapp.ru
```

Введи email, напечатай `Y` дважды. Certbot сам обновит конфиг Nginx для HTTPS.

### 5. Обнови .env

```bash
nano /var/www/messenger/backend/.env
```

Измени:
```
FRONTEND_URL=https://myapp.ru
```

```bash
systemctl restart messenger
```

---

## Обновление сайта в будущем

Когда внесёшь изменения на компьютере и запушишь на GitHub:

```bash
ssh root@193.124.113.196
cd /var/www/messenger
git pull origin main
systemctl restart messenger
```

Если менялся `requirements.txt`:
```bash
source venv/bin/activate
pip install -r backend/requirements.txt
deactivate
systemctl restart messenger
```

---

## Устранение проблем

### ❌ `systemctl status messenger` показывает ошибку

Смотри логи подробнее:
```bash
journalctl -u messenger -n 50 --no-pager
```

Частые причины:
- Ошибка в `.env` (лишние пробелы, кавычки)
- Не установились зависимости Python
- Занят порт 8000: `lsof -i :8000`

### ❌ Браузер показывает 502 Bad Gateway

Бэкенд не отвечает. Проверь:
```bash
systemctl status messenger
curl http://127.0.0.1:8000/
```

### ❌ Сайт открывается, но регистрация не работает

Открой DevTools в браузере (F12) → вкладка **Console** — посмотри ошибки.

Скорее всего проблема с CORS. Проверь `FRONTEND_URL` в `.env`:
```bash
cat /var/www/messenger/backend/.env | grep FRONTEND_URL
```
Должно быть `http://193.124.113.196` (или твой домен).

### ❌ Нет места на диске

```bash
df -h
```
Если диск заполнен — почисти:
```bash
apt clean
journalctl --vacuum-size=100M
```

### ❌ Сервер падает (out of memory)

```bash
free -h
```
Если своп не активен:
```bash
swapon /swapfile
```

---

## Полезные команды

```bash
# Логи бэкенда в реальном времени
journalctl -u messenger -f

# Перезапустить бэкенд
systemctl restart messenger

# Перезапустить Nginx
systemctl restart nginx

# Статус всего
systemctl status messenger nginx

# Сколько памяти используется
free -h

# Сколько места на диске
df -h

# Текущие подключения
ss -tlnp

# Лог ошибок Nginx
tail -f /var/log/nginx/messenger_error.log
```
