/**
 * Header bell with an unread badge and a popover listing notifications and recent calls. Rendered
 * in the DashboardLayout top bar. Uses GET /notifications, POST /notifications/read and
 * GET /conversations. Every notification row links to /dashboard/billing whatever its kind, and
 * every call row links to /dashboard/conversations.
 */
import { useEffect, useState } from "react";
import { Bell, PhoneIncoming, PhoneOutgoing, AlertTriangle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/services/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** A row from GET /notifications. `kind` is returned by the API but not used by the bell. */
type Notif = { id: string; kind: string; title: string; body?: string; read?: boolean; created_at?: string };
/** The subset of a GET /conversations row needed for the "Recent calls" section. */
type Conv = { id: string; contact_name?: string; phone?: string; status?: string; call_time?: string; direction?: string };

/** Coarse relative time for an ISO timestamp ("just now", "5m ago", "3h ago", "2d ago"); "" if missing or unparseable. */
function timeAgo(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Notification bell — shows real notifications (e.g. low-balance alerts, DB-backed)
 * plus recent call activity. The unread badge counts unread notifications.
 */
const NotificationBell = () => {
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [calls, setCalls] = useState<Conv[]>([]);
  const navigate = useNavigate();

  /**
   * Fetches notifications and the latest conversations in parallel and replaces the local state.
   * Runs on mount, every 30s and whenever the popover opens. api.* resolves with `data: null` on
   * failure rather than throwing, so a failed fetch empties the matching list (and, for
   * notifications, resets the badge to 0).
   */
  const load = async () => {
    const [nRes, cRes] = await Promise.all([api.getNotifications(), api.getConversations()]);
    const nd = (nRes.data as any) || {};
    setNotifs(Array.isArray(nd.notifications) ? nd.notifications : []);
    setUnread(nd.unread ?? 0);
    const list: Conv[] = Array.isArray(cRes.data) ? cRes.data : [];
    // Newest call first (rows without a call_time sort last), then keep only the six latest.
    list.sort((a, b) => new Date(b.call_time || 0).getTime() - new Date(a.call_time || 0).getTime());
    setCalls(list.slice(0, 6));
  };

  // Initial fetch plus 30s polling for as long as the bell is mounted.
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  /**
   * Popover open/close handler; only the open transition does anything. It refreshes the data and,
   * if the badge shows unread items, marks all of the account's notifications read on the server
   * (POST /notifications/read with no id) and zeroes the badge once that request resolves. The rows
   * keep their unread highlight until the next refresh, so the user can still see what was new.
   */
  const onOpen = (open: boolean) => {
    if (!open) return;
    load();
    if (unread > 0) {
      api.markNotificationsRead().then(() => setUnread(0));
    }
  };

  return (
    <Popover onOpenChange={onOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="ml-4 w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] p-0 sm:w-80">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          <button onClick={() => navigate("/dashboard/billing")} className="text-xs font-medium text-primary hover:underline">
            Billing
          </button>
        </div>

        {notifs.length === 0 && calls.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Bell className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">You&apos;re all caught up</p>
          </div>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {notifs.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => navigate("/dashboard/billing")}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${n.read ? "" : "bg-primary/5"}`}
                >
                  <span className="mt-0.5 rounded-full bg-yellow-500/15 p-1.5 text-yellow-500">
                    <AlertTriangle className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{n.title}</span>
                    {n.body && <span className="block text-xs text-muted-foreground">{n.body}</span>}
                    <span className="text-[11px] text-muted-foreground/70">{timeAgo(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
            {calls.length > 0 && (
              <li className="border-t border-border px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Recent calls
              </li>
            )}
            {calls.map((i) => {
              const inbound = (i.direction || "").toLowerCase() === "inbound";
              const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
              return (
                <li key={i.id}>
                  <button
                    onClick={() => navigate("/dashboard/conversations")}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className="mt-0.5 rounded-full bg-primary/10 p-1.5 text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {inbound ? "Inbound" : "Outbound"} call: {i.contact_name || i.phone || "Unknown"}
                      </span>
                      <span className="text-xs text-muted-foreground">{i.status || "—"} · {timeAgo(i.call_time)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default NotificationBell;
