import { useEffect, useState } from "react";
import { Bell, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/services/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const SEEN_KEY = "nexus_notifs_seen";

type Conv = {
  id: string;
  contact_name?: string;
  phone?: string;
  status?: string;
  call_time?: string;
  direction?: string;
};

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
 * Notification bell — surfaces the most recent call activity (from the
 * conversations endpoint) in a popover. The unread badge counts items newer
 * than the last time the bell was opened (persisted in localStorage).
 */
const NotificationBell = () => {
  const [items, setItems] = useState<Conv[]>([]);
  const [lastSeen, setLastSeen] = useState<number>(
    () => Number(localStorage.getItem(SEEN_KEY)) || 0,
  );
  const navigate = useNavigate();

  const load = async () => {
    const res = await api.getConversations();
    const list: Conv[] = Array.isArray(res.data) ? res.data : [];
    list.sort(
      (a, b) =>
        new Date(b.call_time || 0).getTime() - new Date(a.call_time || 0).getTime(),
    );
    setItems(list.slice(0, 8));
  };

  useEffect(() => {
    load();
  }, []);

  const unread = items.filter(
    (i) => i.call_time && new Date(i.call_time).getTime() > lastSeen,
  ).length;

  const markSeen = () => {
    const now = Date.now();
    localStorage.setItem(SEEN_KEY, String(now));
    setLastSeen(now);
  };

  const goToConversations = () => navigate("/dashboard/conversations");

  return (
    <Popover onOpenChange={(open) => open && load()}>
      <PopoverTrigger asChild>
        <button
          className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Notifications"
          onClick={markSeen}
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          {items.length > 0 && (
            <button
              onClick={goToConversations}
              className="text-xs font-medium text-primary hover:underline"
            >
              View all
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Bell className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">You&apos;re all caught up</p>
            <p className="text-xs text-muted-foreground/70">No new notifications</p>
          </div>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {items.map((i) => {
              const inbound = (i.direction || "").toLowerCase() === "inbound";
              const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
              return (
                <li key={i.id}>
                  <button
                    onClick={goToConversations}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className="mt-0.5 rounded-full bg-primary/10 p-1.5 text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {inbound ? "Inbound" : "Outbound"} call — {i.contact_name || i.phone || "Unknown"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {i.status || "—"} · {timeAgo(i.call_time)}
                      </span>
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
