/**
 * config.js
 * Автоматически определяет URL бэкенда в зависимости от окружения.
 *
 * - На localhost:    API = http://localhost:8000
 * - На продакшне:   API = текущий домен (Nginx проксирует /api/ и /ws на бэкенд)
 */

(function () {
  const isLocal =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  const protocol = window.location.protocol; // "http:" или "https:"
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host; // "example.com" или "localhost:5500"

  if (isLocal) {
    window.APP_API   = "http://localhost:8000";
    window.APP_WS    = "ws://localhost:8000/ws";
  } else {
    // На сервере фронтенд и бэкенд живут на одном домене.
    // Nginx проксирует /api/* и /ws на FastAPI.
    window.APP_API   = `${protocol}//${host}`;
    window.APP_WS    = `${wsProtocol}//${host}/ws`;
  }
})();
