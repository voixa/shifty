// api.js v3 — REST API クライアント（認証 + デモモード対応）
(function () {
  const isDemo = !!window.__SHIFTY_DEMO_MODE__;
  const DEMO_KEY = "shifty.demo.state";

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
    // Auth
    authStatus: () => jsonReq("/api/auth/status"),
    authLogin: (password) => jsonReq("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
    authSetup: (password) => jsonReq("/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) }),
    authLogout: () => jsonReq("/api/auth/logout", { method: "POST" }),
    authChangePassword: (current, next) =>
      jsonReq("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current, new: next }) }),

    // State
    getState: () => jsonReq("/api/state"),
    saveState: (s) => jsonReq("/api/state", { method: "POST", body: JSON.stringify(s) }),
    resetServer: () => jsonReq("/api/admin/reset", { method: "POST" }),
    backup: () => jsonReq("/api/admin/backup"),
    restore: (data) => jsonReq("/api/admin/restore", { method: "POST", body: JSON.stringify(data) }),

    // Tokens
    genStaffToken: (staffId) =>
      jsonReq(`/api/admin/staff/${encodeURIComponent(staffId)}/token`, { method: "POST" }),
    regenerateStaffToken: (staffId) =>
      jsonReq(`/api/admin/staff/${encodeURIComponent(staffId)}/token?force=1`, { method: "POST" }),
    listStaffTokens: () => jsonReq("/api/admin/staff/tokens"),
    revokeStaffToken: (staffId) =>
      jsonReq(`/api/admin/staff/${encodeURIComponent(staffId)}/token`, { method: "DELETE" }),

    // Notification (admin)
    notifyShifts: (weekStart) =>
      jsonReq("/api/admin/notify_shifts", { method: "POST", body: JSON.stringify({ weekStart }) }),

    // Snapshots (admin)
    listSnapshots: () => jsonReq("/api/admin/snapshots"),
    restoreSnapshot: (date) => jsonReq(`/api/admin/snapshots/${encodeURIComponent(date)}/restore`, { method: "POST" }),

    // Staff messages (admin)
    listStaffMessages: () => jsonReq("/api/admin/staff_messages"),

    // Portal message (public)
    portalSendMessage: (token, kind, message) =>
      jsonReq(`/api/portal/${encodeURIComponent(token)}/message`, {
        method: "POST",
        body: JSON.stringify({ kind, message }),
      }),

    // Stripe (public)
    checkoutSession: (data) =>
      jsonReq("/api/checkout/session", { method: "POST", body: JSON.stringify(data) }),

    // Portal (public)
    portalGet: (token) => jsonReq(`/api/portal/${encodeURIComponent(token)}`),
    portalSavePrefs: (token, prefs) =>
      jsonReq(`/api/portal/${encodeURIComponent(token)}/preferences`, {
        method: "POST",
        body: JSON.stringify(prefs),
      }),

    isDemo,
  };

  window.ShiftyAPI = API;
})();
