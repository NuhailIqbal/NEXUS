import { useState } from "react";
import { Mic, Star, Play, Pause, Trash2 } from "lucide-react";
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

const LANG_MAP: Record<string, string> = {
  "English (US)": "en-US",
  "English (UK)": "en-GB",
  "English (AU)": "en-AU",
  "Spanish (ES)": "es-ES",
  "Spanish (MX)": "es-MX",
  "French (FR)": "fr-FR",
  "Italian (IT)": "it-IT",
  "German (DE)": "de-DE",
};

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
  };

  const pickVoice = (lang: string, gender: string): SpeechSynthesisVoice | undefined => {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return undefined;
    const isFemale = gender.toLowerCase() === "female";

    // Common female / male voice name hints across browsers/OSes
    const femaleHints = [
      "female", "woman", "samantha", "victoria", "karen", "tessa", "moira",
      "fiona", "susan", "allison", "ava", "serena", "zira", "hazel", "google uk english female",
      "google us english", "amelie", "amélie", "audrey", "marie", "anna",
      "alice", "paulina", "monica", "mónica", "google español", "luciana",
    ];
    const maleHints = [
      "male", "man", "daniel", "alex", "fred", "tom", "david", "mark",
      "george", "oliver", "thomas", "diego", "jorge", "carlos", "google uk english male",
      "rishi", "aaron", "arthur", "albert", "bruce",
    ];
    const hints = isFemale ? femaleHints : maleHints;
    const antiHints = isFemale ? maleHints : femaleHints;

    const langPrefix = lang.split("-")[0].toLowerCase();
    const sameLang = voices.filter(
      (v) => v.lang === lang || v.lang.toLowerCase().startsWith(langPrefix),
    );
    const pool = sameLang.length ? sameLang : voices;

    const matchByHint = (list: SpeechSynthesisVoice[]) =>
      list.find((v) => {
        const n = v.name.toLowerCase();
        return hints.some((h) => n.includes(h)) && !antiHints.some((h) => n.includes(h));
      });

    return (
      matchByHint(pool) ||
      matchByHint(voices) ||
      pool[0] ||
      voices[0]
    );
  };

  const speak = () => {
    if (!previewVoice || typeof window === "undefined" || !("speechSynthesis" in window)) {
      toast.error("Voice preview is not supported in this browser");
      return;
    }
    window.speechSynthesis.cancel();

    const startSpeaking = () => {
      const utter = new SpeechSynthesisUtterance(previewText);
      const lang = LANG_MAP[previewVoice.language] ?? "en-US";
      utter.lang = lang;
      utter.rate = 1;
      const isFemale = previewVoice.gender.toLowerCase() === "female";
      utter.pitch = isFemale ? 1.35 : 0.7;
      const chosen = pickVoice(lang, previewVoice.gender);
      if (chosen) utter.voice = chosen;
      utter.onend = () => setSpeaking(false);
      utter.onerror = () => setSpeaking(false);
      setSpeaking(true);
      window.speechSynthesis.speak(utter);
    };

    // Voices may load async on first use
    if (!window.speechSynthesis.getVoices().length) {
      const handler = () => {
        window.speechSynthesis.removeEventListener("voiceschanged", handler);
        startSpeaking();
      };
      window.speechSynthesis.addEventListener("voiceschanged", handler);
      // Trigger load
      window.speechSynthesis.getVoices();
      // Fallback timeout
      setTimeout(() => {
        if (window.speechSynthesis.getVoices().length) {
          window.speechSynthesis.removeEventListener("voiceschanged", handler);
          startSpeaking();
        }
      }, 250);
    } else {
      startSpeaking();
    }
  };

  const stopSpeaking = () => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
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
            <p className="text-xs text-muted-foreground">
              Uses your browser's text-to-speech engine for an instant preview.
            </p>
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
