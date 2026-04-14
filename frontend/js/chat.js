"use strict";
const API = window.APP_API || "http://localhost:8000";
const WS_URL = window.APP_WS || "ws://localhost:8000/ws";

// ── Auth check ────────────────────────────────────────────────────────────────
const _initToken = localStorage.getItem("token");
if (!_initToken) window.location.href = "login.html";

let currentUser = (() => {
  try {
    return JSON.parse(localStorage.getItem("user")) || {};
  } catch {
    return {};
  }
})();

// ── State ─────────────────────────────────────────────────────────────────────
let currentChatUserId = null;
let currentChatUser = null;
let conversations = [];
let pendingMediaId = null;
let ws = null;
let wsReconnectDelay = 3000;
let typingTimer = null;
let typingTimeouts = {};
let onlineUsers = new Set();
let editingMsgId = null;
let replyToMessage = null; // { id, from_user_id, username, preview } or null

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeaders() {
  return {
    Authorization: "Bearer " + localStorage.getItem("token"),
    "Content-Type": "application/json",
  };
}

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("token");
  const headers = Object.assign(
    { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    options.headers || {},
  );
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) {
    localStorage.clear();
    window.location.href = "login.html";
  }
  return res;
}

function getInitials(username) {
  if (!username) return "?";
  const parts = username.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return username.slice(0, 2).toUpperCase();
}

function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d)) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (day.getTime() === today.getTime()) return "сегодня";
  if (day.getTime() === yesterday.getTime()) return "вчера";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function avatarHTML(user, size = 40) {
  if (!user) return "";
  const circleStyle = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;`;
  if (user.avatar && user.avatar !== "") {
    return `<img src="${API}/uploads/avatars/${user.avatar}" alt="${escapeHtml(user.username)}" style="${circleStyle}"/>`;
  }
  const initials = getInitials(user.username);
  const fs = Math.max(10, Math.round(size * 0.36));
  return `<div class="avatar-initials" style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#7c5cbf,#a97de8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fs}px;flex-shrink:0;user-select:none;">${initials}</div>`;
}

function extractError(data) {
  if (!data) return "Неизвестная ошибка";
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail))
    return data.detail.map((e) => e.msg).join("; ");
  if (typeof data.error === "string") return data.error;
  if (typeof data.message === "string") return data.message;
  return "Неизвестная ошибка";
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatFileSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS() {
  const token = localStorage.getItem("token");
  if (!token) return;

  try {
    ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error("[WS] create error:", err);
    scheduleWSReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[WS] Connected");
    wsReconnectDelay = 3000;
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "new_message":
        handleWSNewMessage(msg);
        break;
      case "message_edited":
        handleWSMessageEdited(msg);
        break;
      case "message_deleted":
        handleWSMessageDeleted(msg);
        break;
      case "typing":
        handleWSTypingEvent(msg);
        break;
      case "read":
        handleWSRead(msg);
        break;
      case "user_online":
        handleWSUserOnline(msg);
        break;
      case "user_offline":
        handleWSUserOffline(msg);
        break;
      case "ping":
        wsSend({ type: "pong" });
        break;
      default:
        break;
    }
  };

  ws.onclose = (e) => {
    console.log("[WS] Closed:", e.code);
    ws = null;
    scheduleWSReconnect();
  };

  ws.onerror = (err) => {
    console.error("[WS] Error:", err);
  };
}

