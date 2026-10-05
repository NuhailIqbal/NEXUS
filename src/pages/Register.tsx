/**
 * Sign-up page, routed at /register (see App.tsx; linked from the Navbar and marketing CTAs).
 * Creates an UNVERIFIED account through AuthContext.signUp (POST /auth/register), then swaps the
 * form for a "check your email" screen; there is no session until the emailed link is opened
 * (see VerifyEmail). Optionally gates sign-up behind a reCAPTCHA v2 checkbox and forwards a
 * ?ref=CODE referral code. The screen can re-request the link via api.resendVerification.
 */
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Loader2, MailCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/services/api";
import Logo from "@/components/Logo";

// Public site key only — safe to ship in the frontend bundle. Blank in an environment that
// hasn't set one up yet, in which case the widget is simply not rendered and sign-up proceeds
// without a captcha (mirrors the backend, which skips verification when its secret key is unset).
// v2 "I'm not a robot" checkbox — visible widget, single click, reusable-until-submit response.
const RECAPTCHA_SITE_KEY = ((import.meta as any).env?.VITE_RECAPTCHA_SITE_KEY ?? "").trim();

// Ambient typings for the parts of Google's reCAPTCHA script API used here, plus the global
// onload callback whose name is passed in the script URL below.
declare global {
  interface Window {
    grecaptcha?: {
      render: (container: HTMLElement, params: { sitekey: string }) => number;
      getResponse: (widgetId?: number) => string;
      reset: (widgetId?: number) => void;
    };
    __onRecaptchaLoad?: () => void;
  }
}

/**
 * Registration form and the post-registration "check your email" screen.
 *
 * Local state: the form fields, `loading` during sign-up, `submitted` (switches to the
 * confirmation screen), `devVerifyUrl` (fallback verification link shown when the backend could
 * not send the email) and `resending`.
 * Notes: `companyName` is collected in the form but is not passed to signUp or the backend. The
 * 6-character password minimum is enforced only by the browser's native form validation here.
 */
