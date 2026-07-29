import { useRef, useState } from "react";
import { Mic, Star, Play, Pause, Trash2, AlertTriangle } from "lucide-react";
import Vapi from "@vapi-ai/web";
// Vapi's own built-in voice provider (provider="vapi") — the exact voices available
// on the Vapi platform, verified live against Vapi's API. No third-party voice
// provider key required. Source: https://docs.vapi.ai/providers/voice/vapi-voices
const VOICES_CATALOG = [
  { id: 1, name: "Elliot", language: "English", accent: "Canadian", gender: "Male", description: "Realistic, friendly, professional, soothing", favorite: false },
  { id: 2, name: "Savannah", language: "English", accent: "American (Southern)", gender: "Female", description: "Realistic, straightforward", favorite: false },
  { id: 3, name: "Rohan", language: "English", accent: "Indian American", gender: "Male", description: "Realistic, bright, energetic", favorite: false },
  { id: 4, name: "Emma", language: "English", accent: "Asian American", gender: "Female", description: "Realistic, warm, conversational", favorite: false },
  { id: 5, name: "Clara", language: "English", accent: "American", gender: "Female", description: "Realistic, warm, professional", favorite: false },
  { id: 6, name: "Nico", language: "English", accent: "American", gender: "Male", description: "Realistic, young, casual, natural", favorite: false },
  { id: 7, name: "Kai", language: "English", accent: "American", gender: "Male", description: "Realistic, friendly, relaxed, approachable", favorite: false },
  { id: 8, name: "Sagar", language: "English", accent: "Indian American", gender: "Male", description: "Realistic, steady, professional", favorite: false },
  { id: 9, name: "Godfrey", language: "English", accent: "American", gender: "Male", description: "Realistic, young, energetic", favorite: false },
  { id: 10, name: "Neil", language: "English", accent: "Indian American", gender: "Male", description: "Realistic, clear, professional", favorite: false },
  { id: 11, name: "Layla", language: "English", accent: "American", gender: "Female", description: "Realistic, warm, bright, cheerful", favorite: false },
  { id: 12, name: "Sid", language: "English", accent: "American", gender: "Male", description: "Realistic, laid-back, smooth, deep-toned", favorite: false },
  { id: 13, name: "Naina", language: "English", accent: "Indian American", gender: "Female", description: "Realistic, calm, collected, professional", favorite: false },
];
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Voice = {
  id: string;
  name: string;
  language: string;
  accent: string;
  gender: string;
  category?: string;
  description?: string;
  favorite?: boolean;
};

// Mirrors backend/services/vapi_client.py's _VAPI_VOICE_IDS — keep these two in sync.
// Bare names confirmed valid directly against Vapi's live API; do not add a " New"
// suffix or a "version" field on the strength of Vapi's docs site alone (it does not
// reliably match the live API — verify any future change with a real API call).
const VAPI_VOICE_IDS: Record<string, { voiceId: string }> = {
  elliot: { voiceId: "Elliot" },
  savannah: { voiceId: "Savannah" },
  rohan: { voiceId: "Rohan" },
  emma: { voiceId: "Emma" },
  clara: { voiceId: "Clara" },
  nico: { voiceId: "Nico" },
  kai: { voiceId: "Kai" },
  sagar: { voiceId: "Sagar" },
  godfrey: { voiceId: "Godfrey" },
  neil: { voiceId: "Neil" },
  layla: { voiceId: "Layla" },
  sid: { voiceId: "Sid" },
  naina: { voiceId: "Naina" },
};

const VAPI_PUBLIC_KEY = ((import.meta as any).env?.VITE_VAPI_PUBLIC_KEY ?? "").trim();

