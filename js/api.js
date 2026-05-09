// api.js v4 — REST API クライアント（multi-tenant + 認証 + デモ対応）
(function () {
  const isDemo = !!window.__SHIFTY_DEMO_MODE__;
  const DEMO_KEY = "shifty.demo.state";

  // /t/{slug}/app の URL を tenant 文脈として解釈
  // それ以外（/app, /demo）は単一テナント default として動作
  const tenantMatch = location.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{2,30}[a-z0-9])\//);
  const tenantSlug = tenantMatch ? tenantMatch[1] : null;
  const tenantPrefix = tenantSlug ? `/api/t/${tenantSlug}` : "/api";

  function uid(p = "") { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ===== Demo mode handler =====
  // 全 API 呼び出しを localStorage / メモリで完結
  async function demoHandle(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();

    // Auth
    if (url === "/api/auth/status") return { authenticated: true, setupRequired: false, demo: true };
    if (url === "/api/auth/login" || url === "/api/auth/setup") return { ok: true };
    if (url === "/api/auth/logout") return { ok: true };
    if (url === "/api/auth/change-password") return { ok: true };

    // State
    if (url === "/api/state" && method === "GET") {
      try {
        const raw = localStorage.getItem(DEMO_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    }
    if (url === "/api/state" && method === "POST") {
      try { localStorage.setItem(DEMO_KEY, opts.body); } catch (_) {}
      return { ok: true };
    }
    if (url === "/api/admin/reset") {
      try { localStorage.removeItem(DEMO_KEY); } catch (_) {}
      return { ok: true };
    }
    if (url === "/api/admin/backup") {
      let st = null;
      try { const raw = localStorage.getItem(DEMO_KEY); st = raw ? JSON.parse(raw) : null; } catch (_) {}
      return { version: 1, createdAt: new Date().toISOString(), state: st, tokens: {}, backend: "demo" };
    }
    if (url === "/api/admin/restore") {
      try { const data = JSON.parse(opts.body); if (data?.state) localStorage.setItem(DEMO_KEY, JSON.stringify(data.state)); } catch (_) {}
      return { ok: true };
    }

    // Tokens
    if (url.match(/\/api\/admin\/staff\/.+\/token(\?.*)?$/) && method === "POST") {
      const forced = /[?&]force=1/.test(url);
      return { token: "demo-" + uid(), created: true, regenerated: forced };
    }
    if (url === "/api/admin/staff/tokens") return {};
    if (url.match(/\/api\/admin\/staff\/.+\/token$/) && method === "DELETE") return { ok: true };

    // Inquiries
    if (url === "/api/admin/inquiries") return [];

    return { ok: true };
  }

  async function jsonReq(url, opts = {}) {
    if (isDemo) return demoHandle(url, opts);

    const r = await fetch(url, {
      credentials: "same-origin",
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (r.status === 401) {
      if (typeof window.onAuthRequired === "function") {
        try { window.onAuthRequired(); } catch (_) {}
      }
      throw new Error("API 401: unauthenticated");
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`API ${r.status}: ${text || url}`);
    }
    if (r.status === 204) return null;
    return r.json();
  }

  const API = {
    // Tenant context
    tenantSlug,

    // Auth
    authStatus: () => tenantSlug
      ? jsonReq(`${tenantPrefix}/auth/status`)
      : jsonReq("/api/auth/status"),
    authLogin: (password) => jsonReq("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
    authSetup: (password) => jsonReq("/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) }),
    authLogout: () => tenantSlug
      ? jsonReq(`${tenantPrefix}/auth/logout`, { method: "POST" })
      : jsonReq("/api/auth/logout", { method: "POST" }),
    authChangePassword: (current, next) =>
      jsonReq("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current, new: next }) }),
    requestMagicLink: (email) =>
      jsonReq("/api/auth/magic-link/request", { method: "POST", body: JSON.stringify({ email }) }),

    // State (tenant-aware)
    getState: () => jsonReq(`${tenantPrefix}/state`),
    saveState: (s) => jsonReq(`${tenantPrefix}/state`, { method: "POST", body: JSON.stringify(s) }),
    resetServer: () => jsonReq("/api/admin/reset", { method: "POST" }),
    backup: () => jsonReq("/api/admin/backup"),
    restore: (data) => jsonReq("/api/admin/restore", { method: "POST", body: JSON.stringify(data) }),

    // Tokens (tenant-aware)
    genStaffToken: (staffId) => tenantSlug
      ? jsonReq(`${tenantPrefix}/admin/staff/${encodeURIComponent(staffId)}/token`, { method: "POST" })
      : jsonReq(`/api/admin/staff/${encodeURIComponent(staffId)}/token`, { method: "POST" }),
    regenerateStaffToken: (staffId) => tenantSlug
      ? jsonReq(`${tenantPrefix}/admin/staff/${encodeURIComponent(staffId)}/token?force=1`, { method: "POST" })
      : jsonReq(`/api/admin/staff/${encodeURIComponent(staffId)}/token?force=1`, { method: "POST" }),
    listStaffTokens: () => tenantSlug
      ? jsonReq(`${tenantPrefix}/admin/staff/tokens`)
      : jsonReq("/api/admin/staff/tokens"),
    revokeStaffToken: (staffId) => tenantSlug
      ? jsonReq(`${tenantPrefix}/admin/staff/${encodeURIComponent(staffId)}/token`, { method: "DELETE" })
      : jsonReq(`/api/admin/staff/${encodeURIComponent(staffId)}/token`, { method: "DELETE" }),

    // Notification (admin) — staffIds 指定で限定送信、subjectPrefix で件名カスタム
    notifyShifts: (weekStart, options = {}) =>
      jsonReq("/api/admin/notify_shifts", {
        method: "POST",
        body: JSON.stringify({ weekStart, ...options }),
      }),

    // Snapshots (admin)
    listSnapshots: () => jsonReq("/api/admin/snapshots"),
    restoreSnapshot: (date) => jsonReq(`/api/admin/snapshots/${encodeURIComponent(date)}/restore`, { method: "POST" }),

    // Staff messages (admin)
    listStaffMessages: () => jsonReq("/api/admin/staff_messages"),

    // Portal message (public, tenant-aware)
    portalSendMessage: (token, kind, message) => tenantSlug
      ? jsonReq(`${tenantPrefix}/portal/${encodeURIComponent(token)}/message`, {
          method: "POST", body: JSON.stringify({ kind, message }),
        })
      : jsonReq(`/api/portal/${encodeURIComponent(token)}/message`, {
          method: "POST", body: JSON.stringify({ kind, message }),
        }),

    // Stripe (public)
    checkoutSession: (data) =>
      jsonReq("/api/checkout/session", { method: "POST", body: JSON.stringify(data) }),

    // Portal (public, tenant-aware) — weekStart で別週も指定可 (Round 15 TOP 2)
    portalGet: (token, weekStart) => {
      const q = weekStart ? `?week=${encodeURIComponent(weekStart)}` : "";
      return tenantSlug
        ? jsonReq(`${tenantPrefix}/portal/${encodeURIComponent(token)}${q}`)
        : jsonReq(`/api/portal/${encodeURIComponent(token)}${q}`);
    },
    portalSavePrefs: (token, prefs) => tenantSlug
      ? jsonReq(`${tenantPrefix}/portal/${encodeURIComponent(token)}/preferences`, {
          method: "POST", body: JSON.stringify(prefs),
        })
      : jsonReq(`/api/portal/${encodeURIComponent(token)}/preferences`, {
          method: "POST", body: JSON.stringify(prefs),
        }),
    // 長期休暇申請 (Round 16 TOP 1)
    portalSubmitVacation: (token, payload) => tenantSlug
      ? jsonReq(`${tenantPrefix}/portal/${encodeURIComponent(token)}/vacation-request`, {
          method: "POST", body: JSON.stringify(payload),
        })
      : Promise.reject(new Error("legacy_mode_not_supported")),

    // シフト交換 (Round 16 TOP 2)
    portalCreateSwap: (token, payload) => tenantSlug
      ? jsonReq(`${tenantPrefix}/portal/${encodeURIComponent(token)}/swap-request`, {
          method: "POST", body: JSON.stringify(payload),
        })
      : Promise.reject(new Error("legacy_mode_not_supported")),
    portalTakeSwap: (token, sid) => tenantSlug
      ? jsonReq(`${tenantPrefix}/portal/${encodeURIComponent(token)}/swap-request/${encodeURIComponent(sid)}/take`, {
          method: "POST",
        })
      : Promise.reject(new Error("legacy_mode_not_supported")),

    isDemo,
  };

  window.ShiftyAPI = API;
})();