function scheduleWSReconnect() {
  setTimeout(() => {
    console.log("[WS] Reconnecting…");
    connectWS();
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// WS event handlers

function handleWSNewMessage(msg) {
  const message = msg.message || msg;
  const senderId = message.from_user_id;
  const recvId = message.to_user_id;

  const isCurrentChat =
    currentChatUserId !== null &&
    ((senderId === currentChatUserId && recvId === currentUser.id) ||
      (senderId === currentUser.id && recvId === currentChatUserId));

  if (isCurrentChat) {
    appendMessage(message);
    scrollToBottom();
    wsSend({ type: "read", message_id: message.id });
  } else {
    playNotificationSound();
  }

  updateConvPreview(message);
}

function handleWSMessageEdited(msg) {
  const message = msg.message || msg;
  const row = document.querySelector(
    `.message-row[data-msg-id="${message.id}"]`,
  );
  if (!row) return;
  const contentEl = row.querySelector(".bubble-content");
  if (contentEl) contentEl.textContent = message.content || "";
  const timeEl = row.querySelector(".msg-time");
  if (timeEl)
    timeEl.innerHTML = buildTimeHTML(
      message,
      message.sender_id === currentUser.id,
    );
}

function handleWSMessageDeleted(msg) {
  const msgId = msg.message_id || (msg.message && msg.message.id);
  const forAll = msg.for_all !== false; // default true for backward compat
  if (!msgId) return;
  const row = document.querySelector(`.message-row[data-msg-id="${msgId}"]`);
  if (!row) return;
  if (forAll) {
    row.dataset.deleted = "true";
    const bubble = row.querySelector(".bubble");
    if (!bubble) return;
    const contentEl = bubble.querySelector(".bubble-content");
    const actionsEl = bubble.querySelector(".msg-actions");
    const mediaEl = bubble.querySelector(".media-wrapper");
    const quoteEl = bubble.querySelector(".reply-quote");
    if (contentEl)
      contentEl.innerHTML = `<em style="opacity:0.5">Сообщение удалено</em>`;
    if (actionsEl) actionsEl.remove();
    if (mediaEl) mediaEl.remove();
    if (quoteEl) quoteEl.remove();
  } else {
    row.remove();
  }
}

function handleWSTypingEvent(msg) {
  const userId = msg.user_id || msg.from_user_id;
  if (!userId || userId !== currentChatUserId) return;
  const indicator = document.getElementById("typingIndicator");
  if (indicator) indicator.style.display = "flex";
  clearTimeout(typingTimeouts[userId]);
  typingTimeouts[userId] = setTimeout(() => {
    if (indicator) indicator.style.display = "none";
  }, 2000);
}

function handleWSRead(msg) {
  const msgId = msg.message_id;
  if (!msgId) return;
  const row = document.querySelector(`.message-row[data-msg-id="${msgId}"]`);
  if (!row) return;
  const tick = row.querySelector(".msg-tick");
  if (tick) tick.textContent = "✓✓";
}

function handleWSUserOnline(msg) {
  const userId = msg.user_id;
  if (!userId) return;
  onlineUsers.add(userId);
  updateOnlineStatusUI(userId, true);
}

function handleWSUserOffline(msg) {
  const userId = msg.user_id;
  if (!userId) return;
  onlineUsers.delete(userId);
  updateOnlineStatusUI(userId, false);
}

function updateOnlineStatusUI(userId, isOnline) {
  if (currentChatUserId !== userId) return;
  const statusEl = document.getElementById("chatPartnerStatus");
  if (statusEl) {
    statusEl.textContent = isOnline ? "в сети" : "не в сети";
    statusEl.className = isOnline
      ? "chat-partner-status online"
      : "chat-partner-status";
  }
}

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    /* audio not available */
  }
}

// ── Conversations sidebar ─────────────────────────────────────────────────────

async function loadConversations() {
  try {
    const res = await apiFetch("/api/messages/conversations");
    if (!res.ok) return;
    conversations = await res.json();
    renderConversations(conversations);
  } catch (err) {
    console.error("loadConversations error:", err);
  }
}

function renderConversations(list) {
  const container = document.getElementById("conversationsList");
  if (!container) return;

  if (!list || list.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:#aaa;padding:40px 20px;font-size:14px">Нет диалогов</div>`;
    return;
  }

  container.innerHTML = "";

  list.forEach((item) => {
    const user = item.user;
    if (!user) return;

    const lastMsg = item.last_message;
    const unreadCount = item.unread_count || 0;

    const preview = (() => {
      if (!lastMsg) return "";
      if (lastMsg.is_deleted) return "Сообщение удалено";
      const isMine = lastMsg.from_user_id === currentUser.id;
      const prefix = isMine ? "Вы: " : "";
      const text = lastMsg.content || (lastMsg.media_id ? "📎 Файл" : "");
      const full = prefix + text;
      return full.length > 40 ? full.slice(0, 40) + "…" : full;
    })();

    const timeStr = lastMsg ? formatTime(lastMsg.created_at) : "";

    const div = document.createElement("div");
    div.className = "conv-item";
    div.dataset.userId = user.id;
    if (currentChatUserId === user.id) div.classList.add("active");

    div.innerHTML = `
      <div class="conv-avatar">${avatarHTML(user, 48)}</div>
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(user.username)}</div>
        <div class="conv-last-msg">${escapeHtml(preview)}</div>
      </div>
      <div class="conv-meta">
        <span class="conv-time">${timeStr}</span>
        ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ""}
      </div>
    `;

    div.addEventListener("click", () => openChat(user));
    container.appendChild(div);
  });
}

function updateConvPreview(message) {
  const otherId =
    message.from_user_id === currentUser.id
      ? message.to_user_id
      : message.from_user_id;

  let conv = conversations.find((c) => c.user && c.user.id === otherId);

  if (conv) {
    conv.last_message = message;
    if (
      message.from_user_id !== currentUser.id &&
      otherId !== currentChatUserId
    ) {
      conv.unread_count = (conv.unread_count || 0) + 1;
    } else if (otherId === currentChatUserId) {
      conv.unread_count = 0;
    }
    conversations = [
      conv,
      ...conversations.filter((c) => c.user && c.user.id !== otherId),
    ];
  } else {
    // New conversation — fetch fresh list
    loadConversations();
    return;
  }

  renderConversations(conversations);
}

// ── Opening a chat ────────────────────────────────────────────────────────────

async function openChat(user) {
  currentChatUserId = user.id;
  currentChatUser = user;

  const placeholder = document.getElementById("chatPlaceholder");
  const chatMain = document.getElementById("chatMain");
  if (placeholder) placeholder.style.display = "none";
  if (chatMain) chatMain.style.display = "flex";

  // Mobile: show chat panel
  document.querySelector(".app-layout")?.classList.add("chat-open");

  // Update header
  const nameEl = document.getElementById("chatPartnerName");
  const statusEl = document.getElementById("chatPartnerStatus");
  const avatarEl = document.getElementById("chatAvatarEl");
  if (nameEl)
    nameEl.textContent = user.username + (user.tag ? ` (@${user.tag})` : "");
  if (statusEl) {
    statusEl.textContent = onlineUsers.has(user.id) ? "в сети" : "не в сети";
    statusEl.className = onlineUsers.has(user.id)
      ? "chat-partner-status online"
      : "chat-partner-status";
  }
  if (avatarEl) {
    avatarEl.textContent = getInitials(user.username);
    if (user.avatar) {
      avatarEl.style.backgroundImage = `url(${API}/uploads/avatars/${user.avatar})`;
      avatarEl.style.backgroundSize = "cover";
      avatarEl.style.backgroundPosition = "center";
      avatarEl.textContent = "";
    } else {
      avatarEl.style.backgroundImage = "";
      avatarEl.textContent = getInitials(user.username);
    }
  }

  updateOnlineStatusUI(user.id, onlineUsers.has(user.id));

  // Highlight active sidebar item
  document.querySelectorAll(".conv-item").forEach((el) => {
    el.classList.toggle(
      "active",
      Number(el.dataset.userId) === user.id ||
        el.dataset.userId === String(user.id),
    );
  });

  // Reset transient state
  clearMediaPreview();
  cancelEdit();
  clearReply();
  const msgInput = document.getElementById("messageInput");
  if (msgInput) msgInput.value = "";

  const indicator = document.getElementById("typingIndicator");
  if (indicator) indicator.style.display = "none";

  // Clear unread badge in sidebar
  const conv = conversations.find((c) => c.user && c.user.id === user.id);
  if (conv) conv.unread_count = 0;
  const badge = document.querySelector(
    `.conv-item[data-user-id="${user.id}"] .unread-badge`,
  );
  if (badge) badge.remove();

  await loadMessages(user.id);

  if (msgInput) msgInput.focus();
}

async function loadMessages(userId, beforeId = null) {
  const url = `/api/messages/${userId}?limit=50${beforeId ? "&before_id=" + beforeId : ""}`;
  try {
    const res = await apiFetch(url);
    if (!res.ok) return;
    const messages = await res.json();

    if (beforeId) {
      prependMessages(messages);
    } else {
      renderMessages(messages);
      scrollToBottom();
    }
  } catch (err) {
    console.error("loadMessages error:", err);
  }
}

function renderMessages(messages) {
  const area = document.getElementById("messagesArea");
  if (!area) return;
  area.innerHTML = "";

  if (!messages || messages.length === 0) {
    area.innerHTML = `<div style="text-align:center;color:#aaa;padding:60px 20px;font-size:14px">Нет сообщений. Начните диалог!</div>`;
    return;
  }

  let lastDateStr = null;

  messages.forEach((msg) => {
    const dateStr = formatDate(msg.created_at);
    if (dateStr !== lastDateStr) {
      area.appendChild(makeDateSeparator(dateStr));
      lastDateStr = dateStr;
    }
    area.appendChild(buildMessageRow(msg));
  });
}

function prependMessages(messages) {
  const area = document.getElementById("messagesArea");
  if (!area || !messages || messages.length === 0) return;

  const prevScrollHeight = area.scrollHeight;
  const fragment = document.createDocumentFragment();
  let lastDateStr = null;

  messages.forEach((msg) => {
    const dateStr = formatDate(msg.created_at);
    if (dateStr !== lastDateStr) {
      fragment.appendChild(makeDateSeparator(dateStr));
      lastDateStr = dateStr;
    }
    fragment.appendChild(buildMessageRow(msg));
  });

  area.insertBefore(fragment, area.firstChild);
  // Preserve scroll position
  area.scrollTop = area.scrollHeight - prevScrollHeight;
}

function makeDateSeparator(dateStr) {
  const sep = document.createElement("div");
  sep.className = "date-separator";
  sep.dataset.date = dateStr;
  sep.innerHTML = `<span>${dateStr}</span>`;
  return sep;
}

function buildMessageRow(msg) {
  const isOwn = msg.from_user_id === currentUser.id;
  const row = document.createElement("div");
  row.className = `message-row ${isOwn ? "own" : "other"}`;
  row.dataset.msgId = msg.id;
  if (msg.is_deleted) row.dataset.deleted = "true";

  const bubble = document.createElement("div");
  bubble.className = `bubble ${isOwn ? "own" : "other"}`;

  if (msg.is_deleted) {
    bubble.innerHTML = `<em style="opacity:0.5">Сообщение удалено</em>`;
  } else {
    // Reply quote (if this message is a reply)
    if (msg.reply_to) {
      const quoteEl = document.createElement("div");
      quoteEl.className = "reply-quote";
      quoteEl.style.cssText = `
        border-left: 3px solid ${isOwn ? "rgba(255,255,255,0.5)" : "#7c5cbf"};
        padding: 4px 8px;
        margin-bottom: 6px;
        border-radius: 4px;
        background: ${isOwn ? "rgba(255,255,255,0.1)" : "rgba(124,92,191,0.08)"};
        cursor: pointer;
        max-width: 100%;
        overflow: hidden;
      `;
      quoteEl.innerHTML = `
        <div style="font-size:11px;font-weight:700;color:${isOwn ? "rgba(255,255,255,0.9)" : "#7c5cbf"};margin-bottom:2px;">
          ${escapeHtml(msg.reply_to.username)}
        </div>
        <div style="font-size:12px;opacity:0.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${escapeHtml(msg.reply_to.preview || "")}
        </div>
      `;
      // Click to scroll to original message
      quoteEl.addEventListener("click", () => {
        const origRow = document.querySelector(
          `.message-row[data-msg-id="${msg.reply_to.id}"]`,
        );
        if (origRow) {
          origRow.scrollIntoView({ behavior: "smooth", block: "center" });
          origRow.style.transition = "background 0.3s";
          origRow.style.background = "rgba(124,92,191,0.15)";
          setTimeout(() => (origRow.style.background = ""), 1500);
        }
      });
      bubble.appendChild(quoteEl);
    }

    // Text content
    if (msg.content) {
      const contentEl = document.createElement("div");
      contentEl.className = "bubble-content";
      contentEl.textContent = msg.content;
      bubble.appendChild(contentEl);
    }

    // Media attachment
    if (msg.media) {
      bubble.appendChild(buildMediaEl(msg.media));
    }

    // Action buttons (reply for all, edit/delete for own)
    const actions = document.createElement("div");
    actions.className = "msg-actions";

    // Reply button — available for all messages
    const replyBtn = document.createElement("button");
    replyBtn.className = "msg-action-btn reply-btn";
    replyBtn.title = "Ответить";
    replyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`;
    replyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setReply(msg);
    });
    actions.appendChild(replyBtn);

    if (isOwn) {
      const editBtn = document.createElement("button");
      editBtn.className = "msg-action-btn edit-btn";
      editBtn.title = "Редактировать";
      editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startEditMessage(msg.id, msg.content);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "msg-action-btn delete-btn";
      delBtn.title = "Удалить";
      delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showDeleteModal(msg.id, true);
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
    } else {
      // Other user's message — can delete for self only
      const delBtn = document.createElement("button");
      delBtn.className = "msg-action-btn delete-btn";
      delBtn.title = "Удалить у себя";
      delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showDeleteModal(msg.id, false);
      });
      actions.appendChild(delBtn);
    }

    bubble.appendChild(actions);

    // Timestamp + read tick
    const timeEl = document.createElement("span");
    timeEl.className = "msg-time";
    timeEl.innerHTML = buildTimeHTML(msg, isOwn);
    bubble.appendChild(timeEl);
  }

  row.appendChild(bubble);
  return row;
}

function buildTimeHTML(msg, isOwn) {
  const edited = msg.edited_at
    ? `<em style="font-size:10px;opacity:0.65;margin-right:2px">изм.</em>`
    : "";
  const time = formatTime(msg.created_at);
  const tick = isOwn
    ? `<span class="msg-tick" style="margin-left:3px">${msg.is_read ? "✓✓" : "✓"}</span>`
    : "";
  return `${edited}${time}${tick}`;
}

function buildMediaEl(media) {
  const wrapper = document.createElement("div");
  wrapper.className = "media-wrapper";

  if (media.type && media.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "msg-image";
    img.src = `${API}${media.url}`;
    img.alt = media.name || "Изображение";
    img.style.cssText =
      "max-width:280px;max-height:280px;border-radius:8px;cursor:pointer;display:block;margin-top:4px;";
    img.addEventListener("click", () =>
      window.open(`${API}${media.url}`, "_blank"),
    );
    wrapper.appendChild(img);
  } else {
    const card = document.createElement("div");
    card.className = "file-card";
    card.style.cssText =
      "display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(0,0,0,0.06);border-radius:8px;margin-top:4px;cursor:pointer;max-width:280px;";
    card.innerHTML = `
      <span style="font-size:24px;flex-shrink:0;">📄</span>
      <div style="overflow:hidden">
        <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(media.name || "Файл")}</div>
        <div style="font-size:11px;color:#888;margin-top:2px">${formatFileSize(media.size)}</div>
      </div>
    `;
    card.addEventListener("click", () =>
      window.open(`${API}${media.url}`, "_blank"),
    );
    wrapper.appendChild(card);
  }

  return wrapper;
}

function appendMessage(msg) {
  const area = document.getElementById("messagesArea");
  if (!area) return;

  // Remove empty-state placeholder if present
  const placeholder = area.querySelector("div[style*='Нет сообщений']");
  if (placeholder) placeholder.remove();

  const msgDate = formatDate(msg.created_at);
  // Find last date separator to decide whether to insert a new one
  const allSeps = area.querySelectorAll(".date-separator");
  const lastSep = allSeps.length > 0 ? allSeps[allSeps.length - 1] : null;
  const lastDate = lastSep ? lastSep.dataset.date : null;

  if (lastDate !== msgDate) {
    area.appendChild(makeDateSeparator(msgDate));
  }

  area.appendChild(buildMessageRow(msg));
}

function scrollToBottom() {
  const area = document.getElementById("messagesArea");
  if (area) area.scrollTop = area.scrollHeight;
}

// ── Edit / Delete messages ────────────────────────────────────────────────────

function startEditMessage(msgId, currentContent) {
  editingMsgId = msgId;
  const input = document.getElementById("messageInput");
  if (!input) return;
  input.value = currentContent || "";
  input.focus();

  let editBar = document.getElementById("editIndicatorBar");
  if (!editBar) {
    editBar = document.createElement("div");
    editBar.id = "editIndicatorBar";
    editBar.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:#f0eaff;border-top:2px solid #7c5cbf;font-size:13px;color:#7c5cbf;flex-shrink:0;";
    const parent = input.closest(".chat-input-wrapper") || input.parentElement;
    parent.insertBefore(editBar, parent.firstChild);
  }

  editBar.innerHTML = `
    <span>✏️ Редактирование сообщения</span>
    <button id="cancelEditBtn" style="background:none;border:none;cursor:pointer;font-size:18px;color:#aaa;line-height:1;padding:0 4px;">✕</button>
  `;
  editBar.style.display = "flex";
  document
    .getElementById("cancelEditBtn")
    .addEventListener("click", cancelEdit);
}

function cancelEdit() {
  editingMsgId = null;
  const input = document.getElementById("messageInput");
  if (input) input.value = "";
  const editBar = document.getElementById("editIndicatorBar");
  if (editBar) editBar.style.display = "none";
}

// ── Reply ─────────────────────────────────────────────────────────────────────

function setReply(msg) {
  replyToMessage = msg;

  let replyBar = document.getElementById("replyIndicatorBar");
  if (!replyBar) {
    replyBar = document.createElement("div");
    replyBar.id = "replyIndicatorBar";
    replyBar.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      padding: 6px 14px; background: #f0eaff;
      border-top: 2px solid #7c5cbf; font-size: 13px; flex-shrink: 0;
    `;
    const inputArea = document.querySelector(".message-input-area");
    if (inputArea) inputArea.parentElement.insertBefore(replyBar, inputArea);
  }

  const username =
    msg.from_user_id === currentUser.id
      ? "Вы"
      : currentChatUser?.username || "...";
  const preview = msg.content
    ? msg.content.length > 60
      ? msg.content.slice(0, 60) + "…"
      : msg.content
    : "📎 Медиафайл";

  replyBar.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c5cbf" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
    <div style="flex:1;overflow:hidden;">
      <div style="font-weight:700;color:#7c5cbf;font-size:12px;">${escapeHtml(username)}</div>
      <div style="color:#555;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</div>
    </div>
    <button id="cancelReplyBtn" style="background:none;border:none;cursor:pointer;font-size:18px;color:#aaa;padding:0 4px;">✕</button>
  `;
  replyBar.style.display = "flex";

  document
    .getElementById("cancelReplyBtn")
    .addEventListener("click", clearReply);
  document.getElementById("messageInput").focus();
}

function clearReply() {
  replyToMessage = null;
  const bar = document.getElementById("replyIndicatorBar");
  if (bar) bar.style.display = "none";
}

// ── Delete modal ─────────────────────────────────────────────────────────────

let _deleteMsgId = null;
let _deleteCanForAll = false;

function showDeleteModal(msgId, canForAll) {
  _deleteMsgId = msgId;
  _deleteCanForAll = canForAll;

  // Remove old modal if exists
  const old = document.getElementById("deleteModal");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "deleteModal";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end; justify-content: center;
    z-index: 2000; padding-bottom: env(safe-area-inset-bottom);
  `;

  const sheet = document.createElement("div");
  sheet.style.cssText = `
    background: #fff; border-radius: 16px 16px 0 0; padding: 16px 0 8px;
    width: 100%; max-width: 500px;
    box-shadow: 0 -8px 32px rgba(0,0,0,0.15);
  `;

  const title = document.createElement("div");
  title.textContent = "Удалить сообщение?";
  title.style.cssText =
    "font-weight:700;font-size:15px;color:#1a1a2e;padding:4px 20px 12px;border-bottom:1px solid #f0f0f0;";
  sheet.appendChild(title);

  const makeBtn = (text, color, handler) => {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText = `
      display: block; width: 100%; padding: 14px 20px;
      text-align: left; border: none; background: transparent;
      font-size: 15px; color: ${color}; cursor: pointer;
      transition: background 0.15s;
    `;
    btn.addEventListener(
      "mouseenter",
      () => (btn.style.background = "#f8f8ff"),
    );
    btn.addEventListener(
      "mouseleave",
      () => (btn.style.background = "transparent"),
    );
    btn.addEventListener("click", () => {
      overlay.remove();
      handler();
    });
    return btn;
  };

  sheet.appendChild(
    makeBtn("Удалить у себя", "#1a1a2e", () => executeDelete(false)),
  );

  if (canForAll) {
    sheet.appendChild(
      makeBtn("Удалить у всех", "#e05555", () => executeDelete(true)),
    );
  }

  sheet.appendChild(makeBtn("Отмена", "#888", () => {}));

  overlay.appendChild(sheet);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

async function executeDelete(forAll) {
  const msgId = _deleteMsgId;
  if (!msgId) return;
  try {
    const res = await apiFetch(`/api/messages/${msgId}?for_all=${forAll}`, {
      method: "DELETE",
    });
    if (res.ok) {
      const row = document.querySelector(
        `.message-row[data-msg-id="${msgId}"]`,
      );
      if (row) {
        if (forAll) {
          // Show "deleted" placeholder
          row.dataset.deleted = "true";
          const bubble = row.querySelector(".bubble");
          if (bubble) {
            const contentEl = bubble.querySelector(".bubble-content");
            const actionsEl = bubble.querySelector(".msg-actions");
            const mediaEl = bubble.querySelector(".media-wrapper");
            const quoteEl = bubble.querySelector(".reply-quote");
            const timeEl = bubble.querySelector(".msg-time");
            if (contentEl)
              contentEl.innerHTML = `<em style="opacity:0.5">Сообщение удалено</em>`;
            if (actionsEl) actionsEl.remove();
            if (mediaEl) mediaEl.remove();
            if (quoteEl) quoteEl.remove();
            if (timeEl) timeEl.remove();
          }
        } else {
          // Delete for self — remove from DOM
          row.remove();
        }
      }
    }
  } catch (err) {
    console.error("executeDelete error:", err);
  }
}

// ── Sending messages ──────────────────────────────────────────────────────────

async function sendMessage() {
  if (!currentChatUserId) return;

  const input = document.getElementById("messageInput");
  if (!input) return;
  const text = input.value.trim();

  if (!text && !pendingMediaId) return;

  // Editing an existing message
  if (editingMsgId) {
    try {
      const res = await apiFetch(`/api/messages/${editingMsgId}`, {
        method: "PUT",
        body: JSON.stringify({ content: text }),
      });
      if (res.ok) {
        const updated = await res.json();
        const row = document.querySelector(
          `.message-row[data-msg-id="${editingMsgId}"]`,
        );
        if (row) {
          const contentEl = row.querySelector(".bubble-content");
          if (contentEl) contentEl.textContent = updated.content || "";
          const timeEl = row.querySelector(".msg-time");
          if (timeEl) timeEl.innerHTML = buildTimeHTML(updated, true);
        }
        cancelEdit();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(extractError(data));
      }
    } catch (err) {
      console.error("editMessage error:", err);
    }
    return;
  }

  // New message
  const body = {};
  if (text) body.content = text;
  if (pendingMediaId) body.media_id = pendingMediaId;
  if (replyToMessage) body.reply_to_id = replyToMessage.id;

  // Optimistic UI: disable input while sending
  input.disabled = true;
  try {
    const res = await apiFetch(`/api/messages/${currentChatUserId}`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const msg = await res.json();
      input.value = "";
      clearMediaPreview();
      clearReply();
      appendMessage(msg);
      scrollToBottom();
      updateConvPreview(msg);
    } else {
      const data = await res.json().catch(() => ({}));
      alert(extractError(data));
    }
  } catch (err) {
    console.error("sendMessage error:", err);
    alert("Ошибка отправки сообщения");
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function handleTyping() {
  if (!currentChatUserId) return;
  if (typingTimer) return;
  wsSend({ type: "typing", to_user_id: currentChatUserId });
  typingTimer = setTimeout(() => {
    typingTimer = null;
  }, 2000);
}

// ── File / media attachment ───────────────────────────────────────────────────

async function handleFileSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const previewBar = document.getElementById("mediaPreviewBar");
  const previewThumb = document.getElementById("mediaPreviewThumb");
  const previewName = document.getElementById("mediaPreviewName");

  if (previewName) previewName.textContent = file.name;
  if (previewBar) previewBar.style.display = "flex";

  if (previewThumb) {
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        previewThumb.innerHTML = `<img src="${ev.target.result}" style="height:48px;max-width:80px;border-radius:6px;object-fit:cover;" alt="preview"/>`;
      };
      reader.readAsDataURL(file);
    } else {
      previewThumb.innerHTML = `<span style="font-size:30px;">📄</span>`;
    }
  }

  // Upload to server
  const formData = new FormData();
  formData.append("file", file);

  try {
    const token = localStorage.getItem("token");
    const res = await fetch(`${API}/api/media/upload`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: formData,
    });

    if (res.ok) {
      const data = await res.json();
      pendingMediaId = data.id;
    } else {
      const data = await res.json().catch(() => ({}));
      alert("Ошибка загрузки файла: " + extractError(data));
      clearMediaPreview();
    }
  } catch (err) {
    console.error("uploadMedia error:", err);
    alert("Не удалось загрузить файл");
    clearMediaPreview();
  }
}