const AIVoices = () => {
  const [favoriteMockIds, setFavoriteMockIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(window.localStorage.getItem("favorite:voices") ?? "[]");
    } catch {
      return [];
    }
  });
  const [hiddenMockIds, setHiddenMockIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(window.localStorage.getItem("hidden:voices") ?? "[]");
    } catch {
      return [];
    }
  });

  const [previewVoice, setPreviewVoice] = useState<Voice | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const vapiRef = useRef<Vapi | null>(null);

  const persistFavorites = (next: string[]) => {
    setFavoriteMockIds(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("favorite:voices", JSON.stringify(next));
    }
  };

  const persistHidden = (next: string[]) => {
    setHiddenMockIds(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("hidden:voices", JSON.stringify(next));
    }
  };

  const seeds: Voice[] = VOICES_CATALOG.map((v) => ({
    id: `mock_${v.id}`,
    name: v.name,
    language: v.language,
    accent: v.accent,
    gender: v.gender,
    description: v.description,
    favorite: v.favorite,
  }));

  const all: Voice[] = seeds
    .filter((s) => !hiddenMockIds.includes(s.id))
    .map((s) => ({
      ...s,
      favorite: favoriteMockIds.includes(s.id) ? true : s.favorite,
    }));

  const toggleFavorite = (v: Voice) => {
    const isFav = favoriteMockIds.includes(v.id);
    const next = isFav
      ? favoriteMockIds.filter((x) => x !== v.id)
      : [...favoriteMockIds, v.id];
    persistFavorites(next);
  };

  const handleDelete = (v: Voice) => {
    persistHidden([...hiddenMockIds, v.id]);
    toast.success("Voice removed");
  };

  const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

  const openPreview = (v: Voice) => {
    setPreviewVoice(v);
    setPreviewText(
      `Hi, I'm ${v.name}. I speak ${v.language}${v.accent ? ` with ${article(v.accent)} ${v.accent} accent` : ""}. I'd love to be the voice of your next AI agent.`,
    );
    setSpeaking(false);
    setPreviewError(null);
  };

  const teardownVapi = () => {
    try { vapiRef.current?.stop(); } catch { /* already stopped */ }
    vapiRef.current = null;
  };

  const speak = async () => {
    if (!previewVoice) return;
    if (!VAPI_PUBLIC_KEY) {
      setPreviewError("VAPI public key is not configured. Set VITE_VAPI_PUBLIC_KEY in your .env file.");
      return;
    }
    const voiceEntry = VAPI_VOICE_IDS[previewVoice.name.toLowerCase()];
    if (!voiceEntry) {
      setPreviewError(`No Vapi voice mapping found for "${previewVoice.name}".`);
      return;
    }

    setPreviewError(null);
    setSpeaking(true);
    try {
      const vapi = new Vapi(VAPI_PUBLIC_KEY);
      vapiRef.current = vapi;

      vapi.on("call-start", () => {
        vapi.say(previewText, true); // speak the sample, then auto end-call
      });
      vapi.on("call-end", () => {
        setSpeaking(false);
        vapiRef.current = null;
      });
      vapi.on("error", (e: any) => {
        // A live-call error (e.g. mic permission denied) means Daily/Vapi is mid-teardown
        // of DOM it manages itself. Leaving the dialog open and rendering an inline error
        // here races with that teardown and can crash React — close the dialog and toast
        // instead, matching how the pre-flight (no public key) case is handled differently
        // because it never touches Daily at all.
        const message = e?.error?.message ?? e?.message ?? "Voice preview failed";
        toast.error(message.includes("Permission denied") || message.toLowerCase().includes("ejection")
          ? "Voice preview needs microphone access to connect the call (you won't need to speak)."
          : message);
        setSpeaking(false);
        vapiRef.current = null;
        setPreviewVoice(null);
      });

      await vapi.start({
        name: `Preview — ${previewVoice.name}`,
        transcriber: { provider: "deepgram", language: "en" },
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: "Stay silent until told to speak." }],
        },
        voice: { provider: "vapi", ...voiceEntry },
        maxDurationSeconds: 20,
      } as any);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to start voice preview");
      setSpeaking(false);
      teardownVapi();
      setPreviewVoice(null);
    }
  };

  const stopSpeaking = () => {
    teardownVapi();
    setSpeaking(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">AI Voices</h1>
        <p className="text-sm text-muted-foreground">Browse and preview voices for your agents.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {all.map((v) => (
          <div key={v.id} className="rounded-xl border border-border bg-card p-5 card-interactive">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Mic className="h-5 w-5" />
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleFavorite(v)}
                  className="rounded-md p-1 hover:bg-muted"
                  aria-label="Toggle favorite"
                  title={v.favorite ? "Unfavorite" : "Favorite"}
                >
                  <Star
                    className={`h-4 w-4 ${v.favorite ? "fill-warning text-warning" : "text-muted-foreground"}`}
                  />
                </button>
              </div>
            </div>
            <h3 className="mt-4 font-semibold text-foreground">{v.name}</h3>
            <p className="text-xs text-muted-foreground">
              {v.language} · {v.accent || " "} · {v.gender || v.category || " "}
            </p>
            {v.description && (
              <p className="mt-1 text-xs italic text-muted-foreground/80">{v.description}</p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => openPreview(v)}
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <Play className="h-3 w-3" /> Preview
              </button>
              <button
                onClick={() => handleDelete(v)}
                className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                aria-label="Delete"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Preview Modal */}
      <Dialog
        open={!!previewVoice}
        onOpenChange={(o) => {
          if (!o) {
            stopSpeaking();
            setPreviewVoice(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mic className="h-5 w-5 text-primary" />
              Preview {previewVoice?.name}
            </DialogTitle>
            <DialogDescription>
              {previewVoice?.language} · {previewVoice?.accent || " "} · {previewVoice?.gender || previewVoice?.category || " "}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Label htmlFor="preview-text">Sample text</Label>
            <Textarea
              id="preview-text"
              className="h-28"
              value={previewText}
              onChange={(e) => setPreviewText(e.target.value)}
            />
            {previewError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{previewError}</span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Plays a live sample using this voice's real Vapi model — the same voice your
                agents actually use on calls. Your browser will ask for microphone access even
                though you won't need to speak.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                stopSpeaking();
                setPreviewVoice(null);
              }}
            >
              Close
            </Button>
            {speaking ? (
              <Button onClick={stopSpeaking} variant="destructive">
                <Pause className="mr-2 h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button onClick={speak} disabled={!previewText.trim()}>
                <Play className="mr-2 h-4 w-4" /> Play Preview
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AIVoices;
