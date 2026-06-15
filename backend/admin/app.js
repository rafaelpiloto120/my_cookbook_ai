const SESSION_STORAGE_KEY = "cookneat_admin_session_v1";
const REQUEST_TIMEOUT_MS = 20_000;
const ADMIN_APP_VERSION = "20260615-debug-trace";

const state = {
  currentView: "dashboard",
  token: null,
  tokenExpiresAt: 0,
  user: null,
};

const elements = {
  loginView: document.querySelector("#loginView"),
  adminView: document.querySelector("#adminView"),
  loginForm: document.querySelector("#loginForm"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  loginError: document.querySelector("#loginError"),
  loginDebug: document.querySelector("#loginDebug"),
  sessionEmail: document.querySelector("#sessionEmail"),
  signOutButton: document.querySelector("#signOutButton"),
  refreshButton: document.querySelector("#refreshButton"),
  viewTitle: document.querySelector("#viewTitle"),
  viewSubtitle: document.querySelector("#viewSubtitle"),
  navButtons: Array.from(document.querySelectorAll(".nav-button")),
  dashboardView: document.querySelector("#dashboardView"),
  capabilitiesView: document.querySelector("#capabilitiesView"),
  usersView: document.querySelector("#usersView"),
  userDetailView: document.querySelector("#userDetailView"),
  activityView: document.querySelector("#activityView"),
  auditView: document.querySelector("#auditView"),
};

function debugLogin(message, details = null) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`;
  console.log(`[admin-ui] ${message}`, details || "");
  if (!elements.loginDebug) return;
  const existing = elements.loginDebug.textContent ? `${elements.loginDebug.textContent}\n` : "";
  elements.loginDebug.textContent = `${existing}${line}`.slice(-3000);
}

window.addEventListener("error", (event) => {
  debugLogin("window error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  debugLogin("unhandled rejection", {
    message: event.reason?.message || String(event.reason),
  });
});

debugLogin("admin app loaded", { version: ADMIN_APP_VERSION });

function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "0";
}

function formatDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Date(value).toLocaleString();
}

function text(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function jsonPreview(value) {
  return escapeHtml(JSON.stringify(value ?? {}, null, 2));
}

function setView(view) {
  state.currentView = view;
  for (const button of elements.navButtons) {
    button.classList.toggle("active", button.dataset.view === view);
  }
  const sections = [
    elements.dashboardView,
    elements.capabilitiesView,
    elements.usersView,
    elements.userDetailView,
    elements.activityView,
    elements.auditView,
  ];
  for (const section of sections) section.hidden = true;

  if (view === "dashboard") {
    elements.dashboardView.hidden = false;
    elements.viewTitle.textContent = "Dashboard";
    elements.viewSubtitle.textContent = "Operational overview";
  } else if (view === "capabilities") {
    elements.capabilitiesView.hidden = false;
    elements.viewTitle.textContent = "Capabilities";
    elements.viewSubtitle.textContent = "Usage by feature, source, status, and environment";
  } else if (view === "users") {
    elements.usersView.hidden = false;
    elements.viewTitle.textContent = "Users";
    elements.viewSubtitle.textContent = "Search and inspect accounts";
  } else if (view === "userDetail") {
    elements.userDetailView.hidden = false;
    elements.viewTitle.textContent = "User detail";
    elements.viewSubtitle.textContent = "";
  } else if (view === "activity") {
    elements.activityView.hidden = false;
    elements.viewTitle.textContent = "Activity";
    elements.viewSubtitle.textContent = "Normalized customer events";
  } else if (view === "audit") {
    elements.auditView.hidden = false;
    elements.viewTitle.textContent = "Audit logs";
    elements.viewSubtitle.textContent = "Admin mutations";
  }
}

async function getToken(forceRefresh = false) {
  if (!state.token || !state.user) throw new Error("Not signed in");
  if (!forceRefresh && state.tokenExpiresAt && Date.now() < state.tokenExpiresAt - 60_000) {
    return state.token;
  }
  if (!state.user.refreshToken) throw new Error("Session expired. Sign in again.");
  const refreshed = await refreshIdToken(state.user.refreshToken);
  setSession(refreshed);
  return state.token;
}

async function signInWithPassword(email, password) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch("/admin/auth/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Sign-in failed (${response.status})`);
  }
  return {
    email: data.email || email,
    uid: data.uid,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
  };
}