function clearMediaPreview() {
  pendingMediaId = null;
  const previewBar = document.getElementById("mediaPreviewBar");
  const previewThumb = document.getElementById("mediaPreviewThumb");
  const previewName = document.getElementById("mediaPreviewName");
  const fileInput = document.getElementById("fileInput");
  if (previewBar) previewBar.style.display = "none";
  if (previewThumb) previewThumb.innerHTML = "";
  if (previewName) previewName.textContent = "";
  if (fileInput) fileInput.value = "";
}

// ── Own profile modal ─────────────────────────────────────────────────────────

function openProfileModal() {
  const usernameEl = document.getElementById("profileUsername");
  const tagEl = document.getElementById("profileTag");
  const bioEl = document.getElementById("profileBio");
  const avatarEl = document.getElementById("profileAvatarLarge");
  const msgEl = document.getElementById("profileMessage");

  if (usernameEl) usernameEl.value = currentUser.username || "";
  if (tagEl) tagEl.value = currentUser.tag || "";
  if (bioEl) bioEl.value = currentUser.bio || "";
  if (msgEl) {
    msgEl.textContent = "";
    msgEl.style.display = "none";
  }

  if (avatarEl) {
    if (currentUser.avatar) {
      avatarEl.style.backgroundImage = `url(${API}/uploads/avatars/${currentUser.avatar})`;
      avatarEl.style.backgroundSize = "cover";
      avatarEl.style.backgroundPosition = "center";
      avatarEl.textContent = "";
    } else {
      avatarEl.style.backgroundImage = "";
      avatarEl.textContent = getInitials(currentUser.username);
    }
  }

  const overlay = document.getElementById("profileModalOverlay");
  if (overlay) overlay.classList.add("open");
}

