/**
 * What the partner's own screens (the portal, the user list, a user's page) need besides their data: whether the account is
 * an active partner (a paused one keeps reading its users but "View as" is off), and the "View as" action itself, which
 * opens the referred user's account in the same tab through the 2-hour impersonation token (lib/impersonation.ts).
 * An account that is not a partner at all is sent back to the dashboard.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/services/api";
import { startPartnerImpersonation } from "@/lib/impersonation";

export function usePartnerPortal() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"active" | "paused" | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getPartnerMe().then(({ data }) => {
      if (!live) return;
      if (data?.is_partner) setStatus(data.partner?.status === "paused" ? "paused" : "active");
      else if (data) navigate("/dashboard", { replace: true });       // answered, and not a partner: nothing to show here
    });
    return () => { live = false; };
  }, [navigate]);

  const viewAs = useCallback(async (userId: string, email: string) => {
    setViewing(userId);
    const { data, error } = await api.partnerImpersonateUser(userId);
    if (error || !data?.access_token) {
      setViewing(null);
      toast.error(error || "Could not open that account");
      return;
    }
    startPartnerImpersonation(data.access_token, email);
  }, []);

  /** True when "View as" may be used right now. */
  const canViewAs = status === "active" && viewing === null;
  return { status, viewing, viewAs, canViewAs };
}
