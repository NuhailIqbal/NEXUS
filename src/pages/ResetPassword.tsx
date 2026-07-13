import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import Logo from "@/components/Logo";
import { api } from "@/services/api";

const ResetPassword = () => {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (t) setToken(t);
  }, []);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    // Email-link password reset is not available yet; direct users to support.
    toast({
      title: "Password reset unavailable",
      description: "Please contact your administrator to reset your password.",
    });
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <section className="min-h-screen flex items-center justify-center pt-16">
          <p className="text-muted-foreground">Invalid or expired reset link.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden">
        <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
        <div className="w-full max-w-md mx-auto px-4 relative z-10">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <Logo linked={false} size="lg" />
            </div>
            <h1 className="text-3xl font-black text-foreground mb-2">Set New Password</h1>
          </div>
          <div className="surface-card p-6">
            <form className="space-y-4" onSubmit={handleReset}>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">New Password</label>
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
              <Button type="submit" disabled={loading} className="w-full bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
                {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                Update Password <ArrowRight size={16} />
              </Button>
            </form>
          </div>
        </div>
      </section>
    </div>
  );
};

export default ResetPassword;
