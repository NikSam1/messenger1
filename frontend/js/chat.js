"use strict";
const API = window.APP_API || "http://localhost:8000";
const WS_URL = window.APP_WS || "ws://localhost:8000/ws";

// ── Global Error Handling ───────────────────────────────────────────────────────
window.addEventListener("error", (event) => {
  console.error("Global error caught:", event.error || event.message);
  // Optional: send to logging service like Sentry/Logstash
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  // Optional: send to logging service
});

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
let currentChatType = "dm"; // "dm" | "group"
let currentGroup = null;
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

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark", isDark);
  const label = document.getElementById("themeStateLabel");
  if (label) label.textContent = isDark ? "вкл" : "выкл";
}

function initTheme() {
  const saved = localStorage.getItem("theme") || "light";
  applyTheme(saved);
}

function toggleTheme() {
  const next = document.body.classList.contains("dark") ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
}

async function apiFetch(path, options = {}) {
  try {
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
  } catch (err) {
    console.error(`apiFetch error for ${path}:`, err);
    throw err; // Re-throw to be caught by the caller
  }
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

function groupAvatarHTML(group, size = 40) {
  if (!group) return "";
  const circleStyle = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;`;
  if (group.avatar) {
    return `<img src="${API}/uploads/avatars/${group.avatar}" alt="${escapeHtml(group.title || "Группа")}" style="${circleStyle}"/>`;
  }
  const initials = (group.title || "Группа").slice(0, 2).toUpperCase();
  const fs = Math.max(10, Math.round(size * 0.36));
  return `<div class="avatar-initials" style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#5a7ccf,#4d8bcf);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fs}px;flex-shrink:0;user-select:none;">${escapeHtml(initials)}</div>`;
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
      case "group_message":
        handleWSGroupMessage(msg);
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
      case "group_member_joined":
        handleWSGroupMemberJoined(msg);
        break;
      case "group_member_left":
        handleWSGroupMemberLeft(msg);
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

function handleWSGroupMessage(msg) {
  const message = msg.message || msg;
  const groupId = msg.group_id || message.group_id;
  const isCurrentGroup =
    currentChatType === "group" &&
    currentGroup &&
    Number(currentGroup.id) === Number(groupId);
  if (isCurrentGroup) {
    appendMessage(message);
    scrollToBottom();
  } else {
    playNotificationSound();
  }
  updateConvPreview({ ...message, group_id: groupId });
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
      message.from_user_id === currentUser.id,
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
  if (indicator) indicator.classList.add("visible");
  clearTimeout(typingTimeouts[userId]);
  typingTimeouts[userId] = setTimeout(() => {
    if (indicator) indicator.classList.remove("visible");
  }, 2500);
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

function handleWSGroupMemberJoined(msg) {
  const groupId = msg.group_id;
  const username = msg.username || "Новый участник";
  if (currentChatType === "group" && currentGroup && Number(currentGroup.id) === Number(groupId)) {
    currentGroup.members_count = (currentGroup.members_count || 0) + 1;
    const statusEl = document.getElementById("chatPartnerStatus");
    if (statusEl) statusEl.textContent = `${currentGroup.members_count} участников`;
    showToast(`${username} присоединился к группе`, "info");
  }
  loadConversations();
}

function handleWSGroupMemberLeft(msg) {
  const groupId = msg.group_id;
  const username = msg.username || "Участник";
  if (currentChatType === "group" && currentGroup && Number(currentGroup.id) === Number(groupId)) {
    currentGroup.members_count = Math.max(0, (currentGroup.members_count || 1) - 1);
    const statusEl = document.getElementById("chatPartnerStatus");
    if (statusEl) statusEl.textContent = `${currentGroup.members_count} участников`;
    showToast(`${username} покинул группу`, "info");
  }
  loadConversations();
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
    const [dmRes, groupRes] = await Promise.all([
      apiFetch("/api/messages/conversations"),
      apiFetch("/api/groups"),
    ]);
    if (!dmRes.ok || !groupRes.ok) return;
    const dm = await dmRes.json();
    const groups = await groupRes.json();

    const dmItems = (dm || []).map((item) => ({
      type: "dm",
      user: item.user,
      last_message: item.last_message,
      unread_count: item.unread_count || 0,
    }));
    const groupItems = (groups || []).map((g) => ({
      type: "group",
      group: g,
      last_message: g.last_message,
      unread_count: 0,
    }));
    conversations = [...dmItems, ...groupItems].sort((a, b) => {
      const ta = (a.last_message && a.last_message.created_at) || a.group?.created_at || "";
      const tb = (b.last_message && b.last_message.created_at) || b.group?.created_at || "";
      return tb.localeCompare(ta);
    });
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
    const isGroup = item.type === "group";
    const user = item.user;
    const group = item.group;
    if (!isGroup && !user) return;
    if (isGroup && !group) return;

    const lastMsg = item.last_message;
    const unreadCount = item.unread_count || 0;

    const preview = (() => {
      if (!lastMsg) return "";
      if (lastMsg.is_deleted) return "Сообщение удалено";
      const isMine = lastMsg.from_user_id === currentUser.id;
      const prefix = isMine ? "Вы: " : "";
      const text = lastMsg.content || (lastMsg.media || lastMsg.media_id ? "📎 Файл" : "");
      const full = prefix + text;
      return full.length > 40 ? full.slice(0, 40) + "…" : full;
    })();

    const timeStr = lastMsg ? formatTime(lastMsg.created_at) : "";

    const div = document.createElement("div");
    div.className = "conv-item";
    if (isGroup) {
      div.dataset.groupId = group.id;
      if (currentChatType === "group" && currentGroup && currentGroup.id === group.id) {
        div.classList.add("active");
      }
    } else {
      div.dataset.userId = user.id;
      if (currentChatType === "dm" && currentChatUserId === user.id) {
        div.classList.add("active");
      }
    }

    div.innerHTML = `
      <div class="conv-avatar">${isGroup ? groupAvatarHTML(group, 48) : avatarHTML(user, 48)}</div>
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(isGroup ? group.title : user.username)}</div>
        <div class="conv-last-msg">${escapeHtml(preview)}</div>
      </div>
      <div class="conv-meta">
        <span class="conv-time">${timeStr}</span>
        ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ""}
      </div>
    `;

    div.addEventListener("click", () => {
      if (isGroup) openGroup(group);
      else openChat(user);
    });
    container.appendChild(div);
  });
}

function updateConvPreview(message) {
  if (message.group_id) {
    const groupId = message.group_id;
    const conv = conversations.find((c) => c.type === "group" && c.group && c.group.id === groupId);
    if (conv) {
      conv.last_message = message;
      conversations = [conv, ...conversations.filter((c) => !(c.type === "group" && c.group && c.group.id === groupId))];
      renderConversations(conversations);
    } else {
      loadConversations();
    }
    return;
  }

  const otherId =
    message.from_user_id === currentUser.id
      ? message.to_user_id
      : message.from_user_id;

  let conv = conversations.find(
    (c) => c.type === "dm" && c.user && c.user.id === otherId,
  );

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
  currentChatType = "dm";
  currentChatUserId = user.id;
  currentChatUser = user;
  currentGroup = null;

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
  if (indicator) indicator.classList.remove("visible");

  const inviteBtn = document.getElementById("inviteGroupBtn");
  const leaveBtn = document.getElementById("leaveGroupBtn");
  const deleteBtn = document.getElementById("deleteChatBtn");
  const viewProfileBtn = document.getElementById("viewProfileBtn");
  const membersBtn = document.getElementById("groupMembersBtn");
  if (inviteBtn) inviteBtn.style.display = "none";
  if (leaveBtn) leaveBtn.style.display = "none";
  if (deleteBtn) deleteBtn.style.display = "";
  if (viewProfileBtn) viewProfileBtn.style.display = "";
  if (membersBtn) membersBtn.style.display = "none";

  // Clear unread badge in sidebar
  const conv = conversations.find((c) => c.type === "dm" && c.user && c.user.id === user.id);
  if (conv) conv.unread_count = 0;
  const badge = document.querySelector(
    `.conv-item[data-user-id="${user.id}"] .unread-badge`,
  );
  if (badge) badge.remove();

  await loadMessages(user.id);

  if (msgInput) msgInput.focus();
}

async function openGroup(group) {
  currentChatType = "group";
  currentGroup = group;
  currentChatUserId = null;
  currentChatUser = null;

  const placeholder = document.getElementById("chatPlaceholder");
  const chatMain = document.getElementById("chatMain");
  if (placeholder) placeholder.style.display = "none";
  if (chatMain) chatMain.style.display = "flex";

  document.querySelector(".app-layout")?.classList.add("chat-open");

  const nameEl = document.getElementById("chatPartnerName");
  const statusEl = document.getElementById("chatPartnerStatus");
  const avatarEl = document.getElementById("chatAvatarEl");
  if (nameEl) nameEl.textContent = group.title;
  if (statusEl) statusEl.textContent = `${group.members_count || 0} участников`;
  if (avatarEl) {
    avatarEl.style.backgroundImage = "";
    avatarEl.textContent = (group.title || "Группа").slice(0, 2).toUpperCase();
  }

  document.querySelectorAll(".conv-item").forEach((el) => {
    el.classList.toggle(
      "active",
      Number(el.dataset.groupId) === group.id ||
        el.dataset.groupId === String(group.id),
    );
  });

  clearMediaPreview();
  cancelEdit();
  clearReply();
  const msgInput = document.getElementById("messageInput");
  if (msgInput) msgInput.value = "";

  const inviteBtn = document.getElementById("inviteGroupBtn");
  const leaveBtn = document.getElementById("leaveGroupBtn");
  const deleteBtn = document.getElementById("deleteChatBtn");
  const viewProfileBtn = document.getElementById("viewProfileBtn");
  const membersBtn = document.getElementById("groupMembersBtn");
  if (inviteBtn) inviteBtn.style.display = "";
  if (leaveBtn) leaveBtn.style.display = "";
  if (deleteBtn) deleteBtn.style.display = group.owner_id === currentUser.id ? "" : "none";
  if (viewProfileBtn) viewProfileBtn.style.display = "none";
  if (membersBtn) membersBtn.style.display = "";

  await loadGroupMessages(group.id);
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

async function loadGroupMessages(groupId, beforeId = null) {
  const url = `/api/groups/${groupId}/messages?limit=50${beforeId ? "&before_id=" + beforeId : ""}`;
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
    console.error("loadGroupMessages error:", err);
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

    if (isOwn && currentChatType === "dm") {
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
    } else if (currentChatType === "dm") {
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
    img.addEventListener("click", () => openLightbox(`${API}${media.url}`, img.alt));
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

// ── Lightbox (images over chat) ───────────────────────────────────────────────

function openLightbox(src, alt = "") {
  const overlay = document.getElementById("lightboxOverlay");
  const img = document.getElementById("lightboxImg");
  if (!overlay || !img) return;
  img.src = src;
  img.alt = alt;
  overlay.classList.add("open");
}

function closeLightbox() {
  const overlay = document.getElementById("lightboxOverlay");
  const img = document.getElementById("lightboxImg");
  if (img) img.src = "";
  if (overlay) overlay.classList.remove("open");
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
    currentChatType === "dm" && msg.from_user_id === currentUser.id
      ? "Вы"
      : currentChatType === "group"
        ? msg.from_username || "Участник"
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
  if (currentChatType === "dm" && !currentChatUserId) return;
  if (currentChatType === "group" && !currentGroup) return;

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
  if (currentChatType === "dm" && replyToMessage) body.reply_to_id = replyToMessage.id;

  // Optimistic UI: disable input while sending
  input.disabled = true;
  try {
    const endpoint =
      currentChatType === "group"
        ? `/api/groups/${currentGroup.id}/messages`
        : `/api/messages/${currentChatUserId}`;
    const res = await apiFetch(endpoint, {
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
  if (currentChatType !== "dm" || !currentChatUserId) return;
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
        previewThumb.src = ev.target.result;
        previewThumb.style.display = "block";
      };
      reader.readAsDataURL(file);
    } else {
      previewThumb.src = "";
      previewThumb.style.display = "none";
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

async function uploadBlobAsMedia(blob, filename) {
  const previewBar = document.getElementById("mediaPreviewBar");
  const previewThumb = document.getElementById("mediaPreviewThumb");
  const previewName = document.getElementById("mediaPreviewName");
  if (previewName) previewName.textContent = filename;
  if (previewBar) previewBar.style.display = "flex";
  if (previewThumb) {
    previewThumb.src = "";
    previewThumb.style.display = "none";
  }

  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
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
    console.error("uploadBlobAsMedia error:", err);
    alert("Не удалось загрузить файл");
    clearMediaPreview();
  }
}

// ── Voice messages ────────────────────────────────────────────────────────────

let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceRecording = false;

function setRecordBtnState(isRecording) {
  const btn = document.getElementById("recordBtn");
  if (!btn) return;
  btn.style.background = isRecording ? "rgba(224,85,85,0.15)" : "";
  btn.style.border = isRecording ? "1px solid rgba(224,85,85,0.35)" : "";
}

async function toggleVoiceRecording() {
  if (voiceRecording) {
    try {
      voiceRecorder?.stop();
    } catch {}
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("Запись голоса не поддерживается в этом браузере", "error");
    return;
  }

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];

    const preferredTypes = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm",
      "audio/ogg",
    ];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || "";

    voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);

    voiceRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) voiceChunks.push(e.data);
    };

    voiceRecorder.onstop = async () => {
      voiceRecording = false;
      setRecordBtnState(false);
      try {
        voiceStream?.getTracks()?.forEach((t) => t.stop());
      } catch {}
      voiceStream = null;

      const blob = new Blob(voiceChunks, { type: voiceRecorder?.mimeType || "audio/webm" });
      voiceChunks = [];
      if (!blob || blob.size < 300) return;

      const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mpeg") ? "mp3" : "webm";
      await uploadBlobAsMedia(blob, `voice-message.${ext}`);
    };

    voiceRecorder.start();
    voiceRecording = true;
    setRecordBtnState(true);
    showToast("Запись… нажмите ещё раз чтобы остановить", "info");
  } catch (err) {
    console.error("toggleVoiceRecording error:", err);
    showToast("Не удалось получить доступ к микрофону", "error");
    voiceRecording = false;
    setRecordBtnState(false);
  }
}

