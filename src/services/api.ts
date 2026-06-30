import { supabase } from "@/integrations/supabase/client";

const API_URL = "/api";

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<{ data: T | null; error: string | null; meta?: any }> {
  const token = await getToken();
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
      const body = await res.json().catch(() => ({}));
      return { data: null, error: body.detail || `Error ${res.status}` };
    }
    const body = await res.json();
    return { data: body.data ?? body, error: body.error ?? null, meta: body.meta };
  } catch (e: any) {
    return { data: null, error: e.message || "Network error" };
  }
}

function get<T = any>(path: string) {
  return request<T>(path);
}

function post<T = any>(path: string, body?: any) {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

function patch<T = any>(path: string, body: any) {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

function del<T = any>(path: string) {
  return request<T>(path, { method: "DELETE" });
}

function getAdminAuthHeader(): Record<string, string> {
  return { "X-Admin-Auth": btoa("qarib:test123") };
}

function adminGet<T = any>(path: string) {
  return request<T>(path, { headers: getAdminAuthHeader() });
}

function adminPost<T = any>(path: string, body?: any) {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: getAdminAuthHeader() });
}

function adminPatch<T = any>(path: string, body: any) {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body), headers: getAdminAuthHeader() });
}

export const api = {
  // Agents
  getAgents: () => get("/agents"),
  createAgent: (data: any) => post("/agents", data),
  updateAgent: (id: string, data: any) => patch(`/agents/${id}`, data),
  deleteAgent: (id: string) => del(`/agents/${id}`),
  syncAgentVapi: (id: string) => post(`/agents/${id}/sync-vapi`),
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

  // Custom Fields
  getCustomFields: () => get("/custom-fields"),
  createCustomField: (data: any) => post("/custom-fields", data),
  updateCustomField: (id: string, data: any) => patch(`/custom-fields/${id}`, data),
  deleteCustomField: (id: string) => del(`/custom-fields/${id}`),

  // Tools
  getTools: () => get("/tools"),
  createTool: (data: any) => post("/tools", data),
  updateTool: (id: string, data: any) => patch(`/tools/${id}`, data),
  deleteTool: (id: string) => del(`/tools/${id}`),
  testTool: (id: string) => post(`/tools/${id}/test`),

  // Conversations
  getConversations: (params?: string) => get(`/conversations${params ? `?${params}` : ""}`),
  getConversation: (id: string) => get(`/conversations/${id}`),
  getConversationTranscript: (id: string) => get(`/conversations/${id}/transcript`),
  getConversationStats: () => get("/conversations/stats"),
  deleteConversation: (id: string) => del(`/conversations/${id}`),

  // Telephony - Phone Numbers
  getPhoneNumbers: () => get("/telephony/phone-numbers"),
  createPhoneNumber: (data: any) => post("/telephony/phone-numbers", data),
  updatePhoneNumber: (id: string, data: any) => patch(`/telephony/phone-numbers/${id}`, data),
  deletePhoneNumber: (id: string) => del(`/telephony/phone-numbers/${id}`),

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
  makeCall: (data: any) => post("/telephony/call", data),

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
  getRuns: (params?: string) => get(`/automation/runs${params ? `?${params}` : ""}`),
  getRunsStats: () => get("/automation/runs/stats"),

  // Team
  getTeam: () => get("/team"),
  getMyRole: () => get("/team/me"),
  inviteTeamMember: (data: any) => post("/team/invite", data),
  updateTeamMember: (id: string, data: any) => patch(`/team/${id}`, data),
  removeTeamMember: (id: string) => del(`/team/${id}`),

  // Profile
  getProfile: () => get("/profile"),
  updateProfile: (data: any) => patch("/profile", data),

  // Billing
  getBillingPlans: () => get("/billing/plans"),
  getBillingStatus: () => get("/billing/status"),
  getBillingUsage: () => get("/billing/usage"),
  getBillingInvoices: () => get("/billing/invoices"),
  createCheckout: (data: any) => post("/billing/checkout", data),
  createPortalSession: () => post("/billing/portal"),

  // Admin
  getAdminStats: () => adminGet("/admin/stats"),
  getAdminUsers: () => adminGet("/admin/users"),
  getAdminUser: (id: string) => adminGet(`/admin/users/${id}`),
  updateAdminUser: (id: string, data: any) => adminPatch(`/admin/users/${id}`, data),
  adjustCredits: (id: string, data: any) => adminPost(`/admin/users/${id}/credits`, data),
  toggleAccess: (id: string) => adminPost(`/admin/users/${id}/toggle-access`),
  resetUsage: (id: string) => adminPost(`/admin/users/${id}/reset-usage`),

  // Health
  getHealth: () => get("/health"),
};