async function refreshIdToken(refreshToken) {
  clearSession();
  throw new Error("Session expired. Sign in again.");
}

function setSession(session) {
  const expiresInSeconds = Number(session.expiresIn);
  state.token = session.idToken;
  state.tokenExpiresAt = Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds * 1000 : 3600_000);
  state.user = {
    uid: session.uid,
    email: session.email,
    refreshToken: session.refreshToken,
  };
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      user: state.user,
      token: state.token,
      tokenExpiresAt: state.tokenExpiresAt,
    })
  );
}

function loadStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed?.user?.refreshToken || !parsed?.token) return false;
    state.user = parsed.user;
    state.token = parsed.token;
    state.tokenExpiresAt = Number(parsed.tokenExpiresAt) || 0;
    return true;
  } catch {
    return false;
  }
}

function clearSession() {
  state.user = null;
  state.token = null;
  state.tokenExpiresAt = 0;
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

async function api(path) {
  const token = await getToken(false);
  debugLogin("api request", { path });
  const response = await fetch(path, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    debugLogin("api failed", { path, status: response.status, error: data?.error || null });
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  debugLogin("api success", { path, status: response.status });
  return data;
}

function renderMetric(label, value) {
  return `
    <div class="metric">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(formatNumber(value))}</div>
    </div>
  `;
}

function renderActivityTable(events = []) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Type</th>
            <th>Action</th>
            <th>Source</th>
            <th>Status</th>
            <th>Env</th>
          </tr>
        </thead>
        <tbody>
          ${events.map((event) => `
            <tr>
              <td>${escapeHtml(formatDate(event.createdAt))}</td>
              <td>${escapeHtml(event.uid || "—")}</td>
              <td>${escapeHtml(text(event.type))}</td>
              <td>${escapeHtml(text(event.action))}</td>
              <td>${escapeHtml(text(event.source))}</td>
              <td>${escapeHtml(text(event.status))}</td>
              <td>${escapeHtml(text(event.env))}</td>
            </tr>
          `).join("") || `<tr><td colspan="7" class="muted">No rows</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function loadDashboard() {
  setView("dashboard");
  elements.dashboardView.innerHTML = `<div class="muted">Loading…</div>`;
  const data = await api("/admin/dashboard");
  const totals = data.totals || {};
  elements.dashboardView.innerHTML = `
    <div class="metric-grid">
      ${renderMetric("Users", totals.users)}
      ${renderMetric("Anonymous", totals.anonymousUsers)}
      ${renderMetric("Registered", totals.registeredUsers)}
      ${renderMetric("Active 7d", totals.active7d)}
      ${renderMetric("Active 30d", totals.active30d)}
      ${renderMetric("AI suggestions", totals.aiSuggestions)}
      ${renderMetric("AI recipes", totals.aiFullRecipes)}
      ${renderMetric("Premium actions", totals.premiumActions)}
      ${renderMetric("URL imports", totals.urlImports)}
      ${renderMetric("File imports", totals.fileImports)}
      ${renderMetric("Reel imports", totals.instagramImports)}
    </div>
    <div class="split-grid">
      <section class="panel">
        <h2>Recent activity</h2>
        ${renderActivityTable(data.recentActivity || [])}
      </section>
      <section class="panel">
        <h2>Recent users</h2>
        ${renderUsersTable(data.recentUsers || [], false)}
      </section>
    </div>
  `;
}

function renderBreakdownTable(title, rows = {}) {
  const entries = Object.entries(rows)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 25);
  return `
    <section class="panel">
      <h2>${escapeHtml(title)}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(([name, count]) => `
              <tr>
                <td>${escapeHtml(text(name))}</td>
                <td>${escapeHtml(formatNumber(count))}</td>
              </tr>
            `).join("") || `<tr><td colspan="2" class="muted">No rows</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function loadCapabilities() {
  setView("capabilities");
  elements.capabilitiesView.innerHTML = `<div class="muted">Loading…</div>`;
  const data = await api("/admin/capabilities?limit=2500");
  const totals = data.summaryTotals || {};
  const breakdown = data.activityBreakdown || {};
  elements.capabilitiesView.innerHTML = `
    <div class="metric-grid">
      ${renderMetric("Recipes", totals.recipeCount)}
      ${renderMetric("Meals", totals.mealCount)}
      ${renderMetric("Weight logs", totals.weightLogCount)}
      ${renderMetric("AI suggestions", totals.aiSuggestionCount)}
      ${renderMetric("AI recipes", totals.aiFullRecipeCount)}
      ${renderMetric("Premium actions", totals.premiumActionCount)}
      ${renderMetric("URL imports", totals.importUrlCount)}
      ${renderMetric("File imports", totals.importFileCount)}
      ${renderMetric("Reel imports", totals.importInstagramReelCount)}
    </div>
    <div class="split-grid">
      ${renderBreakdownTable("By action", breakdown.byAction)}
      ${renderBreakdownTable("By source", breakdown.bySource)}
    </div>
    <div class="split-grid">
      ${renderBreakdownTable("By type", breakdown.byType)}
      ${renderBreakdownTable("By status", breakdown.byStatus)}
    </div>
    <div class="split-grid">
      ${renderBreakdownTable("By environment", breakdown.byEnv)}
      ${renderBreakdownTable("Failures by action", breakdown.failuresByAction)}
    </div>
    <section class="panel">
      <h2>Recent successful activity</h2>
      ${renderActivityTable(data.recentSuccessfulActivity || [])}
    </section>
  `;
}

function renderUsersTable(users = [], includeActions = true) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Email</th>
            <th>Anonymous</th>
            <th>Recipes</th>
            <th>Meals</th>
            <th>Eggs</th>
            <th>Free actions</th>
            <th>Last action</th>
          </tr>
        </thead>
        <tbody>
          ${users.map((user) => `
            <tr>
              <td>
                ${includeActions ? `<button class="link-button" data-user-uid="${escapeHtml(user.uid)}">${escapeHtml(user.uid)}</button>` : escapeHtml(user.uid)}
              </td>
              <td>${escapeHtml(text(user.email))}</td>
              <td>${escapeHtml(text(user.isAnonymous))}</td>
              <td>${escapeHtml(formatNumber(user.recipeCount))}</td>
              <td>${escapeHtml(formatNumber(user.mealCount))}</td>
              <td>${escapeHtml(text(user.cookies))}</td>
              <td>${escapeHtml(text(user.freePremiumActionsRemaining))}</td>
              <td>${escapeHtml(formatDate(user.lastRealActionAt))}</td>
            </tr>
          `).join("") || `<tr><td colspan="8" class="muted">No rows</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function loadUsers(params = {}) {
  setView("users");
  const search = params.q ?? "";
  const isAnonymous = params.isAnonymous ?? "";
  elements.usersView.innerHTML = `
    <form id="usersFilterForm" class="toolbar">
      <label>Search<input name="q" value="${escapeHtml(search)}" /></label>
      <label>Status
        <select name="isAnonymous">
          <option value="" ${isAnonymous === "" ? "selected" : ""}>All</option>
          <option value="false" ${isAnonymous === "false" ? "selected" : ""}>Registered</option>
          <option value="true" ${isAnonymous === "true" ? "selected" : ""}>Anonymous</option>
        </select>
      </label>
      <button class="secondary-button" type="submit">Apply</button>
    </form>
    <div class="muted">Loading…</div>
  `;

  const query = new URLSearchParams();
  if (search) query.set("q", search);
  if (isAnonymous) query.set("isAnonymous", isAnonymous);
  query.set("limit", "100");
  const data = await api(`/admin/users?${query.toString()}`);

  elements.usersView.innerHTML = `
    <form id="usersFilterForm" class="toolbar">
      <label>Search<input name="q" value="${escapeHtml(search)}" /></label>
      <label>Status
        <select name="isAnonymous">
          <option value="" ${isAnonymous === "" ? "selected" : ""}>All</option>
          <option value="false" ${isAnonymous === "false" ? "selected" : ""}>Registered</option>
          <option value="true" ${isAnonymous === "true" ? "selected" : ""}>Anonymous</option>
        </select>
      </label>
      <button class="secondary-button" type="submit">Apply</button>
    </form>
    ${renderUsersTable(data.users || [])}
  `;
}

function renderDetailList(entries) {
  return `
    <div class="detail-list">
      ${entries.map(([label, value]) => `
        <div class="detail-label">${escapeHtml(label)}</div>
        <div class="detail-value">${escapeHtml(value)}</div>
      `).join("")}
    </div>
  `;
}

async function loadUserDetail(uid) {
  setView("userDetail");
  elements.userDetailView.innerHTML = `<div class="muted">Loading…</div>`;
  const encodedUid = encodeURIComponent(uid);
  const [data, recipesData, mealsData] = await Promise.all([
    api(`/admin/users/${encodedUid}`),
    api(`/admin/users/${encodedUid}/recipes?limit=50`),
    api(`/admin/users/${encodedUid}/meals?limit=50`),
  ]);
  const summary = data.summary || {};
  const economy = data.economy || {};
  elements.viewSubtitle.textContent = summary.email || uid;
  elements.userDetailView.innerHTML = `
    <div class="split-grid">
      <section class="panel">
        <h2>Summary</h2>
        ${renderDetailList([
          ["UID", summary.uid || uid],
          ["Email", text(summary.email)],
          ["Display name", text(summary.displayName)],
          ["Anonymous", text(summary.isAnonymous)],
          ["Recipes", formatNumber(summary.recipeCount)],
          ["Meals", formatNumber(summary.mealCount)],
          ["Weights", formatNumber(summary.weightLogCount)],
          ["Last action", formatDate(summary.lastRealActionAt)],
          ["Last seen", formatDate(summary.lastSeenAt)],
        ])}
      </section>
      <section class="panel">
        <h2>Economy</h2>
        ${renderDetailList([
          ["Eggs", text(summary.cookies ?? economy.cookies)],
          ["Free actions", text(summary.freePremiumActionsRemaining ?? economy.freePremiumActionsRemaining)],
          ["Economy updated", formatDate(summary.economyUpdatedAt ?? economy.updatedAt)],
        ])}
      </section>
    </div>
    <section class="panel">
      <h2>Recent activity</h2>
      ${renderActivityTable(data.recentActivity || [])}
    </section>
    <section class="panel">
      <h2>Recent economy ledger</h2>
      ${renderLedgerTable(data.recentLedger || [])}
    </section>
    <section class="panel">
      <h2>Recipes</h2>
      ${renderRecipesTable(recipesData.recipes || [])}
    </section>
    <section class="panel">
      <h2>Meals</h2>
      ${renderMealsTable(mealsData.meals || [])}
    </section>
  `;
}

function renderLedgerTable(entries = []) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Kind</th>
            <th>Reason</th>
            <th>Delta</th>
            <th>Balance</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map((entry) => `
            <tr>
              <td>${escapeHtml(formatDate(entry.createdAt))}</td>
              <td>${escapeHtml(text(entry.kind))}</td>
              <td>${escapeHtml(text(entry.reason))}</td>
              <td>${escapeHtml(text(entry.delta))}</td>
              <td>${escapeHtml(text(entry.balanceAfter))}</td>
              <td>${escapeHtml(text(entry.source))}</td>
            </tr>
          `).join("") || `<tr><td colspan="6" class="muted">No rows</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderRecipesTable(recipes = []) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Updated</th>
            <th>Title</th>
            <th>Source</th>
            <th>Tags</th>
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          ${recipes.map((recipe) => {
            const source = recipe.sourceMetadata?.source || recipe.source || (recipe.sourceUrl ? "url" : "manual");
            const tags = Array.isArray(recipe.tags) ? recipe.tags.join(", ") : "";
            return `
              <tr>
                <td>${escapeHtml(formatDate(recipe.updatedAt || recipe.createdAt))}</td>
                <td>${escapeHtml(text(recipe.title || recipe.name))}</td>
                <td>${escapeHtml(text(source))}</td>
                <td>${escapeHtml(text(tags))}</td>
                <td>${escapeHtml(recipe.id)}</td>
              </tr>
            `;
          }).join("") || `<tr><td colspan="5" class="muted">No rows</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderMealsTable(meals = []) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Updated</th>
            <th>Date</th>
            <th>Title</th>
            <th>Source</th>
            <th>Calories</th>
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          ${meals.map((meal) => `
            <tr>
              <td>${escapeHtml(formatDate(meal.updatedAt || meal.createdAt))}</td>
              <td>${escapeHtml(text(meal.date || meal.dateKey))}</td>
              <td>${escapeHtml(text(meal.title || meal.name))}</td>
              <td>${escapeHtml(text(meal.source))}</td>
              <td>${escapeHtml(text(meal.calories))}</td>
              <td>${escapeHtml(meal.id)}</td>
            </tr>
          `).join("") || `<tr><td colspan="6" class="muted">No rows</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function loadActivity() {
  setView("activity");
  elements.activityView.innerHTML = `
    <form id="activityFilterForm" class="toolbar">
      <label>Type<input name="type" /></label>
      <label>Action<input name="action" /></label>
      <label>Source<input name="source" /></label>
      <label>Status<input name="status" /></label>
      <label>User<input name="uid" /></label>
      <button class="secondary-button" type="submit">Apply</button>
    </form>
    <div class="muted">Loading…</div>
  `;
  const data = await api("/admin/activity-events?limit=100");
  elements.activityView.innerHTML = `
    <form id="activityFilterForm" class="toolbar">
      <label>Type<input name="type" /></label>
      <label>Action<input name="action" /></label>
      <label>Source<input name="source" /></label>
      <label>Status<input name="status" /></label>
      <label>User<input name="uid" /></label>
      <button class="secondary-button" type="submit">Apply</button>
    </form>
    ${renderActivityTable(data.events || [])}
  `;
}

async function loadAuditLogs() {
  setView("audit");
  elements.auditView.innerHTML = `<div class="muted">Loading…</div>`;
  const data = await api("/admin/audit-logs?limit=100");
  const logs = data.logs || [];
  elements.auditView.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Admin</th>
            <th>Action</th>
            <th>Target</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((log) => `
            <tr>
              <td>${escapeHtml(formatDate(log.createdAt))}</td>
              <td>${escapeHtml(text(log.adminEmail || log.adminUid))}</td>
              <td>${escapeHtml(text(log.action))}</td>
              <td>${escapeHtml(text(log.targetUid || log.targetPath))}</td>
              <td>${escapeHtml(text(log.reason))}</td>
            </tr>
          `).join("") || `<tr><td colspan="5" class="muted">No rows</td></tr>`}
        </tbody>
      </table>
    </div>
    <section class="panel">
      <h2>Raw</h2>
      <pre class="json-block">${jsonPreview(logs)}</pre>
    </section>
  `;
}

async function refreshCurrentView() {
  try {
    if (state.currentView === "dashboard") await loadDashboard();
    else if (state.currentView === "capabilities") await loadCapabilities();
    else if (state.currentView === "users") await loadUsers();
    else if (state.currentView === "activity") await loadActivity();
    else if (state.currentView === "audit") await loadAuditLogs();
  } catch (err) {
    renderError(err);
  }
}

function renderError(err) {
  const target =
    state.currentView === "users"
      ? elements.usersView
      : state.currentView === "capabilities"
        ? elements.capabilitiesView
      : state.currentView === "activity"
        ? elements.activityView
        : state.currentView === "audit"
          ? elements.auditView
          : state.currentView === "userDetail"
            ? elements.userDetailView
            : elements.dashboardView;
  target.innerHTML = `<div class="error-text">${escapeHtml(err?.message || err)}</div>`;
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "Signing in with Firebase...";
  debugLogin("submit start");
  const submitButton = elements.loginForm.querySelector("button[type='submit']");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Signing in...";
  }
  try {
    const session = await signInWithPassword(elements.emailInput.value.trim(), elements.passwordInput.value);
    debugLogin("firebase sign-in success", { uid: session.uid, email: session.email });
    setSession(session);
    elements.loginError.textContent = "Verifying admin access...";
    await api("/admin/me");
    debugLogin("admin verification success");
  } catch (err) {
    const message = err?.name === "AbortError"
      ? "Sign-in timed out. Check backend logs and network access."
      : err?.message || String(err) || "Sign in failed";
    elements.loginError.textContent = message;
    debugLogin("login failed", { message });
    showLoginShell();
    return;
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Sign in";
    }
  }

  elements.passwordInput.value = "";
  elements.loginError.textContent = "";
  showAdminShell();
  setView("dashboard");
  elements.dashboardView.innerHTML = `<div class="muted">Loading dashboard...</div>`;
  loadDashboard().catch((dashboardErr) => {
    setView("dashboard");
    renderError(dashboardErr);
  });
});

