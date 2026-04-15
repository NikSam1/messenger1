"use strict";
const API = window.APP_API || "http://localhost:8000";

// ── State ─────────────────────────────────────────────────────────────────────
let allUsers = [];
let filteredUsers = [];
let currentPage = 1;
let totalPages = 1;
let totalUsers = 0;
const PAGE_SIZE = 50;

let pendingDeleteId = null;
let pendingDeleteUsername = "";
let editingUserId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeaders() {
  return { Authorization: "Bearer " + localStorage.getItem("token") };
}

function authJsonHeaders() {
  return {
    Authorization: "Bearer " + localStorage.getItem("token"),
    "Content-Type": "application/json",
  };
}

function formatDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function getInitials(username) {
  if (!username) return "?";
  const parts = username.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return username.slice(0, 2).toUpperCase();
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/admin/stats`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    const data = await res.json();

    setText("stat-users-total", data.users_total ?? data.total_users ?? "—");
    setText(
      "stat-users-verified",
      data.users_verified ?? data.verified_users ?? "—",
    );
    setText("stat-users-online", data.users_online ?? data.online_users ?? "—");
    setText("stat-users-banned", data.users_banned ?? data.banned_users ?? "—");
    setText(
      "stat-messages-total",
      data.messages_total ?? data.total_messages ?? "—",
    );
    setText("stat-media-total", data.media_total ?? data.total_media ?? "—");

    // Media size — accept bytes and convert to MB, or pre-formatted value
    const rawSize =
      data.media_size_mb ??
      data.media_size ??
      data.total_media_size ??
      null;
    if (rawSize !== null && rawSize !== undefined) {
      const mb =
        typeof rawSize === "number" && rawSize > 1024
          ? (rawSize / (1024 * 1024)).toFixed(1)
          : rawSize;
      setText("stat-media-size", mb);
    } else {
      setText("stat-media-size", "—");
    }
  } catch (err) {
    console.error("loadStats error:", err);
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ── Users table ───────────────────────────────────────────────────────────────

async function loadUsers(page = 1) {
  currentPage = page;
  try {
    const res = await fetch(
      `${API}/api/admin/users?page=${page}&limit=${PAGE_SIZE}`,
      { headers: authHeaders() },
    );
    if (!res.ok) return;
    const data = await res.json();

    allUsers = data.users || data || [];
    totalUsers = data.total ?? allUsers.length;
    totalPages = data.pages ?? Math.ceil(totalUsers / PAGE_SIZE);
    currentPage = data.page ?? page;
    filteredUsers = [...allUsers];

    renderUsersTable();
  } catch (err) {
    console.error("loadUsers error:", err);
  }
}

function renderUsersTable() {
  const tbody = document.getElementById("usersTableBody");
  if (!tbody) return;

  if (!filteredUsers || filteredUsers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#aaa;padding:32px">Пользователи не найдены</td></tr>`;
    renderPagination();
    return;
  }

  const meStr = localStorage.getItem("adminMeId") || "";

  tbody.innerHTML = filteredUsers
    .map((user) => {
      const isSelf = String(user.id) === meStr;
      const initials = getInitials(user.username);
      const bioShort = truncate(user.bio || "", 30);
      const regDate = formatDateShort(user.created_at);

      // Status badges
      const verifiedBadge = user.is_verified
        ? `<span class="badge verified">✓ Подтверждён</span>`
        : `<span class="badge unverified">Не подтверждён</span>`;
      const bannedBadge = user.is_banned
        ? `<span class="badge banned">🚫 Заблокирован</span>`
        : "";
      const adminBadge = user.is_admin
        ? `<span class="badge admin">👑 Админ</span>`
        : "—";

      // Action buttons
      const banBtn = user.is_banned
        ? `<button class="admin-btn-sm success" onclick="banUser(${user.id}, false)" title="Разблокировать">Разблок.</button>`
        : `<button class="admin-btn-sm warn"    onclick="banUser(${user.id}, true)"  title="Заблокировать">Заблок.</button>`;

      const adminBtn = !isSelf
        ? user.is_admin
          ? `<button class="admin-btn-sm secondary" onclick="toggleAdmin(${user.id}, false)" title="Снять права">–Админ</button>`
          : `<button class="admin-btn-sm"            onclick="toggleAdmin(${user.id}, true)"  title="Назначить админом">+Админ</button>`
        : "";

      const editBtn = `<button class="admin-btn-sm" onclick="openEditUser(${user.id})" title="Редактировать">✏️</button>`;

      const deleteBtn = !isSelf
        ? `<button class="admin-btn-sm danger" onclick="promptDeleteUser(${user.id}, '${escapeHtml(user.username)}')" title="Удалить">🗑️</button>`
        : "";

      return `
      <tr>
        <td style="color:#888;font-size:12px">#${user.id}</td>
        <td class="user-cell">
          <div class="user-cell-avatar" style="
            width:36px;height:36px;border-radius:50%;
            background:linear-gradient(135deg,#7c5cbf,#a97de8);
            display:flex;align-items:center;justify-content:center;
            color:#fff;font-weight:700;font-size:13px;flex-shrink:0;
          ">${escapeHtml(initials)}</div>
          <div style="overflow:hidden">
            <div class="user-cell-name">${escapeHtml(user.username)}</div>
            <div style="font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(bioShort)}</div>
          </div>
        </td>
        <td style="color:#666;font-size:13px">@${escapeHtml(user.tag || user.username)}</td>
        <td style="font-size:13px">${escapeHtml(user.email || "")}</td>
        <td>${verifiedBadge}${bannedBadge}</td>
        <td>${adminBadge}</td>
        <td style="font-size:13px;color:#888">${regDate}</td>
        <td class="actions-cell">
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            ${banBtn}
            ${adminBtn}
            ${editBtn}
            ${deleteBtn}
          </div>
        </td>
      </tr>
    `;
    })
    .join("");

  renderPagination();
}

