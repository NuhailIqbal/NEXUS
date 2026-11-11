/**
 * Referral partner sign-in (/partner/login): the partners' own front door to their console (/partner).
 * It signs in through the same endpoint as the customer login (a partner is an ordinary account an admin linked to a partner
 * row), then asks GET /partner/me whether the account really is a partner. An account that is not one is signed out again
 * with an explanation instead of being dropped into the customer dashboard. A visitor who is already signed in as a partner
 * goes straight to the console.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Eye, EyeOff, Handshake, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/services/api";
import { NOT_A_PARTNER_MESSAGE, PARTNER_HOME, partnerAccess } from "@/lib/partnerPortal";

const PartnerLogin = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, loading: authLoading, signIn, signOut } = useAuth();

  // Already signed in (a returning visitor): a partner goes straight in, anyone else sees the form and why they cannot.
  useEffect(() => {
    if (authLoading || !user || loading) return;
    let live = true;
    api.getPartnerMe().then(({ data }) => {
      if (live && partnerAccess(data) === "partner") navigate(PARTNER_HOME, { replace: true });
    });
    return () => { live = false; };
  }, [authLoading, user, loading, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setProblem(null);
    const { error } = await signIn(email, password);
    if (error) {
      setLoading(false);
      setProblem(error);
      toast({ title: "Sign in failed", description: error, variant: "destructive" });
      return;
    }
    const { data } = await api.getPartnerMe();
    const access = partnerAccess(data);
    if (access === "partner") {
      navigate(PARTNER_HOME, { replace: true });
      return;
    }
    // A valid login that is not a partner must not stay signed in from this page; a failed lookup is reported, not guessed at.
    await signOut();
    setLoading(false);
    setProblem(access === "not-partner" ? NOT_A_PARTNER_MESSAGE : "We could not check your partner access. Please try again.");
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-primary/5 blur-[150px]" />
      <div className="absolute right-4 top-4"><ThemeToggle /></div>

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center"><Logo linked={false} size="lg" /></div>
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <Handshake className="h-3.5 w-3.5" /> Partner Portal
          </div>
          <h1 className="mb-2 text-3xl font-black text-foreground">Partner sign in</h1>
          <p className="text-sm text-muted-foreground">Track your referrals, signups and commission.</p>
        </div>

        <div className="surface-card p-6">
          <form className="space-y-4" onSubmit={handleLogin}>
            <div>
              <label htmlFor="partner-email" className="mb-1.5 block text-sm font-medium text-foreground">Email</label>
              <Input
                id="partner-email" type="email" autoComplete="username" placeholder="you@company.com" required
                value={email} onChange={(e) => setEmail(e.target.value)} className="border-border bg-background"
              />
            </div>
            <div>
              <label htmlFor="partner-password" className="mb-1.5 block text-sm font-medium text-foreground">Password</label>
              <div className="relative">
                <Input
                  id="partner-password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="••••••••" required
                  value={password} onChange={(e) => setPassword(e.target.value)} className="border-border bg-background pr-10"
                />
                <button
                  type="button" onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {problem && (
              <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p>
            )}

            <Button type="submit" disabled={loading} className="w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
              {loading ? <Loader2 size={16} className="animate-spin" /> : null}
              Sign in to the Partner Portal <ArrowRight size={16} />
            </Button>
          </form>

          <div className="mt-6 space-y-2 border-t border-border pt-6 text-center text-sm text-muted-foreground">
            <p>
              Forgot your password? Contact your Nexus partner manager to have it reset.
            </p>
            <p>
              Looking for the customer dashboard?{" "}
              <Link to="/login" className="font-medium text-primary hover:underline">Customer sign in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PartnerLogin;
