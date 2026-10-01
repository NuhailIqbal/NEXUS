import { useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CalendarStatus } from "./calendarTypes";

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <li className="flex gap-3">
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{n}</span>
    <div className="min-w-0 flex-1 text-sm text-foreground">{children}</div>
  </li>
);

const Ext = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer"
    className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:opacity-80">
    {children} <ExternalLink className="h-3 w-3" />
  </a>
);

function CopyBox({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the text is still selectable */ }
  };
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <code aria-label={label} className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">{value}</code>
      <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

/**
 * The "how do I connect Google Calendar" content shown inside Add Integration. What it says
 * depends on the situation: server not set up yet, ready to connect, already connected,
 * or the viewer isn't the account owner.
 */
export function CalendarConnectSteps({
  status, loading, error, isOwner, onRetry,
}: {
  status: CalendarStatus | null;
  loading: boolean;
  error: string | null;
  isOwner: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking calendar setup…</div>;
  }
  if (error || !status) {
    return (
      <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p className="text-destructive">{error || "Couldn't load the calendar setup."}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button>
      </div>
    );
  }

  if (status.connected) {
    const broken = status.status === "reauth_required";
    return (
      <div className="space-y-2 text-sm">
        {broken ? (
          <p className="flex items-center gap-2 font-medium text-warning"><AlertTriangle className="h-4 w-4" /> Your calendar needs to be reconnected</p>
        ) : (
          <p className="flex items-center gap-2 font-medium text-success"><CheckCircle2 className="h-4 w-4" /> Google Calendar is already connected{status.email ? ` as ${status.email}` : ""}</p>
        )}
        <p className="text-muted-foreground">
          {broken
            ? "Google stopped accepting the connection. Reconnect below — your working hours and settings are kept."
            : "Change its working hours or disconnect it from the Calendar section on this page."}
        </p>
      </div>
    );
  }

  if (!isOwner) {
    return <p className="text-sm text-muted-foreground">Only the account owner can connect a calendar. Ask them to add it from this page.</p>;
  }

  if (!status.configured) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-warning" /> One-time setup needed first</p>
          <p className="mt-1 text-muted-foreground">
            Google needs to know about NEXUS before anyone can connect a calendar. Whoever runs the server does
            this once; after that, connecting is one click.
          </p>
        </div>
        <ol className="space-y-3">
          <Step n={1}>Open <Ext href="https://console.cloud.google.com/projectcreate">Google Cloud Console</Ext> and create a project (or pick one).</Step>
          <Step n={2}>Turn on the <Ext href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Google Calendar API</Ext> for that project.</Step>
          <Step n={3}>
            Go to <Ext href="https://console.cloud.google.com/apis/credentials/consent">OAuth consent screen</Ext>, choose <b>External</b>,
            and add these two scopes: <code className="text-xs">calendar.events</code> and <code className="text-xs">calendar.freebusy</code>.
            While testing, add each person who will connect as a <b>Test user</b>.
          </Step>
          <Step n={4}>
            Go to <Ext href="https://console.cloud.google.com/apis/credentials">Credentials</Ext> → <b>Create credentials → OAuth client ID</b> → <b>Web application</b>,
            and add this as an <b>Authorized redirect URI</b>:
            <CopyBox value={status.redirect_uri} label="redirect URI" />
          </Step>
          <Step n={5}>
            Copy the <b>Client ID</b> and <b>Client secret</b> into the server settings as{" "}
            <code className="text-xs">GOOGLE_CLIENT_ID</code> and <code className="text-xs">GOOGLE_CLIENT_SECRET</code>, then restart the server.
            Come back here and choose Google Calendar again.
          </Step>
        </ol>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Let your AI agents check your free times and book meetings straight into your Google Calendar, while the
        caller is still on the line.
      </p>
      <ol className="space-y-3">
        <Step n={1}>Click <b>Connect with Google</b> below.</Step>
        <Step n={2}>
          Choose your Google account and allow access. NEXUS can only see <b>when you're busy</b> and add new meetings —
          it never reads your event titles or details.
        </Step>
        <Step n={3}>
          You'll land back here. Set your working hours with <b>Settings</b>, then tick <b>Check Availability</b> and{" "}
          <b>Book Calendar Slot</b> under <b>Agent tools</b> when you edit an agent.
        </Step>
      </ol>
    </div>
  );
}