function renderPagination() {
  const container = document.getElementById("usersPagination");
  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  let html = "";

  // Prev button
  html += `<button class="page-btn ${currentPage <= 1 ? "disabled" : ""}" onclick="goPage(${currentPage - 1})" ${currentPage <= 1 ? "disabled" : ""}>‹</button>`;

  // Page numbers — show a window of pages around current
  const range = buildPageRange(currentPage, totalPages);
  range.forEach((p) => {
    if (p === "…") {
      html += `<span class="page-ellipsis">…</span>`;
    } else {
      html += `<button class="page-btn ${p === currentPage ? "active" : ""}" onclick="goPage(${p})">${p}</button>`;
    }
  });

  // Next button
  html += `<button class="page-btn ${currentPage >= totalPages ? "disabled" : ""}" onclick="goPage(${currentPage + 1})" ${currentPage >= totalPages ? "disabled" : ""}>›</button>`;

  html += `<span style="font-size:12px;color:#888;margin-left:8px">Всего: ${totalUsers}</span>`;

  container.innerHTML = html;
}

function buildPageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  pages.push(1);
  if (current > 3) pages.push("…");
  for (
    let p = Math.max(2, current - 1);
    p <= Math.min(total - 1, current + 1);
    p++
  ) {
    pages.push(p);
  }
  if (current < total - 2) pages.push("…");
  pages.push(total);
  return pages;
}

function goPage(page) {
  if (page < 1 || page > totalPages) return;
  loadUsers(page);
}

// ── Search / filter ───────────────────────────────────────────────────────────

function applySearch(query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) {
    filteredUsers = [...allUsers];
  } else {
    filteredUsers = allUsers.filter((u) => {
      return (
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.tag && u.tag.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q))
      );
    });
  }
  renderUsersTable();
}

// ── Ban / Unban ───────────────────────────────────────────────────────────────

async function banUser(userId, banned) {
  try {
    const res = await fetch(`${API}/api/admin/users/${userId}/ban`, {
      method: "PUT",
      headers: authJsonHeaders(),
      body: JSON.stringify({ banned }),
    });
    if (res.ok) {
      await loadUsers(currentPage);
    } else {
      const data = await res.json().catch(() => ({}));
      alert(
        "Ошибка: " +
          (data.detail || data.error || "не удалось изменить статус"),
      );
    }
  } catch (err) {
    console.error("banUser error:", err);
    alert("Ошибка подключения");
  }
}

// ── Toggle admin ──────────────────────────────────────────────────────────────

async function toggleAdmin(userId, isAdmin) {
  try {
    const res = await fetch(`${API}/api/admin/users/${userId}/admin`, {
      method: "PUT",
      headers: authJsonHeaders(),
      body: JSON.stringify({ is_admin: isAdmin }),
    });
    if (res.ok) {
      await loadUsers(currentPage);
    } else {
      const data = await res.json().catch(() => ({}));
      alert(
        "Ошибка: " + (data.detail || data.error || "не удалось изменить роль"),
      );
    }
  } catch (err) {
    console.error("toggleAdmin error:", err);
    alert("Ошибка подключения");
  }
}

// ── Delete user ───────────────────────────────────────────────────────────────

function promptDeleteUser(userId, username) {
  pendingDeleteId = userId;
  pendingDeleteUsername = username;

  const textEl = document.getElementById("confirmDeleteText");
  if (textEl) {
    textEl.textContent = `Удалить пользователя ${username}? Все его данные будут удалены.`;
  }

  const overlay = document.getElementById("confirmDeleteOverlay");
  if (overlay) overlay.style.display = "flex";
}