function clearMediaPreview() {
  pendingMediaId = null;
  const previewBar = document.getElementById("mediaPreviewBar");
  const previewThumb = document.getElementById("mediaPreviewThumb");
  const previewName = document.getElementById("mediaPreviewName");
  const fileInput = document.getElementById("fileInput");
  if (previewBar) previewBar.style.display = "none";
  if (previewThumb) {
    previewThumb.src = "";
    previewThumb.style.display = "none";
  }
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
  const shareInput = document.getElementById("shareLinkInput");

  if (usernameEl) usernameEl.value = currentUser.username || "";
  if (tagEl) tagEl.value = currentUser.tag || "";
  if (bioEl) bioEl.value = currentUser.bio || "";
  if (msgEl) {
    msgEl.textContent = "";
    msgEl.style.display = "none";
  }
  if (shareInput) shareInput.value = "";

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

  loadMyShareLink();

  const overlay = document.getElementById("profileModalOverlay");
  if (overlay) overlay.classList.add("open");
}

async function loadMyShareLink() {
  const shareInput = document.getElementById("shareLinkInput");
  if (!shareInput) return;
  try {
    const res = await apiFetch("/api/users/me/share-link");
    if (res.ok) {
      const data = await res.json();
      shareInput.value = window.location.origin + "/" + data.url;
    } else {
      shareInput.value = "";
    }
  } catch {
    shareInput.value = "";
  }
}

