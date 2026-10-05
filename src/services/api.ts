/**
 * Frontend HTTP client for the FastAPI backend: the low-level `request()` helper, JWT storage
 * helpers and the `api` object with one wrapper per endpoint, grouped by feature. Every path
 * is relative to `/api`, which the Vite dev server (vite.config.ts) and nginx
 * (nginx/conf.d/nexus.conf) forward to the backend with that prefix stripped.
 * All wrappers resolve to `{ data, error, meta?, warnings? }` and do not throw on HTTP or
 * network failures. Used by AuthContext and by nearly every dashboard page; admin calls
 * authenticate with the X-Admin-Auth header (see getAdminAuthHeader).
 */

/** Base path for all backend calls; proxied to the FastAPI server (see file header). */
const API_URL = "/api";
/** localStorage key for the user's JWT. lib/impersonation.ts hardcodes the same string, so keep them in sync. */
const TOKEN_KEY = "nexus_token";

/** Returns the user's JWT from localStorage, or null when signed out. */
export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Saves the user's JWT to localStorage; a null (or empty) token removes it, which signs the user out locally. */
export function setStoredToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Async wrapper over getStoredToken, used by request() and the file-upload call. */
async function getToken(): Promise<string | null> {
  return getStoredToken();
}

/**
 * Core fetch wrapper behind every api.* call. Sends JSON, attaches `Authorization: Bearer`
 * whenever a user token is stored (admin calls carry it too, plus X-Admin-Auth passed in
 * `options.headers`), and normalizes the outcome instead of throwing.
 *
 * Success: the backend envelope is `{ data, error, meta?, warnings? }`. `data` is unwrapped when
 * present; otherwise the whole body is returned, because some endpoints reply with a bare object.
 * `error` is passed through even on a 2xx. `meta` carries extras such as list counts and
 * `warnings` carries non-fatal problems (e.g. agents that failed to re-sync after a call-event edit).
 * Failure: a non-2xx response yields `error` from FastAPI's `detail`, or "Error <status>";
 * a network failure yields the exception message.
 */
async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<{ data: T | null; error: string | null; meta?: any; warnings?: string[] }> {
  const token = await getToken();
  // Always JSON, though callers may override via options.headers. File uploads bypass this
  // wrapper (see uploadAgentKnowledge) because multipart bodies need the browser to set the
  // Content-Type itself, with its boundary.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`${API_URL}${path}`, { ...options, headers });
    if (!res.ok) {
      // FastAPI reports errors as { detail }; an unparseable error body falls back to the status
      // code. Note that 422 validation errors carry an array in `detail`, passed through as-is.
      const body = await res.json().catch(() => ({}));
      return { data: null, error: body.detail || `Error ${res.status}` };
    }
    const body = await res.json();
    return { data: body.data ?? body, error: body.error ?? null, meta: body.meta, warnings: body.warnings };
  } catch (e: any) {
    return { data: null, error: e.message || "Network error" };
  }
}

/** GET `path` (relative to /api). */
function get<T = any>(path: string) {
  return request<T>(path);
}

/** POST `path` with an optional JSON body (no body is sent when it is falsy). */
function post<T = any>(path: string, body?: any) {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

/** PATCH `path` with a JSON body. */
function patch<T = any>(path: string, body: any) {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

/** DELETE `path`; named `del` because `delete` is a reserved word. */
function del<T = any>(path: string) {
  return request<T>(path, { method: "DELETE" });
}

/**
 * sessionStorage key for the admin-portal JWT (set by Admin.tsx after api.adminLogin). It lives
 * in sessionStorage, not localStorage, so it disappears when the tab closes.
 */
export const ADMIN_TOKEN_KEY = "nexus_admin_token";

/** Builds the X-Admin-Auth header from the stored admin JWT; empty when no admin is logged in. */
function getAdminAuthHeader(): Record<string, string> {
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  return token ? { "X-Admin-Auth": token } : {};
}

/** Like get(), but sends the admin token (for /admin/* endpoints). */
function adminGet<T = any>(path: string) {
  return request<T>(path, { headers: getAdminAuthHeader() });
}

/** Like post(), but sends the admin token (for /admin/* endpoints). */
function adminPost<T = any>(path: string, body?: any) {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: getAdminAuthHeader() });
}

