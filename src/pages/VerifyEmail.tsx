import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { api, setStoredToken } from "@/services/api";
import Logo from "@/components/Logo";

type Status = "verifying" | "success" | "error";

const VerifyEmail = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") || "";
  const [status, setStatus] = useState<Status>("verifying");
  const [message, setMessage] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    // Guard against React 18 StrictMode double-invoke — a verify token is single-use.
    if (ran.current) return;
    ran.current = true;

    if (!token) {
      setStatus("error");
      setMessage("This verification link is missing its token.");
      return;
    }
    api.verifyEmail(token).then(({ data, error }) => {
      if (error || !data?.access_token) {
        setStatus("error");
        setMessage(error || "We couldn't verify your email.");
        return;
      }
      // Verified — log the user straight in.
      setStoredToken(data.access_token);
      setStatus("success");
      setMessage("Your email is verified and your welcome credit has been added.");
      setTimeout(() => {
        window.location.href = "/dashboard";
      }, 1600);
    });
  }, [token]);

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

          <div className="surface-card p-8 text-center">
            {status === "verifying" && (
              <>
                <Loader2 className="mx-auto mb-4 text-primary animate-spin" size={40} />
                <h1 className="text-2xl font-black text-foreground mb-2">Verifying your email…</h1>
                <p className="text-muted-foreground text-sm">Hang tight, this only takes a second.</p>
              </>
            )}

            {status === "success" && (
              <>
                <CheckCircle2 className="mx-auto mb-4 text-primary" size={44} />
                <h1 className="text-2xl font-black text-foreground mb-2">Email verified 🎉</h1>
                <p className="text-muted-foreground text-sm mb-6">{message}</p>
                <p className="text-xs text-muted-foreground">Taking you to your dashboard…</p>
              </>
            )}

            {status === "error" && (
              <>
                <XCircle className="mx-auto mb-4 text-destructive" size={44} />
                <h1 className="text-2xl font-black text-foreground mb-2">Verification failed</h1>
                <p className="text-muted-foreground text-sm mb-6">{message}</p>
                <Button onClick={() => navigate("/register")} className="w-full mb-3">
                  Create a new account
                </Button>
                <Link to="/login" className="text-sm text-primary hover:underline font-medium">
                  Back to Sign In
                </Link>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

export default VerifyEmail;
