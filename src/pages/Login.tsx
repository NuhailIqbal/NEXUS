import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Loader2, Eye, EyeOff } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAuth, storeAuthData } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import { api } from "@/services/api";

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resending, setResending] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, signIn } = useAuth();

  useEffect(() => {
    if (user) navigate("/dashboard");
  }, [user, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setNeedsVerify(false);
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) {
      // Backend returns a "verify your email" 403 for unverified accounts.
      if (/verify your email/i.test(error)) setNeedsVerify(true);
      toast({ title: "Sign in failed", description: error, variant: "destructive" });
    } else {
      navigate("/dashboard");
    }
  };

  const handleResend = async () => {
    setResending(true);
    const { data } = await api.resendVerification(email, window.location.origin);
    setResending(false);
    if (data?.email_sent === false && data?.dev_verify_url) {
      toast({
        title: "Email could not be sent",
        description: `Dev link: ${data.dev_verify_url}`,
        variant: "destructive",
      });
      return;
    }
    toast({
      title: "Verification email sent",
      description: `We sent a fresh link to ${email}.`,
    });
  };

  const handleForgotPassword = async () => {
    toast({
      title: "Password reset",
      description: "Please contact your administrator to reset your password.",
    });
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
            <h1 className="text-3xl font-black text-foreground mb-2">Welcome Back</h1>
            <p className="text-muted-foreground text-sm">Sign in to your EDM Nexus dashboard</p>
          </div>

          <div className="surface-card p-6">
            <form className="space-y-4" onSubmit={handleLogin}>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">Email</label>
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
                <label className="text-sm font-medium text-foreground mb-1.5 block">Password</label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="bg-background border-border pr-10"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-end text-sm">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  className="text-primary hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                Sign In <ArrowRight size={16} />
              </Button>
            </form>

            {needsVerify && (
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-center">
                <p className="text-xs text-muted-foreground mb-2">
                  Your email isn't verified yet. Check your inbox, or resend the link.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleResend}
                  disabled={resending}
                  className="gap-2"
                >
                  {resending ? <Loader2 size={14} className="animate-spin" /> : null}
                  Resend verification email
                </Button>
              </div>
            )}

            <div className="mt-6 pt-6 border-t border-border text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                Don't have an account?{" "}
                <Link to="/register" className="text-primary hover:underline font-medium">
                  Create Account
                </Link>
              </p>
              <p className="text-sm text-muted-foreground">
                <Link to="/request-access" className="text-primary hover:underline font-medium">
                  Request Access
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Login;
