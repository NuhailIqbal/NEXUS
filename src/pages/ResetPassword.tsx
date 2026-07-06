import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, ArrowRight, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
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
    if (!token) return;
    setLoading(true);
    const { error } = await api.resetPassword(token, password);
    setLoading(false);
    if (error) {
      toast({ title: "Error", description: error, variant: "destructive" });
    } else {
      toast({ title: "Password updated", description: "You can now sign in with your new password." });
      navigate("/login");
    }
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
            <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
              <Sparkles size={24} className="text-primary" />
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
