import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, CalendarDays, CheckCircle2, Loader2, Settings as SettingsIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/services/api";
import { startGoogleConnect } from "./calendarConnect";
import { CalendarSettingsDialog } from "./CalendarSettingsDialog";
import { IntegrationTile } from "./IntegrationTile";
import { hoursSummary, type CalendarSettings, type CalendarStatus } from "./calendarTypes";

/** Where Google sends people back to us: /dashboard/integrations?calendar=<result>[&reason=..] */
const RETURN_MESSAGES: Record<string, { kind: "success" | "error"; text: string }> = {
  connected: { kind: "success", text: "Google Calendar connected" },
  denied: { kind: "error", text: "Calendar connection was cancelled — nothing was changed." },
};
const REASON_TEXT: Record<string, string> = {
  state: "That connection link expired. Please try connecting again.",
  no_refresh: "Google didn't grant lasting access. Remove NEXUS from your Google account's connected apps, then connect again.",
  reauth: "Google rejected the connection. Please try again.",
};

export function GoogleCalendarCard() {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [params, setParams] = useSearchParams();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [s, role] = await Promise.all([api.getCalendarStatus(), api.getMyRole()]);
    if (s.error || !s.data) setError(s.error || "Couldn't load the calendar status.");
    else setStatus(s.data as CalendarStatus);
    setIsOwner((role.data as { is_owner?: boolean } | null)?.is_owner ?? true);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Report the outcome of the Google round-trip once, then clean the address bar.
  useEffect(() => {
    const result = params.get("calendar");
    if (!result) return;
    const known = RETURN_MESSAGES[result];
    if (known) (known.kind === "success" ? toast.success : toast.error)(known.text);
    else toast.error(REASON_TEXT[params.get("reason") ?? ""] ?? "Couldn't connect Google Calendar. Please try again.");
    const next = new URLSearchParams(params);
    next.delete("calendar");
    next.delete("reason");
    setParams(next, { replace: true });
  }, [params, setParams]);

  const connect = async () => {
    setConnecting(true);
    const err = await startGoogleConnect();   // on success the browser leaves for Google
    if (err) {
      setConnecting(false);
      toast.error(err);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    const { error: err } = await api.disconnectCalendar();
    setDisconnecting(false);
    setConfirmDisconnect(false);
    if (err) { toast.error(err); return; }
    toast.success("Google Calendar disconnected");
    load();
  };

  // Like every other integration, this only shows up once it has been added (Add Integration -> Google Calendar).
  if ((loading && !status) || (status && !status.connected && !error)) return null;

  const needsReconnect = !!status && status.status === "reauth_required";

  const badge = !loading && !error && status && (
    needsReconnect ? (
      <Badge variant="outline" className="shrink-0 gap-1 border-warning/40 bg-warning/10 text-warning">
        <AlertTriangle className="h-3 w-3" /> Needs to be reconnected
      </Badge>
    ) : (
      <Badge variant="outline" className="shrink-0 gap-1 border-success/40 bg-success/10 text-success">
        <CheckCircle2 className="h-3 w-3" /> Connected
      </Badge>
    )
  );

  const actions = !loading && !error && status && isOwner && (
    <>
      {needsReconnect && <Button size="sm" onClick={connect} disabled={connecting}>Reconnect</Button>}
      <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
        <SettingsIcon className="mr-1.5 h-4 w-4" /> Settings
      </Button>
      <Button size="sm" variant="outline" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
    </>
  );

  return (
    <>
      <IntegrationTile icon={CalendarDays} title="Google Calendar" badge={badge} actions={actions}>
        {loading ? (
          <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : error || !status ? (
          <div className="space-y-2">
            <p role="alert" className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </div>
        ) : (
          <>
            {status.email && <p>as {status.email}</p>}
            {needsReconnect && (
              <p>
                Google stopped accepting this connection, so agents can't book right now. Reconnect to fix it —
                your settings are kept.
              </p>
            )}
            <p>Bookable: {hoursSummary(status.settings)}</p>
            {!isOwner && <p className="text-xs">Only the account owner can change calendar settings.</p>}
          </>
        )}
      </IntegrationTile>

      {status && (
        <CalendarSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={status.settings}
          onSaved={(s: CalendarSettings) => setStatus((prev) => (prev ? { ...prev, settings: s } : prev))} />
      )}

      <AlertDialog open={confirmDisconnect} onOpenChange={(o) => !o && !disconnecting && setConfirmDisconnect(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents will no longer be able to check availability or book meetings. Meetings already booked stay in
              your calendar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); disconnect(); }} disabled={disconnecting}>
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
