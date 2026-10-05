/**
 * Team-invite acceptance page, routed at /accept-invite?token=... (see App.tsx). The link is
 * emailed by the backend when an account owner invites a new email address (POST /team/invite).
 * Looks up the invite with api.getInvite (GET /team/invite/{token}, public) to show who invited
 * whom, then creates the invitee's account with api.acceptInvite (POST /team/accept-invite).
 * The returned JWT is stored and the user is sent to /dashboard.
 */
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { api, setStoredToken } from "@/services/api";
import Logo from "@/components/Logo";

/** Response of GET /team/invite/{token}: the invited email, the role offered, and the inviting owner's display name. */
type InviteInfo = { email: string; role: string; owner_name: string };

/**
 * Invite landing page with three mutually exclusive views, derived from state: an error panel
 * (`loadError` set), a loading spinner (no error and `invite` not loaded yet), or the
 * set-a-password form (`invite` loaded).
 * The invited email and role are fixed by the invite; the user supplies only an optional full
 * name and a password.
 */
const AcceptInvite = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const token = params.get("token") || "";

  const [loadError, setLoadError] = useState("");
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Fetches the invite details for the token in the URL. The backend answers with an error for
  // unknown, already-used and expired invites, which is shown as-is in the error panel.
  useEffect(() => {
    if (!token) {
      setLoadError("This invite link is missing its token.");
      return;
    }
    api.getInvite(token).then(({ data, error }) => {
      if (error || !data) {
        setLoadError(error || "This invite link is invalid or has expired.");
        return;
      }
      setInvite(data);
    });
  }, [token]);

  /**
   * Form submit handler: redeems the invite via api.acceptInvite, which creates the account
   * (already email-verified, since the invite email served as verification) and links it to the
   * inviting team. On success it stores the returned JWT and goes to /dashboard; on failure it
   * shows the backend's error in a toast and leaves the form in place.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    // An empty name becomes undefined so the field is omitted from the request body.
    const { data, error } = await api.acceptInvite({ token, password, full_name: fullName || undefined });
    setSubmitting(false);
    if (error || !data?.access_token) {
      toast({ title: "Couldn't accept invite", description: error || "Something went wrong.", variant: "destructive" });
      return;
    }
    setStoredToken(data.access_token);
    toast({ title: "Welcome aboard!", description: "Your account is set up." });
    // Full page load rather than navigate(): AuthProvider only reads the stored token on mount,
    // so a reload is what makes it pick up the new session.
    window.location.href = "/dashboard";
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden">
        <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />
        <div className="w-full max-w-md mx-auto px-4 relative z-10">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <Logo linked={false} size="lg" />
            </div>
          </div>

          <div className="surface-card p-8">
            {loadError && (
              <div className="text-center">
                <XCircle className="mx-auto mb-4 text-destructive" size={44} />
                <h1 className="text-2xl font-black text-foreground mb-2">Invite not available</h1>
                <p className="text-muted-foreground text-sm mb-6">{loadError}</p>
                <Link to="/login" className="text-sm text-primary hover:underline font-medium">
                  Back to Sign In
                </Link>
              </div>
            )}

            {!loadError && !invite && (
              <div className="text-center">
                <Loader2 className="mx-auto mb-4 text-primary animate-spin" size={40} />
                <p className="text-muted-foreground text-sm">Loading your invite…</p>
              </div>
            )}

            {!loadError && invite && (
              <>
                <div className="text-center mb-6">
                  <h1 className="text-2xl font-black text-foreground mb-2">You're invited!</h1>
                  <p className="text-muted-foreground text-sm">
                    <b>{invite.owner_name}</b> invited <b>{invite.email}</b> to join their team as a{" "}
                    <span className="capitalize">{invite.role}</span>. Set a password to finish joining.
                  </p>
                </div>
                <form className="space-y-4" onSubmit={handleSubmit}>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Full name</label>
                    <Input
                      type="text"
                      placeholder="Jane Doe"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="bg-background border-border"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Password</label>
                    <Input
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="bg-background border-border"
                      minLength={6}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={submitting} className="w-full bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
                    {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
                    Accept invite & continue <ArrowRight size={16} />
                  </Button>
                </form>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

export default AcceptInvite;