async function executeDeleteUser() {
  if (!pendingDeleteId) return;

  const overlay = document.getElementById("confirmDeleteOverlay");
  const confirmBtn = document.getElementById("confirmDeleteBtn");
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const res = await fetch(`${API}/api/admin/users/${pendingDeleteId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    if (res.ok) {
      if (overlay) overlay.style.display = "none";
      pendingDeleteId = null;
      pendingDeleteUsername = "";
      await loadUsers(currentPage);
    } else {
      const data = await res.json().catch(() => ({}));
      alert(
        "Ошибка удаления: " +
          (data.detail || data.error || "неизвестная ошибка"),
      );
    }
  } catch (err) {
    console.error("executeDeleteUser error:", err);
    alert("Ошибка подключения");
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

// ── Edit user modal ───────────────────────────────────────────────────────────

function openEditUser(userId) {
  const user = allUsers.find((u) => u.id === userId);
  if (!user) return;

  editingUserId = userId;

  const nameEl = document.getElementById("editUserName");
  const tagEl = document.getElementById("editUserTag");
  const emailEl = document.getElementById("editUserEmail");
  const roleEl = document.getElementById("editUserRole");
  const msgEl = document.getElementById("editUserMessage");

  if (nameEl) nameEl.value = user.username || "";
  if (tagEl) tagEl.value = user.tag || "";
  if (emailEl) emailEl.value = user.email || "";
  if (roleEl) roleEl.value = user.is_admin ? "admin" : "user";
  if (msgEl) {
    msgEl.textContent = "";
    msgEl.style.display = "none";
  }

  const overlay = document.getElementById("editUserOverlay");
  if (overlay) overlay.style.display = "flex";
}

async function saveEditUser() {
  if (!editingUserId) return;

  const nameEl = document.getElementById("editUserName");
  const tagEl = document.getElementById("editUserTag");
  const emailEl = document.getElementById("editUserEmail");
  const roleEl = document.getElementById("editUserRole");
  const msgEl = document.getElementById("editUserMessage");
  const saveBtn = document.getElementById("saveEditUserBtn");

  const username = nameEl ? nameEl.value.trim() : "";
  const tag = tagEl ? tagEl.value.trim() : "";
  const email = emailEl ? emailEl.value.trim() : "";
  const is_admin = roleEl ? roleEl.value === "admin" : false;

  if (!username) {
    if (msgEl) {
      msgEl.textContent = "Имя пользователя обязательно";
      msgEl.className = "";
      msgEl.style.cssText =
        "display:block;padding:8px 12px;border-radius:8px;font-size:13px;background:#fdecea;color:#c0392b;";
    }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;

  try {
    // Update profile fields
    const resProfile = await fetch(`${API}/api/admin/users/${editingUserId}`, {
      method: "PUT",
      headers: authJsonHeaders(),
      body: JSON.stringify({ username, tag, email }),
    });

    // Update admin role
    const resAdmin = await fetch(
      `${API}/api/admin/users/${editingUserId}/admin`,
      {
        method: "PUT",
        headers: authJsonHeaders(),
        body: JSON.stringify({ is_admin }),
      },
    );

    const profileOk = resProfile.ok || resProfile.status === 405; // fallback if endpoint not available
    const adminOk = resAdmin.ok;

    if (adminOk) {
      if (msgEl) {
        msgEl.textContent = "Сохранено!";
        msgEl.style.cssText =
          "display:block;padding:8px 12px;border-radius:8px;font-size:13px;background:#eafaf1;color:#27ae60;";
      }
      await loadUsers(currentPage);
      setTimeout(() => {
        const overlay = document.getElementById("editUserOverlay");
        if (overlay) overlay.style.display = "none";
      }, 900);
    } else {
      const data = await resAdmin.json().catch(() => ({}));
      if (msgEl) {
        msgEl.textContent =
          "Ошибка: " + (data.detail || data.error || "не удалось сохранить");
        msgEl.style.cssText =
          "display:block;padding:8px 12px;border-radius:8px;font-size:13px;background:#fdecea;color:#c0392b;";
      }
    }
  } catch (err) {
    console.error("saveEditUser error:", err);
    if (msgEl) {
      msgEl.textContent = "Ошибка подключения";
      msgEl.style.cssText =
        "display:block;padding:8px 12px;border-radius:8px;font-size:13px;background:#fdecea;color:#c0392b;";
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const token = localStorage.getItem("token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  // Auth + admin check
  let me;
  try {
    const res = await fetch(`${API}/api/users/me`, { headers: authHeaders() });
    if (!res.ok) {
      window.location.href = "login.html";
      return;
    }
    me = await res.json();
  } catch {
    window.location.href = "login.html";
    return;
  }

  if (!me.is_admin) {
    document.body.innerHTML = `
      <div style="
        min-height:100vh;
        display:flex;
        align-items:center;
        justify-content:center;
        background:linear-gradient(135deg,#0f0f13 0%,#1a1a2e 100%);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      ">
        <div style="
          text-align:center;
          padding:48px 40px;
          background:#1a1a24;
          border-radius:20px;
          border:1px solid rgba(255,255,255,0.08);
          box-shadow:0 24px 64px rgba(0,0,0,0.5);
          max-width:420px;
          width:90%;
        ">
          <div style="font-size:72px;margin-bottom:16px">🚫</div>
          <h1 style="color:#fff;font-size:28px;font-weight:800;margin:0 0 8px">403</h1>
          <h2 style="color:#9b7de0;font-size:18px;font-weight:600;margin:0 0 16px">Нет доступа</h2>
          <p style="color:#9090a8;font-size:15px;line-height:1.6;margin:0 0 28px">
            Эта страница доступна только администраторам.<br/>
            Ваш аккаунт не имеет прав администратора.
          </p>
          <a href="chat.html" style="
            display:inline-block;
            padding:12px 28px;
            background:linear-gradient(135deg,#7c5cbf,#5e3fa3);
            color:#fff;
            border-radius:10px;
            text-decoration:none;
            font-size:15px;
            font-weight:600;
            transition:opacity 0.2s;
          ">← Вернуться в мессенджер</a>
        </div>
      </div>
    `;
    return;
  }

  // Store own ID so the table can mark the "self" row
  localStorage.setItem("adminMeId", String(me.id));

  // Populate topbar
  const userNameEl = document.getElementById("adminUserName");
  const avatarEl = document.getElementById("adminAvatarEl");
  if (userNameEl) userNameEl.textContent = me.username;
  if (avatarEl) avatarEl.textContent = me.username.slice(0, 2).toUpperCase();

  // ── Navigation ──
  document.querySelectorAll(".nav-item[data-section]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const section = link.dataset.section;

      document
        .querySelectorAll(".admin-section")
        .forEach((s) => (s.style.display = "none"));
      const target = document.getElementById(`section-${section}`);
      if (target) target.style.display = "block";

      document
        .querySelectorAll(".nav-item")
        .forEach((n) => n.classList.remove("active"));
      link.classList.add("active");

      const titleEl = document.getElementById("adminPageTitle");
      if (titleEl)
        titleEl.textContent = link.querySelector("span:last-child")
          ? link.querySelector("span:last-child").textContent.trim()
          : link.textContent.trim();

      if (section === "users") loadUsers(1);
    });
  });

  // ── Search ──
  let searchDebounce = null;
  const searchInput = document.getElementById("adminUserSearch");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => applySearch(e.target.value), 300);
    });
  }

  // ── Confirm delete buttons ──
  const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
  if (confirmDeleteBtn) {
    confirmDeleteBtn.addEventListener("click", executeDeleteUser);
  }

  const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
  if (cancelDeleteBtn) {
    cancelDeleteBtn.addEventListener("click", () => {
      const overlay = document.getElementById("confirmDeleteOverlay");
      if (overlay) overlay.style.display = "none";
      pendingDeleteId = null;
      pendingDeleteUsername = "";
    });
  }

  // Close confirm overlay on background click
  const confirmDeleteOverlay = document.getElementById("confirmDeleteOverlay");
  if (confirmDeleteOverlay) {
    confirmDeleteOverlay.addEventListener("click", (e) => {
      if (e.target === confirmDeleteOverlay) {
        confirmDeleteOverlay.style.display = "none";
        pendingDeleteId = null;
        pendingDeleteUsername = "";
      }
    });
  }

  // ── Edit user modal ──
  const closeEditUserModal = document.getElementById("closeEditUserModal");
  if (closeEditUserModal) {
    closeEditUserModal.addEventListener("click", () => {
      const overlay = document.getElementById("editUserOverlay");
      if (overlay) overlay.style.display = "none";
      editingUserId = null;
    });
  }

  const saveEditUserBtn = document.getElementById("saveEditUserBtn");
  if (saveEditUserBtn) {
    saveEditUserBtn.addEventListener("click", saveEditUser);
  }

  const editUserOverlay = document.getElementById("editUserOverlay");
  if (editUserOverlay) {
    editUserOverlay.addEventListener("click", (e) => {
      if (e.target === editUserOverlay) {
        editUserOverlay.style.display = "none";
        editingUserId = null;
      }
    });
  }

  // ── Logout ──
  const adminLogoutBtn = document.getElementById("adminLogoutBtn");
  if (adminLogoutBtn) {
    adminLogoutBtn.addEventListener("click", () => {
      localStorage.clear();
      window.location.href = "login.html";
    });
  }

  // ── Initial data load ──
  await loadStats();
  setInterval(loadStats, 30000);
});