elements.signOutButton.addEventListener("click", () => {
  clearSession();
  showLoginShell();
});

elements.refreshButton.addEventListener("click", () => {
  void refreshCurrentView();
});

for (const button of elements.navButtons) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view === "dashboard") void loadDashboard();
    else if (view === "capabilities") void loadCapabilities();
    else if (view === "users") void loadUsers();
    else if (view === "activity") void loadActivity();
    else if (view === "audit") void loadAuditLogs();
  });
}

document.addEventListener("submit", (event) => {
  if (event.target?.id === "usersFilterForm") {
    event.preventDefault();
    const form = new FormData(event.target);
    void loadUsers({
      q: String(form.get("q") || "").trim(),
      isAnonymous: String(form.get("isAnonymous") || "").trim(),
    });
  }

  if (event.target?.id === "activityFilterForm") {
    event.preventDefault();
    const form = new FormData(event.target);
    const query = new URLSearchParams();
    for (const key of ["type", "action", "source", "status", "uid"]) {
      const value = String(form.get(key) || "").trim();
      if (value) query.set(key, value);
    }
    query.set("limit", "100");
    setView("activity");
    elements.activityView.innerHTML = `<div class="muted">Loading…</div>`;
    api(`/admin/activity-events?${query.toString()}`)
      .then((data) => {
        elements.activityView.innerHTML = `${renderActivityTable(data.events || [])}`;
      })
      .catch(renderError);
  }
});

document.addEventListener("click", (event) => {
  const uid = event.target?.dataset?.userUid;
  if (uid) {
    void loadUserDetail(uid);
  }
});

function showAdminShell() {
  elements.loginView.hidden = true;
  elements.adminView.hidden = false;
  elements.signOutButton.hidden = false;
  elements.sessionEmail.textContent = state.user?.email || state.user?.uid || "Admin";
}

function showLoginShell() {
  elements.loginView.hidden = false;
  elements.adminView.hidden = true;
  elements.signOutButton.hidden = true;
  elements.sessionEmail.textContent = "Signed out";
}

async function boot() {
  if (!loadStoredSession()) {
    showLoginShell();
    return;
  }

  try {
    showAdminShell();
    await api("/admin/me");
  } catch (err) {
    clearSession();
    showLoginShell();
    elements.loginError.textContent = err?.message || "Admin access denied";
    return;
  }

  setView("dashboard");
  elements.dashboardView.innerHTML = `<div class="muted">Loading dashboard...</div>`;
  loadDashboard().catch((dashboardErr) => {
    setView("dashboard");
    renderError(dashboardErr);
  });
}

void boot();
