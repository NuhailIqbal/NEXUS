import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Loader2, MailCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/services/api";
import Logo from "@/components/Logo";

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

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName || !email || !password) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return;
    }
    setLoading(true);
    const { error, pending, devVerifyUrl } = await signUp(email, password, fullName);
    setLoading(false);
    if (error) {
      toast({ title: "Registration failed", description: error, variant: "destructive" });
    } else if (pending) {
      setDevVerifyUrl(devVerifyUrl);
      setSubmitted(true);
    }
  };

  const handleResend = async () => {
    setResending(true);
    const { data } = await api.resendVerification(email, window.location.origin);
    setResending(false);
    if (data?.dev_verify_url) setDevVerifyUrl(data.dev_verify_url);
    toast({ title: "Verification email sent", description: `We re-sent the link to ${email}.` });
  };

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
                  <p className="text-xs text-amber-500 font-medium mb-1">Dev mode — no email configured</p>
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