async function generateShareLink() {
  const shareInput = document.getElementById("shareLinkInput");
  const msgEl = document.getElementById("profileMessage");
  const btn = document.getElementById("generateShareLinkBtn");
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch("/api/users/me/share-link", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const fullUrl = window.location.origin + "/" + data.url;
      if (shareInput) shareInput.value = fullUrl;
      if (msgEl) {
        msgEl.textContent = "Ссылка создана!";
        msgEl.className = "profile-msg success";
        msgEl.style.display = "block";
        setTimeout(() => { if (msgEl) msgEl.style.display = "none"; }, 2500);
      }
    } else {
      if (msgEl) {
        msgEl.textContent = extractError(data);
        msgEl.className = "profile-msg error";
        msgEl.style.display = "block";
      }
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copyShareLink() {
  const shareInput = document.getElementById("shareLinkInput");
  if (!shareInput || !shareInput.value) return;
  try {
    await navigator.clipboard.writeText(shareInput.value);
    showToast("Ссылка скопирована!", "success");
  } catch {
    showToast("Не удалось скопировать", "error");
  }
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

async function handleInviteGroupClick() {
  if (currentChatType !== "group" || !currentGroup) return;
  try {
    const res = await apiFetch(`/api/groups/${currentGroup.id}/invite`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      const fullUrl = window.location.origin + "/" + data.url;
      try {
        await navigator.clipboard.writeText(fullUrl);
        showToast("Ссылка скопирована в буфер обмена!", "success");
      } catch {
        // Fallback for non-secure contexts / blocked clipboard
        window.prompt("Скопируйте ссылку:", fullUrl);
      }
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(extractError(data), "error");
    }
  } catch {
    showToast("Не удалось создать ссылку", "error");
  }
}

let selectedGroupMembers = []; // Array of user objects

// ── Group members modal ──────────────────────────────────────────────────────

async function openGroupMembersModal() {
  if (currentChatType !== "group" || !currentGroup) return;

  const overlay = document.getElementById("groupMembersOverlay");
  const listEl = document.getElementById("groupMembersList");
  const metaEl = document.getElementById("groupMembersMeta");
  if (!overlay || !listEl) return;

  listEl.innerHTML = `<div style="text-align:center;color:#aaa;padding:18px 0">Загрузка…</div>`;
  if (metaEl) metaEl.textContent = "";
  overlay.classList.add("open");

  try {
    const res = await apiFetch(`/api/groups/${currentGroup.id}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      listEl.innerHTML = `<div style="text-align:center;color:#e05555;padding:18px 0">${escapeHtml(extractError(data))}</div>`;
      return;
    }
    const group = await res.json();
    const members = group.members || [];
    if (metaEl) metaEl.textContent = `${members.length} участников`;

    if (members.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;color:#aaa;padding:18px 0">Нет участников</div>`;
      return;
    }

    listEl.innerHTML = "";
    members.forEach((m) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#fff;";

      const user = { username: m.username, tag: m.tag, avatar: m.avatar };
      row.innerHTML = `
        ${avatarHTML(user, 36)}
        <div style="flex:1;overflow:hidden">
          <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.username || "")}</div>
          <div style="font-size:12px;color:#888">@${escapeHtml(m.tag || "")}</div>
        </div>
        <div style="font-size:12px;color:${m.role === "owner" ? "#7c5cbf" : "#aaa"};font-weight:600">${escapeHtml(m.role || "")}</div>
      `;
      listEl.appendChild(row);
    });
  } catch (err) {
    console.error("openGroupMembersModal error:", err);
    listEl.innerHTML = `<div style="text-align:center;color:#e05555;padding:18px 0">Ошибка загрузки участников</div>`;
  }
}

function openCreateGroupModal() {
  const overlay = document.getElementById("createGroupOverlay");
  const titleEl = document.getElementById("createGroupTitle");
  const searchEl = document.getElementById("createGroupMembersSearch");
  const resultsEl = document.getElementById("createGroupSearchResults");
  const selectedEl = document.getElementById("selectedMembersList");
  const msgEl = document.getElementById("createGroupMessage");

  if (titleEl) titleEl.value = "";
  if (searchEl) searchEl.value = "";
  if (resultsEl) {
    resultsEl.innerHTML = "";
    resultsEl.style.display = "none";
  }
  selectedGroupMembers = [];
  updateSelectedMembersUI();

  if (msgEl) {
    msgEl.textContent = "";
    msgEl.style.display = "none";
  }
  if (overlay) overlay.classList.add("open");
}

let createGroupSearchTimeout = null;
function handleCreateGroupSearch(val) {
  const resultsEl = document.getElementById("createGroupSearchResults");
  if (!resultsEl) return;

  clearTimeout(createGroupSearchTimeout);
  if (!val || val.length < 1) {
    resultsEl.style.display = "none";
    return;
  }

  createGroupSearchTimeout = setTimeout(async () => {
    try {
      const res = await apiFetch(
        `/api/users/search?q=${encodeURIComponent(val)}`,
      );
      if (!res.ok) return;
      const users = await res.json();

      if (!users || users.length === 0) {
        resultsEl.innerHTML = `<div style="padding:10px;color:#aaa;font-size:12px;text-align:center">Ничего не найдено</div>`;
        resultsEl.style.display = "block";
        return;
      }

      resultsEl.innerHTML = "";
      users.forEach((user) => {
        const isAdded = selectedGroupMembers.some((u) => u.id === user.id);
        const item = document.createElement("div");
        item.className = "search-result-item";
        item.style.cssText = `display:flex;align-items:center;padding:8px 12px;cursor:pointer;transition:background 0.15s;${isAdded ? "opacity:0.5;pointer-events:none" : ""}`;
        item.innerHTML = `
          ${avatarHTML(user, 32)}
          <div style="margin-left:10px;overflow:hidden;flex:1">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user.username)}</div>
            <div style="font-size:11px;color:#888">@${escapeHtml(user.tag || user.username)}</div>
          </div>
          ${isAdded ? '<span style="font-size:12px;color:#7c5cbf">✓</span>' : ""}
        `;
        if (!isAdded) {
          item.addEventListener("mouseenter", () => (item.style.background = "#f5f0ff"));
          item.addEventListener("mouseleave", () => (item.style.background = ""));
          item.addEventListener("click", () => {
            addMemberToSelected(user);
            resultsEl.style.display = "none";
            const searchInput = document.getElementById("createGroupMembersSearch");
            if (searchInput) searchInput.value = "";
          });
        }
        resultsEl.appendChild(item);
      });
      resultsEl.style.display = "block";
    } catch (err) {
      console.error("handleCreateGroupSearch error:", err);
    }
  }, 300);
}

function addMemberToSelected(user) {
  if (!selectedGroupMembers.some((u) => u.id === user.id)) {
    selectedGroupMembers.push(user);
    updateSelectedMembersUI();
  }
}

function removeMemberFromSelected(userId) {
  selectedGroupMembers = selectedGroupMembers.filter((u) => u.id !== userId);
  updateSelectedMembersUI();
}

function updateSelectedMembersUI() {
  const container = document.getElementById("selectedMembersList");
  if (!container) return;
  container.innerHTML = "";
  selectedGroupMembers.forEach((user) => {
    const chip = document.createElement("div");
    chip.style.cssText =
      "display:flex;align-items:center;background:#f0eaff;padding:4px 8px;border-radius:16px;font-size:12px;color:#7c5cbf;border:1px solid #dcd0ff";
    chip.innerHTML = `
      <span>@${escapeHtml(user.tag || user.username)}</span>
      <button style="background:none;border:none;color:#7c5cbf;margin-left:6px;cursor:pointer;font-weight:bold;padding:0 2px" onclick="removeMemberFromSelected(${user.id})">✕</button>
    `;
    container.appendChild(chip);
  });
}

async function submitCreateGroup() {
  const titleEl = document.getElementById("createGroupTitle");
  const msgEl = document.getElementById("createGroupMessage");
  const submitBtn = document.getElementById("submitCreateGroupBtn");
  const title = titleEl ? titleEl.value.trim() : "";
  const member_tags = selectedGroupMembers.map((u) => u.tag).filter(Boolean);

  if (!title) {
    if (msgEl) {
      msgEl.textContent = "Введите название группы";
      msgEl.className = "profile-msg error";
      msgEl.style.display = "block";
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  try {
    const res = await apiFetch("/api/groups", {
      method: "POST",
      body: JSON.stringify({ title, member_tags }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(extractError(data));
    }
    const overlay = document.getElementById("createGroupOverlay");
    if (overlay) overlay.classList.remove("open");
    await loadConversations();
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = err.message || "Не удалось создать группу";
      msgEl.className = "profile-msg error";
      msgEl.style.display = "block";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteCurrentChat() {
  if (currentChatType === "dm" && currentChatUserId) {
    if (!confirm("Удалить весь диалог для вас?")) return;
    const res = await apiFetch(`/api/messages/dialogs/${currentChatUserId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert("Ошибка удаления: " + extractError(data));
      return;
    }
  } else if (currentChatType === "group" && currentGroup) {
    if (currentGroup.owner_id !== currentUser.id) {
      alert("Удалить группу может только владелец");
      return;
    }
    if (!confirm("Удалить группу целиком? Это действие необратимо.")) return;
    const res = await apiFetch(`/api/groups/${currentGroup.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert("Ошибка удаления группы: " + extractError(data));
      return;
    }
  } else {
    return;
  }

  currentChatType = "dm";
  currentChatUserId = null;
  currentChatUser = null;
  currentGroup = null;
  const chatMain = document.getElementById("chatMain");
  const placeholder = document.getElementById("chatPlaceholder");
  const area = document.getElementById("messagesArea");
  if (chatMain) chatMain.style.display = "none";
  if (placeholder) placeholder.style.display = "flex";
  if (area) area.innerHTML = "";
  await loadConversations();
}

async function leaveCurrentGroup() {
  if (currentChatType !== "group" || !currentGroup) return;
  if (!confirm("Вы уверены, что хотите покинуть группу?")) return;
  const res = await apiFetch(`/api/groups/${currentGroup.id}/leave`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert("Ошибка: " + extractError(data));
    return;
  }
  currentChatType = "dm";
  currentChatUserId = null;
  currentChatUser = null;
  currentGroup = null;
  const chatMain = document.getElementById("chatMain");
  const placeholder = document.getElementById("chatPlaceholder");
  const area = document.getElementById("messagesArea");
  if (chatMain) chatMain.style.display = "none";
  if (placeholder) placeholder.style.display = "flex";
  if (area) area.innerHTML = "";
  showToast("Вы покинули группу", "success");
  await loadConversations();
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
  const createGroupBtn = document.getElementById("createGroupBtn");
  if (createGroupBtn) createGroupBtn.addEventListener("click", openCreateGroupModal);

  const closeCreateGroupModal = document.getElementById("closeCreateGroupModal");
  if (closeCreateGroupModal)
    closeCreateGroupModal.addEventListener("click", () => {
      document.getElementById("createGroupOverlay").classList.remove("open");
    });

  const submitCreateGroupBtn = document.getElementById("submitCreateGroupBtn");
  if (submitCreateGroupBtn)
    submitCreateGroupBtn.addEventListener("click", submitCreateGroup);

  const createGroupMembersSearch = document.getElementById("createGroupMembersSearch");
  if (createGroupMembersSearch) {
    createGroupMembersSearch.addEventListener("input", (e) => {
      handleCreateGroupSearch(e.target.value.trim());
    });
  }

  const createGroupOverlay = document.getElementById("createGroupOverlay");
  if (createGroupOverlay) {
    createGroupOverlay.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.classList.remove("open");
    });
  }

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

  const generateShareLinkBtn = document.getElementById("generateShareLinkBtn");
  if (generateShareLinkBtn) generateShareLinkBtn.addEventListener("click", generateShareLink);

  const copyShareLinkBtn = document.getElementById("copyShareLinkBtn");
  if (copyShareLinkBtn) copyShareLinkBtn.addEventListener("click", copyShareLink);

  // ── View partner profile ──
  const viewProfileBtn = document.getElementById("viewProfileBtn");
  if (viewProfileBtn)
    viewProfileBtn.addEventListener("click", async () => {
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

      const isOnline = onlineUsers.has(currentChatUser.id);
      if (lastSeenEl) {
        lastSeenEl.textContent = isOnline ? "онлайн" : (currentChatUser.last_seen ? "Был(а): " + formatDate(currentChatUser.last_seen) + " " + formatTime(currentChatUser.last_seen) : "не в сети");
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
      if (currentChatUser) openChat(currentChatUser);
    });

  // ── Messaging ──
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.addEventListener("click", sendMessage);
  const deleteChatBtn = document.getElementById("deleteChatBtn");
  if (deleteChatBtn) deleteChatBtn.addEventListener("click", deleteCurrentChat);

  const leaveGroupBtn = document.getElementById("leaveGroupBtn");
  if (leaveGroupBtn) leaveGroupBtn.addEventListener("click", leaveCurrentGroup);

  const inviteGroupBtn = document.getElementById("inviteGroupBtn");
  if (inviteGroupBtn) inviteGroupBtn.addEventListener("click", handleInviteGroupClick);

  const groupMembersBtn = document.getElementById("groupMembersBtn");
  if (groupMembersBtn) groupMembersBtn.addEventListener("click", openGroupMembersModal);

  const closeGroupMembersModal = document.getElementById("closeGroupMembersModal");
  if (closeGroupMembersModal) {
    closeGroupMembersModal.addEventListener("click", () => {
      document.getElementById("groupMembersOverlay")?.classList.remove("open");
    });
  }

  const groupMembersOverlay = document.getElementById("groupMembersOverlay");
  if (groupMembersOverlay) {
    groupMembersOverlay.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.classList.remove("open");
    });
  }

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

  const recordBtn = document.getElementById("recordBtn");
  if (recordBtn) recordBtn.addEventListener("click", toggleVoiceRecording);

  const toggleThemeBtn = document.getElementById("toggleThemeBtn");
  if (toggleThemeBtn)
    toggleThemeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTheme();
    });

  const lightboxOverlay = document.getElementById("lightboxOverlay");
  if (lightboxOverlay) {
    lightboxOverlay.addEventListener("click", (e) => {
      if (e.target === lightboxOverlay) closeLightbox();
    });
  }
  const lightboxClose = document.getElementById("lightboxClose");
  if (lightboxClose) lightboxClose.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  // ── Search ──
  let searchDebounce = null;
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(
        () => handleSearch(e.target.value.trim()),
        300,
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
      if (messagesArea.scrollTop < 80 && !loadingOlder) {
        const firstRow = messagesArea.querySelector(".message-row");
        if (firstRow && firstRow.dataset.msgId) {
          loadingOlder = true;
          if (currentChatType === "group" && currentGroup) {
            await loadGroupMessages(currentGroup.id, firstRow.dataset.msgId);
          } else if (currentChatUserId) {
            await loadMessages(currentChatUserId, firstRow.dataset.msgId);
          }
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
  initTheme();
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

  // 3. Load online users (for status indicators)
  try {
    const onlineRes = await apiFetch("/api/users/online");
    if (onlineRes.ok) {
      const data = await onlineRes.json();
      (data.online_user_ids || []).forEach((id) => onlineUsers.add(id));
    }
  } catch (err) {
    console.error("Failed to load online users:", err);
  }

  // 4. Load conversations
  await loadConversations();

  // 5. Connect WebSocket
  connectWS();

  // 6. Attach all event listeners
  attachEventListeners();

  // 7. Refresh conversations every 30 seconds
  setInterval(loadConversations, 30000);

  // 8. Heartbeat: send ping through WS every 25s to keep connection alive
  //    and update last_seen on server
  setInterval(() => {
    wsSend({ type: "ping" });
  }, 25000);

  // 9. Handle deep links on load
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("invite");
  const groupInviteCode = params.get("group_invite");
  const pathMatch = window.location.pathname.match(/\/invite\/([^/]+)$/);
  const groupInviteFromPath = pathMatch ? decodeURIComponent(pathMatch[1]) : null;

  if (groupInviteFromPath || groupInviteCode) {
    window.history.replaceState({}, "", window.location.pathname);
    await joinGroupByInviteCode(groupInviteFromPath || groupInviteCode);
  } else if (inviteToken) {
    window.history.replaceState({}, "", window.location.pathname);
    await openChatByInviteToken(inviteToken);
  }
});

async function openChatByInviteToken(token) {
  try {
    const res = await fetch(`${API}/api/users/link/${encodeURIComponent(token)}`);
    if (!res.ok) {
      showToast("Ссылка недействительна", "error");
      return;
    }
    const user = await res.json();
    openChat(user);
  } catch {
    showToast("Не удалось открыть профиль по ссылке", "error");
  }
}

async function joinGroupByInviteCode(code) {
  try {
    const res = await apiFetch(`/api/groups/invite/${encodeURIComponent(code)}`, {
      method: "POST",
    });
    if (res.ok) {
      const data = await res.json();
      showToast("Вы присоединились к группе: " + data.title, "success");
      await loadConversations();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(extractError(data), "error");
    }
  } catch {
    showToast("Не удалось присоединиться к группе", "error");
  }
}

function showToast(message, type = "info") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.style.cssText = `pointer-events:auto;padding:10px 16px;border-radius:8px;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,0.15);transition:opacity 0.3s;background:${type === "error" ? "#e05555" : type === "success" ? "#4caf50" : "#7c5cbf"};color:#fff;`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