/** Like patch(), but sends the admin token (for /admin/* endpoints). */
function adminPatch<T = any>(path: string, body: any) {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body), headers: getAdminAuthHeader() });
}

/**
 * Endpoint wrappers grouped by feature; each returns the `{ data, error, meta?, warnings? }`
 * result of request(). Callers must check `error` before using `data`.
 */
export const api = {
  // Auth — each takes a single object payload (AuthContext calls api.login({ email, password }))
  // Creates an UNVERIFIED account; no token is returned until the emailed link is redeemed.
  register: (data: { email: string; password: string; full_name?: string; app_url?: string; recaptcha_token?: string; referral_code?: string }) => post("/auth/register", data),
  login: (data: { email: string; password: string }) => post("/auth/login", data),
  // The response includes an access_token that the caller must store (the VerifyEmail page does).
  verifyEmail: (token: string) => post("/auth/verify-email", { token }),
  resendVerification: (email: string, app_url?: string) => post("/auth/resend-verification", { email, app_url }),
  // Current user plus profile; AuthContext uses it to validate a stored token.
  getMe: () => get("/auth/me"),

  // Agents
  getAgents: () => get("/agents"),
  getAgent: (id: string) => get(`/agents/${id}`),
  createAgent: (data: any) => post("/agents", data),
  // Text-only dry run of a not-yet-saved prompt (a single OpenAI completion); nothing is saved or called.
  testAgent: (data: { message: string; system_prompt?: string | null; first_message?: string | null }) => post("/agents/test", data),
  // Live voice test of an unsaved agent: start creates a throwaway VAPI assistant and end
  // deletes it (best effort; the backend reports success even if the deletion fails).
  startVoiceTest: (data: { name: string; voice?: string | null; language?: string | null; system_prompt?: string | null; first_message?: string | null }) =>
    post("/agents/test-voice/start", data),
  endVoiceTest: (assistantId: string) => del(`/agents/test-voice/${assistantId}`),
  // Fetches the site and suggests a Main Goal and Industry for the Create-agent wizard (limited to 10/min per IP).
  analyzeAgentWebsite: (url: string) => post("/agents/analyze-website", { url }),
  updateAgent: (id: string, data: any) => patch(`/agents/${id}`, data),
  getAgentEvents: (id: string) => get(`/agents/${id}/events`),
  // Agent tools (SMS, email, calendar...) and the Google Calendar connection
  getToolPresets: () => get("/agents/tool-presets"),
  getCalendarStatus: () => get("/calendar/status"),
  // Returns { url } for Google's consent screen; `tz` (the browser's IANA timezone) becomes the new
  // connection's default timezone. Owner-only; 503 when Google OAuth is not configured on the server.
  getCalendarConnectUrl: (tz: string) => get(`/calendar/google/connect-url?tz=${encodeURIComponent(tz)}`),
  updateCalendarSettings: (data: Record<string, unknown>) => patch("/calendar/settings", data),
  disconnectCalendar: () => del("/calendar/google"),
  // Callbacks (calls customers asked for) and their settings
  getCallbacks: (status?: string) => get(`/callbacks${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  // Send exactly one of `due_local` (reschedule, a local date-time in the account's timezone) or
  // `status`; the backend answers 400 if both or neither are present.
  updateCallback: (id: string, data: { due_local?: string; status?: "cancelled" | "called" }) => patch(`/callbacks/${id}`, data),
  getCallbackSettings: () => get("/callbacks/settings"),
  updateCallbackSettings: (data: Record<string, unknown>) => patch("/callbacks/settings", data),
  // Call event library (account-level events agents pick from)
  getCallEvents: () => get("/call-events"),
  // `applies_to` must be "both", "inbound" or "outbound"; the backend rejects anything else with 422.
  createCallEvent: (data: { label: string; description?: string | null; outcome?: string | null; applies_to?: string }) => post("/call-events", data),
  // The edit is copied to every agent using the event. If re-syncing some agents fails, the edit is
  // still kept and their names come back in `warnings`, not `error`.
  updateCallEvent: (id: string, data: { label?: string; description?: string | null; outcome?: string | null; applies_to?: string }) => patch(`/call-events/${id}`, data),
  deleteCallEvent: (id: string) => del(`/call-events/${id}`),
  deleteAgent: (id: string) => del(`/agents/${id}`),
  // Creates the VAPI assistant for an agent that has none yet (e.g. saved while VAPI was not
  // configured). Idempotent: an agent that already has one is returned unchanged.
  syncAgentVapi: (id: string) => post(`/agents/${id}/sync-vapi`),
  /**
   * Uploads a knowledge file for an agent as multipart/form-data (POST /agents/{id}/knowledge).
   * Calls fetch directly instead of request(): that helper forces a JSON Content-Type, which
   * would break the multipart boundary, so only the Authorization header is sent. Resolves to
   * `{ data, error }` like the other calls, but without `meta` or `warnings`.
   */
  uploadAgentKnowledge: async (agentId: string, file: File) => {
    const token = await getToken();
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API_URL}/agents/${agentId}/knowledge`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { data: null, error: body.detail || `Error ${res.status}` };
      }
      const body = await res.json();
      return { data: body.data ?? body, error: body.error ?? null };
    } catch (e: any) {
      return { data: null, error: e.message || "Network error" };
    }
  },

  // Contacts
  getContacts: () => get("/contacts"),
  createContact: (data: any) => post("/contacts", data),
  updateContact: (id: string, data: any) => patch(`/contacts/${id}`, data),
  deleteContact: (id: string) => del(`/contacts/${id}`),

  // Lists
  getLists: () => get("/lists"),
  createList: (data: any) => post("/lists", data),
  updateList: (id: string, data: any) => patch(`/lists/${id}`, data),
  deleteList: (id: string) => del(`/lists/${id}`),

  // Tools
  getTools: () => get("/tools"),
  createTool: (data: any) => post("/tools", data),
  updateTool: (id: string, data: any) => patch(`/tools/${id}`, data),
  deleteTool: (id: string) => del(`/tools/${id}`),
  testTool: (id: string) => post(`/tools/${id}/test`),

  // Conversations
  // `params` is a ready-made query string without the leading "?"; it is appended unencoded, so
  // callers must encode values themselves (same for getConversationStats and getRuns).
  getConversations: (params?: string) => get(`/conversations${params ? `?${params}` : ""}`),
  getConversation: (id: string) => get(`/conversations/${id}`),
  getConversationEvents: (id: string) => get(`/conversations/${id}/events`),
  getConversationTranscript: (id: string) => get(`/conversations/${id}/transcript`),
  // Returns a fresh playable URL on every call: the stored recording link is not streamable and the
  // presigned URLs the provider issues expire, so do not cache the result for long.
  getConversationRecordingUrl: (id: string) => get(`/conversations/${id}/recording-url`),
  getConversationStats: (params?: string) => get(`/conversations/stats${params ? `?${params}` : ""}`),
  // Manual pull of recent VAPI calls (recording + transcript) for this account's agents into the
  // conversations table; idempotent (existing rows are updated, new ones inserted).
  syncConversationsFromVapi: () => post("/conversations/sync-from-vapi"),
  deleteConversation: (id: string) => del(`/conversations/${id}`),

  // Telephony - Phone Numbers
  getPhoneNumbers: () => get("/telephony/phone-numbers"),
  // A Twilio number is paid from the wallet when the balance covers it; otherwise the response is
  // { needs_payment, checkout_url, session_id } for a Stripe Checkout. `success_url` is where Stripe
  // returns (the page then calls confirmPhonePurchase with the session_id); it is built from the
  // current origin so it works in dev and prod.
  createPhoneNumber: (data: any) => post("/telephony/phone-numbers", {
    ...data,
    success_url: `${window.location.origin}/dashboard/telephony/phone-numbers`,
  }),
  confirmPhonePurchase: (session_id: string) => post("/telephony/phone-numbers/confirm", { session_id }),
  updatePhoneNumber: (id: string, data: any) => patch(`/telephony/phone-numbers/${id}`, data),
  deletePhoneNumber: (id: string) => del(`/telephony/phone-numbers/${id}`),

  // Telephony - BYOT (Bring Your Own Twilio)
  getTwilioCredentials: () => get("/telephony/twilio-credentials"),
  createTwilioCredential: (data: { account_sid: string; auth_token: string; label?: string }) =>
    post("/telephony/twilio-credentials", data),
  updateTwilioCredential: (id: string, data: { account_sid?: string; auth_token?: string; label?: string }) =>
    patch(`/telephony/twilio-credentials/${id}`, data),
  deleteTwilioCredential: (id: string) => del(`/telephony/twilio-credentials/${id}`),
  createByotPhoneNumber: (data: any) => post("/telephony/phone-numbers/byot", data),

  // Telephony - Campaigns
  getCampaigns: () => get("/telephony/campaigns"),
  createCampaign: (data: any) => post("/telephony/campaigns", data),
  getCampaign: (id: string) => get(`/telephony/campaigns/${id}`),
  updateCampaign: (id: string, data: any) => patch(`/telephony/campaigns/${id}`, data),
  deleteCampaign: (id: string) => del(`/telephony/campaigns/${id}`),
  startCampaign: (id: string) => post(`/telephony/campaigns/${id}/start`),
  pauseCampaign: (id: string) => post(`/telephony/campaigns/${id}/pause`),
  resumeCampaign: (id: string) => post(`/telephony/campaigns/${id}/resume`),

  // Telephony - Call
  // Places one outbound call. The backend rejects blocked/trial accounts, an empty wallet balance
  // and numbers that fail do-not-call screening; the cost is billed when the call ends.
  makeCall: (data: any) => post("/telephony/call", data),
  // Live status polled from VAPI, keyed by the VAPI call id (not the local conversation id).
  getCallStatus: (vapiCallId: string) => get(`/telephony/call/${vapiCallId}/status`),

  // Telephony - Inbound
  getInboundQueues: () => get("/telephony/inbound"),
  createInboundQueue: (data: any) => post("/telephony/inbound", data),
  updateInboundQueue: (id: string, data: any) => patch(`/telephony/inbound/${id}`, data),
  deleteInboundQueue: (id: string) => del(`/telephony/inbound/${id}`),

  // Voice Widgets
  getVoiceWidgets: () => get("/voice-widgets"),
  createVoiceWidget: (data: any) => post("/voice-widgets", data),
  updateVoiceWidget: (id: string, data: any) => patch(`/voice-widgets/${id}`, data),
  deleteVoiceWidget: (id: string) => del(`/voice-widgets/${id}`),

  // Integrations
  getIntegrations: () => get("/integrations"),
  createIntegration: (data: any) => post("/integrations", data),
  updateIntegration: (id: string, data: any) => patch(`/integrations/${id}`, data),
  deleteIntegration: (id: string) => del(`/integrations/${id}`),
  testIntegration: (id: string) => post(`/integrations/${id}/test`),
  // Whether the do-not-call screening integration is configured and active, plus its integration id.
  getDncStatus: () => get("/integrations/dnc-status"),

  // Analytics
  getAnalyticsOverview: () => get("/analytics/overview"),
  getAnalyticsChannel: () => get("/analytics/channel"),
  getAnalyticsCampaign: () => get("/analytics/campaign"),
  getAnalyticsAgent: () => get("/analytics/agent"),
  getAnalyticsTimeseries: (days = 14) => get(`/analytics/timeseries?days=${days}`),

  // Automation
  getFlows: () => get("/automation/flows"),
  createFlow: (data: any) => post("/automation/flows", data),
  getFlow: (id: string) => get(`/automation/flows/${id}`),
  updateFlow: (id: string, data: any) => patch(`/automation/flows/${id}`, data),
  deleteFlow: (id: string) => del(`/automation/flows/${id}`),
  getFlowVersions: (flowId: string) => get(`/automation/flows/${flowId}/versions`),
  getFlowVersion: (flowId: string, versionId: string) => get(`/automation/flows/${flowId}/versions/${versionId}`),
  restoreFlowVersion: (flowId: string, versionId: string) => post(`/automation/flows/${flowId}/versions/${versionId}/restore`),
  runFlowNow: (flowId: string) => post(`/automation/flows/${flowId}/run`),
  // `params` is an unencoded query string, as with getConversations.
  getRuns: (params?: string) => get(`/automation/runs${params ? `?${params}` : ""}`),
  getRunsStats: () => get("/automation/runs/stats"),

  // Team
  getTeam: () => get("/team"),
  getMyRole: () => get("/team/me"),
  // `app_url` (the current origin) lets the backend point the emailed invite link back at this host.
  inviteTeamMember: (data: any) => post("/team/invite", { ...data, app_url: window.location.origin }),
  updateTeamMember: (id: string, data: any) => patch(`/team/${id}`, data),
  removeTeamMember: (id: string) => del(`/team/${id}`),
  getInvite: (token: string) => get(`/team/invite/${token}`),
  acceptInvite: (data: { token: string; password: string; full_name?: string }) => post("/team/accept-invite", data),

  // Profile
  getProfile: () => get("/profile"),
  updateProfile: (data: any) => patch("/profile", data),

  // Billing
  getBillingStatus: () => get("/billing/status"),
  getBillingInvoices: () => get("/billing/invoices"),
  // summaryOnly=true returns just the account totals without the per-call rows (much less data).
  getBillingCallCosts: (summaryOnly = false) =>
    get(`/billing/call-costs${summaryOnly ? "?summary_only=true" : ""}`),
  // Wallet / balance
  // Starts a Stripe Checkout for a wallet top-up; on return BillingOverview reads
  // ?topup=success&session_id=... from the URL and calls topupConfirm to credit the wallet.
  topupCheckout: (amount: number) => post("/billing/topup/checkout", {
    amount,
    // Return to wherever the app is actually running (localhost in dev, the deployed
    // domain in prod) — the backend appends ?topup=success&session_id=…
    success_url: `${window.location.origin}/dashboard/billing`,
    cancel_url: `${window.location.origin}/dashboard/billing`,
  }),
  topupConfirm: (session_id: string) => post("/billing/topup/confirm", { session_id }),
  getWalletTransactions: () => get("/billing/transactions"),
  // Stripe publishable key (served by the backend so it always matches its key mode)
  getStripeConfig: () => get("/billing/config"),
  // Payment methods (saved cards)
  getPaymentMethods: () => get("/billing/payment-methods"),
  createSetupIntent: () => post("/billing/payment-methods/setup-intent"),
  setDefaultPaymentMethod: (id: string) => post(`/billing/payment-methods/${id}/default`),
  deletePaymentMethod: (id: string) => del(`/billing/payment-methods/${id}`),
  // Auto-recharge
  // The endpoint is PUT and there is no put() helper, so this calls request() directly.
  updateAutoRecharge: (data: { enabled: boolean; threshold?: number; amount?: number }) =>
    request("/billing/auto-recharge", { method: "PUT", body: JSON.stringify(data) }),
  // Promotions
  getPromotions: () => get("/billing/promotions"),
  redeemPromoCode: (code: string) => post("/billing/promotions/redeem", { code }),

  // Referrals
  getMyReferrals: () => get("/referrals/me"),

  // Notifications
  getNotifications: () => get("/notifications"),
  // With an id marks that one notification read; with none, marks all of the account's notifications read.
  markNotificationsRead: (id?: string) => post("/notifications/read", id ? { id } : {}),

  // Admin
  // Exchanges the server-configured admin credentials for an admin JWT (`admin_token` in the
  // response). Uses plain post() because no admin token exists yet at this point.
  adminLogin: (username: string, password: string) => post("/admin/login", { username, password }),
  getAdminStats: () => adminGet("/admin/stats"),
  getAdminUsers: () => adminGet("/admin/users"),
  createAdminUser: (data: { email: string; password: string; full_name?: string }) => adminPost("/admin/users", data),
  getAdminAgents: () => adminGet("/admin/agents"),
  getAdminPhoneNumbers: () => adminGet("/admin/phone-numbers"),
  getAdminReferrals: () => adminGet("/admin/referrals"),
  getAdminPayments: () => adminGet("/admin/payments"),
  getAdminRevenue: () => adminGet("/admin/revenue"),
  getAdminAgentsReport: () => adminGet("/admin/agents-report"),
  getAdminUsersReport: () => adminGet("/admin/users-report"),
  getAdminSettings: () => adminGet("/admin/settings"),
  updateAdminSettings: (data: any) => adminPatch("/admin/settings", data),
  getAdminPromoKpis: () => adminGet("/admin/promo-kpis"),
  getAdminPromoCodes: () => adminGet("/admin/promo-codes"),
  createAdminPromoCode: (data: any) => adminPost("/admin/promo-codes", data),
  updateAdminPromoCode: (id: string, data: any) => adminPatch(`/admin/promo-codes/${id}`, data),
  // There is no admin DELETE helper, so this and deleteAdminUser call request() directly with the admin header.
  deleteAdminPromoCode: (id: string) =>
    request(`/admin/promo-codes/${id}`, { method: "DELETE", headers: getAdminAuthHeader() }),
  getAdminUser: (id: string) => adminGet(`/admin/users/${id}`),
  updateAdminUser: (id: string, data: any) => adminPatch(`/admin/users/${id}`, data),
  deleteAdminUser: (id: string) => request(`/admin/users/${id}`, { method: "DELETE", headers: getAdminAuthHeader() }),
  // Issues a short-lived (2h) login token for "view as user"; lib/impersonation.ts hands it to the
  // main app through the URL. The backend logs every impersonation.
  impersonateUser: (id: string) => adminPost(`/admin/users/${id}/impersonate`),
  // `amount` is signed (negative removes funds) and is recorded in the wallet ledger as an admin entry.
  adjustUserBalance: (id: string, amount: number, reason?: string) => adminPost(`/admin/users/${id}/balance`, { amount, reason }),
  // Flips the user's billing.is_active flag; an inactive account cannot place calls or create agents.
  toggleAccess: (id: string) => adminPost(`/admin/users/${id}/toggle-access`),

  // Health
  // Unauthenticated liveness probe; the body is { status: "ok" }, with no data envelope.
  getHealth: () => get("/health"),

  // Auth — password flows (login/register/getMe are defined above; do not redefine
  // them here or the duplicate keys override those with an incompatible signature)
  forgotPassword: (email: string) =>
    post("/auth/forgot-password", { email }),
  resetPassword: (token: string, new_password: string) =>
    post("/auth/reset-password", { token, new_password }),
  changePassword: (current_password: string, new_password: string) =>
    post("/auth/change-password", { current_password, new_password }),
};