const Register = () => {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [devVerifyUrl, setDevVerifyUrl] = useState<string | undefined>(undefined);
  const [resending, setResending] = useState(false);
  const { toast } = useToast();
  const { signUp } = useAuth();
  const [searchParams] = useSearchParams();
  // Optional ?ref=CODE from a referral link (built on the Referrals dashboard page); passed to
  // signUp so the backend can record the referral.
  const referralCode = searchParams.get("ref") ?? undefined;

  // The div the reCAPTCHA widget renders into, and the widget id Google returns from render();
  // that id is needed to read or reset this specific widget.
  const recaptchaContainerRef = useRef<HTMLDivElement>(null);
  const recaptchaWidgetId = useRef<number | null>(null);

  // Loads Google's reCAPTCHA script (once per page) and renders the checkbox into the container.
  // Does nothing when no site key is configured. The script tag is left in the document on
  // unmount so later visits reuse it; the onload callback is reassigned on every mount so it
  // always targets the currently mounted container.
  useEffect(() => {
    if (!RECAPTCHA_SITE_KEY) return;

    /** Renders the widget at most once per mount; a no-op until the container and Google's render() both exist. */
    const renderWidget = () => {
      if (recaptchaWidgetId.current !== null) return; // already rendered (e.g. effect re-ran)
      if (!recaptchaContainerRef.current || !window.grecaptcha?.render) return;
      recaptchaWidgetId.current = window.grecaptcha.render(recaptchaContainerRef.current, {
        sitekey: RECAPTCHA_SITE_KEY,
      });
    };

    // Google's script fires its own `load` event as soon as the file downloads — but
    // grecaptcha.render isn't attached yet at that point, it finishes initializing itself
    // asynchronously afterward. `render=explicit&onload=<name>` makes Google call our named
    // global callback only once it's genuinely ready, which is the documented, race-free way
    // to know when render() is actually safe to call.
    if (window.grecaptcha?.render) {
      renderWidget();
      return;
    }

    window.__onRecaptchaLoad = renderWidget;

    if (document.getElementById("recaptcha-script")) return; // script already requested

    const script = document.createElement("script");
    script.id = "recaptcha-script";
    script.src = "https://www.google.com/recaptcha/api.js?onload=__onRecaptchaLoad&render=explicit";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
  }, []);

  /**
   * Form submit handler. Checks the required fields and the reCAPTCHA response client-side, then
   * calls signUp (POST /auth/register). On success it shows the confirmation screen; on failure
   * it shows the error in a toast and resets the captcha.
   */
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName || !email || !password) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return;
    }
    // getResponse() returns an empty string until the checkbox is ticked. With no site key
    // configured no token is sent, and the backend skips the captcha check as well.
    const recaptchaToken = RECAPTCHA_SITE_KEY
      ? window.grecaptcha?.getResponse(recaptchaWidgetId.current ?? undefined)
      : undefined;
    if (RECAPTCHA_SITE_KEY && !recaptchaToken) {
      toast({ title: "Please complete the reCAPTCHA", variant: "destructive" });
      return;
    }
    setLoading(true);
    // signUp resolves with an error string, or with pending: true on success. The destructured
    // devVerifyUrl shadows the state value of the same name; it is the fallback link returned
    // when the verification email could not be sent.
    const { error, pending, devVerifyUrl } = await signUp(email, password, fullName, recaptchaToken, referralCode);
    setLoading(false);
    if (error) {
      toast({ title: "Registration failed", description: error, variant: "destructive" });
      // A reCAPTCHA response token can be verified only once, so the widget is reset to make the
      // user solve a fresh challenge before retrying.
      window.grecaptcha?.reset(recaptchaWidgetId.current ?? undefined);
    } else if (pending) {
      // The account exists but is unverified and no session was created, so show the
      // check-your-email screen instead of redirecting.
      setDevVerifyUrl(devVerifyUrl);
      setSubmitted(true);
    }
  };

  /**
   * "Resend verification email" on the confirmation screen (POST /auth/resend-verification).
   * The page origin is sent so the emailed link points at this deployment. If the backend returns
   * a `dev_verify_url` it replaces the fallback link shown on screen; `email_sent === false`
   * means delivery failed and triggers the error toast. The response's `error` is not inspected.
   */
  const handleResend = async () => {
    setResending(true);
    const { data } = await api.resendVerification(email, window.location.origin);
    setResending(false);
    if (data?.dev_verify_url) setDevVerifyUrl(data.dev_verify_url);
    if (data?.email_sent === false) {
      toast({
        title: "Email could not be sent",
        description: "SMTP is not configured. Use the dev verification link below.",
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Verification email sent", description: `We re-sent the link to ${email}.` });
  };

  // Registration succeeded: this screen replaces the form until the user leaves the page.
  if (submitted) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden">
          <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />
          <div className="w-full max-w-md mx-auto px-4 relative z-10">
            <div className="surface-card p-8 text-center">
              <div className="flex justify-center mb-4">
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                  <MailCheck className="text-primary" size={28} />
                </div>
              </div>
              <h1 className="text-2xl font-black text-foreground mb-2">Check your email</h1>
              <p className="text-muted-foreground text-sm mb-6">
                We sent a verification link to <span className="text-foreground font-medium">{email}</span>.
                Click it to activate your account and unlock your welcome credit. You won't be able to
                log in until your email is verified.
              </p>

              {devVerifyUrl && (
                <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-left">
                  <p className="text-xs text-amber-500 font-medium mb-1">Email could not be sent. Use this link instead</p>
                  <a href={devVerifyUrl} className="text-xs text-primary break-all hover:underline">
                    {devVerifyUrl}
                  </a>
                </div>
              )}

              <Button
                variant="outline"
                onClick={handleResend}
                disabled={resending}
                className="w-full gap-2 mb-3"
              >
                {resending ? <Loader2 size={16} className="animate-spin" /> : null}
                Resend verification email
              </Button>
              <Link to="/login" className="text-sm text-primary hover:underline font-medium">
                Back to Sign In
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

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
            <h1 className="text-3xl font-black text-foreground mb-2">Create Account</h1>
            <p className="text-muted-foreground text-sm">Join EDM Nexus and start growing</p>
          </div>

          <div className="surface-card p-6">
            <form className="space-y-4" onSubmit={handleRegister}>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">Full Name *</label>
                <Input
                  type="text"
                  placeholder="John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="bg-background border-border"
                  required
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">Company Name</label>
                <Input
                  type="text"
                  placeholder="Acme Inc."
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="bg-background border-border"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">Email *</label>
                <Input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-background border-border"
                  required
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">Password *</label>
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
              {RECAPTCHA_SITE_KEY && (
                <div ref={recaptchaContainerRef} className="flex justify-center" />
              )}
              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                Create Account <ArrowRight size={16} />
              </Button>
            </form>

            <div className="mt-6 pt-6 border-t border-border text-center">
              <p className="text-sm text-muted-foreground">
                Already have an account?{" "}
                <Link to="/login" className="text-primary hover:underline font-medium">
                  Sign In
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Register;