async function saveProfile() {
  const usernameEl = document.getElementById("profileUsername");
  const tagEl = document.getElementById("profileTag");
  const bioEl = document.getElementById("profileBio");
  const msgEl = document.getElementById("profileMessage");
  const saveBtn = document.getElementById("saveProfileBtn");

  const username = usernameEl ? usernameEl.value.trim() : "";
  const tag = tagEl ? tagEl.value.trim() : "";
  const bio = bioEl ? bioEl.value.trim() : "";

  if (!username) {
    if (msgEl) {
      msgEl.textContent = "Имя не может быть пустым";
      msgEl.className = "profile-msg error";
      msgEl.style.display = "block";
    }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;

  try {
    const res = await apiFetch("/api/users/me", {
      method: "PUT",
      body: JSON.stringify({ username, tag, bio }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      currentUser = { ...currentUser, ...data };
      localStorage.setItem("user", JSON.stringify(currentUser));
      updateSidebarHeader();
      if (msgEl) {
        msgEl.textContent = "Сохранено!";
        msgEl.className = "profile-msg success";
        msgEl.style.display = "block";
      }
      setTimeout(() => {
        if (msgEl) msgEl.style.display = "none";
      }, 2500);
    } else {
      if (msgEl) {
        msgEl.textContent = extractError(data);
        msgEl.className = "profile-msg error";
        msgEl.style.display = "block";
      }
    }
  } catch (err) {
    console.error("saveProfile error:", err);
    if (msgEl) {
      msgEl.textContent = "Ошибка сохранения";
      msgEl.className = "profile-msg error";
      msgEl.style.display = "block";
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function uploadAvatar(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  const token = localStorage.getItem("token");

  try {
    const res = await fetch(`${API}/api/users/me/avatar`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: formData,
    });

    if (res.ok) {
      const data = await res.json();
      currentUser.avatar = data.avatar || currentUser.avatar;
      localStorage.setItem("user", JSON.stringify(currentUser));

      const avatarEl = document.getElementById("profileAvatarLarge");
      if (avatarEl && currentUser.avatar) {
        avatarEl.style.backgroundImage = `url(${API}/uploads/avatars/${currentUser.avatar})`;
        avatarEl.style.backgroundSize = "cover";
        avatarEl.style.backgroundPosition = "center";
        avatarEl.textContent = "";
      }
      updateSidebarHeader();
    } else {
      const data = await res.json().catch(() => ({}));
      alert("Ошибка загрузки аватара: " + extractError(data));
    }
  } catch (err) {
    console.error("uploadAvatar error:", err);
    alert("Не удалось загрузить аватар");
  }

  e.target.value = "";
}

// ── Searching users ───────────────────────────────────────────────────────────

async function handleSearch(val) {
  const resultsEl = document.getElementById("searchResults");
  if (!resultsEl) return;

  if (!val || val.length < 2) {
    resultsEl.style.display = "none";
    return;
  }

  try {
    const res = await apiFetch(
      `/api/users/search?q=${encodeURIComponent(val)}`,
    );
    if (!res.ok) return;
    const users = await res.json();

    if (!users || users.length === 0) {
      resultsEl.innerHTML = `<div style="padding:14px;color:#aaa;font-size:13px;text-align:center">Ничего не найдено</div>`;
      resultsEl.style.display = "block";
      return;
    }

    resultsEl.innerHTML = "";

    users.forEach((user) => {
      const item = document.createElement("div");
      item.className = "search-result-item";
      item.dataset.userId = user.id;
      item.style.cssText =
        "display:flex;align-items:center;padding:10px 14px;cursor:pointer;transition:background 0.15s;";
      item.innerHTML = `
        ${avatarHTML(user, 36)}
        <div style="margin-left:10px;overflow:hidden">
          <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user.username)}</div>
          <div style="font-size:12px;color:#888;margin-top:1px">@${escapeHtml(user.tag || user.username)}</div>
        </div>
      `;
      item.addEventListener(
        "mouseenter",
        () => (item.style.background = "#f5f0ff"),
      );
      item.addEventListener("mouseleave", () => (item.style.background = ""));
      item.addEventListener("click", () => {
        openChat(user);
        resultsEl.style.display = "none";
        const searchInput = document.getElementById("searchInput");
        if (searchInput) searchInput.value = "";
      });
      resultsEl.appendChild(item);
    });

    resultsEl.style.display = "block";
  } catch (err) {
    console.error("handleSearch error:", err);
  }
}

// ── Sidebar header ────────────────────────────────────────────────────────────

function updateSidebarHeader() {
  const nameEl = document.getElementById("myUsernameEl");
  const avatarEl = document.getElementById("myAvatarEl");
  if (nameEl) nameEl.textContent = currentUser.username || "";
  if (!avatarEl) return;

  if (currentUser.avatar) {
    avatarEl.style.backgroundImage = `url(${API}/uploads/avatars/${currentUser.avatar})`;
    avatarEl.style.backgroundSize = "cover";
    avatarEl.style.backgroundPosition = "center";
    avatarEl.textContent = "";
  } else {
    avatarEl.style.backgroundImage = "";
    avatarEl.textContent = getInitials(currentUser.username);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

function attachEventListeners() {
  // ── Own profile ──
  const myProfileBtn = document.getElementById("myProfileBtn");
  if (myProfileBtn) myProfileBtn.addEventListener("click", openProfileModal);

  const closeProfileModal = document.getElementById("closeProfileModal");
  if (closeProfileModal)
    closeProfileModal.addEventListener("click", () => {
      document.getElementById("profileModalOverlay").classList.remove("open");
    });

  const saveProfileBtn = document.getElementById("saveProfileBtn");
  if (saveProfileBtn) saveProfileBtn.addEventListener("click", saveProfile);

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn)
    logoutBtn.addEventListener("click", () => {
      localStorage.clear();
      window.location.href = "login.html";
    });

  const changeAvatarHint = document.getElementById("changeAvatarHint");
  if (changeAvatarHint)
    changeAvatarHint.addEventListener("click", () => {
      const fi = document.getElementById("avatarFileInput");
      if (fi) fi.click();
    });

  const profileAvatarLarge = document.getElementById("profileAvatarLarge");
  if (profileAvatarLarge)
    profileAvatarLarge.addEventListener("click", () => {
      const fi = document.getElementById("avatarFileInput");
      if (fi) fi.click();
    });

  const avatarFileInput = document.getElementById("avatarFileInput");
  if (avatarFileInput) avatarFileInput.addEventListener("change", uploadAvatar);

  // ── View partner profile ──
  const viewProfileBtn = document.getElementById("viewProfileBtn");
  if (viewProfileBtn)
    viewProfileBtn.addEventListener("click", () => {
      if (!currentChatUser) return;

      const nameEl = document.getElementById("viewProfileName");
      const tagEl = document.getElementById("viewProfileTag");
      const bioEl = document.getElementById("viewProfileBio");
      const lastSeenEl = document.getElementById("viewProfileLastSeen");
      const avEl = document.getElementById("viewProfileAvatar");

      if (nameEl) nameEl.textContent = currentChatUser.username;
      if (tagEl)
        tagEl.textContent =
          "@" + (currentChatUser.tag || currentChatUser.username);
      if (bioEl) bioEl.textContent = currentChatUser.bio || "";

      if (lastSeenEl) {
        const ls = currentChatUser.last_seen;
        lastSeenEl.textContent = ls
          ? "Был(а): " + formatDate(ls) + " " + formatTime(ls)
          : "";
      }

      if (avEl) {
        if (currentChatUser.avatar) {
          avEl.style.backgroundImage = `url(${API}/uploads/avatars/${currentChatUser.avatar})`;
          avEl.style.backgroundSize = "cover";
          avEl.style.backgroundPosition = "center";
          avEl.textContent = "";
        } else {
          avEl.style.backgroundImage = "";
          avEl.textContent = getInitials(currentChatUser.username);
        }
      }

      document.getElementById("viewProfileModalOverlay").classList.add("open");
    });

  const closeViewProfileModal = document.getElementById(
    "closeViewProfileModal",
  );
  if (closeViewProfileModal)
    closeViewProfileModal.addEventListener("click", () => {
      document
        .getElementById("viewProfileModalOverlay")
        .classList.remove("open");
    });

  const startChatWithUserBtn = document.getElementById("startChatWithUserBtn");
  if (startChatWithUserBtn)
    startChatWithUserBtn.addEventListener("click", () => {
      document
        .getElementById("viewProfileModalOverlay")
        .classList.remove("open");
    });

  // ── Messaging ──
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.addEventListener("click", sendMessage);

  const messageInput = document.getElementById("messageInput");
  if (messageInput) {
    messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    messageInput.addEventListener("input", handleTyping);
  }

  // ── File attachment ──
  const attachBtn = document.getElementById("attachBtn");
  if (attachBtn)
    attachBtn.addEventListener("click", () => {
      const fi = document.getElementById("fileInput");
      if (fi) fi.click();
    });

  const fileInput = document.getElementById("fileInput");
  if (fileInput) fileInput.addEventListener("change", handleFileSelect);

  const mediaPreviewRemove = document.getElementById("mediaPreviewRemove");
  if (mediaPreviewRemove)
    mediaPreviewRemove.addEventListener("click", clearMediaPreview);

  // ── Search ──
  let searchDebounce = null;
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(
        () => handleSearch(e.target.value.trim()),
        400,
      );
    });
  }

  // Close search results when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) {
      const resultsEl = document.getElementById("searchResults");
      if (resultsEl) resultsEl.style.display = "none";
    }
  });

  // Close modals on overlay background click
  const profileModalOverlay = document.getElementById("profileModalOverlay");
  if (profileModalOverlay) {
    profileModalOverlay.addEventListener("click", (e) => {
      if (e.target === e.currentTarget)
        e.currentTarget.classList.remove("open");
    });
  }

  const viewProfileModalOverlay = document.getElementById(
    "viewProfileModalOverlay",
  );
  if (viewProfileModalOverlay) {
    viewProfileModalOverlay.addEventListener("click", (e) => {
      if (e.target === e.currentTarget)
        e.currentTarget.classList.remove("open");
    });
  }

  // Infinite scroll — load older messages on scroll to top
  const messagesArea = document.getElementById("messagesArea");
  if (messagesArea) {
    let loadingOlder = false;
    messagesArea.addEventListener("scroll", async () => {
      if (messagesArea.scrollTop < 80 && currentChatUserId && !loadingOlder) {
        const firstRow = messagesArea.querySelector(".message-row");
        if (firstRow && firstRow.dataset.msgId) {
          loadingOlder = true;
          await loadMessages(currentChatUserId, firstRow.dataset.msgId);
          loadingOlder = false;
        }
      }
    });
  }

  // ── Mobile back button ──
  const backBtn = document.getElementById("backBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      document.querySelector(".app-layout").classList.remove("chat-open");
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const token = localStorage.getItem("token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  // 1. Load own profile from server (may be fresher than localStorage)
  try {
    const meRes = await apiFetch("/api/users/me");
    if (meRes.ok) {
      currentUser = await meRes.json();
      localStorage.setItem("user", JSON.stringify(currentUser));
    }
  } catch (err) {
    console.error("Failed to load own profile:", err);
  }

  // 2. Update sidebar header with own info
  updateSidebarHeader();

  // 3. Load conversations
  await loadConversations();

  // 4. Connect WebSocket
  connectWS();

  // 5. Attach all event listeners
  attachEventListeners();

  // 6. Refresh conversations every 30 seconds
  setInterval(loadConversations, 30000);
});
