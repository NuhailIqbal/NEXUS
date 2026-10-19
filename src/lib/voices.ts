/**
 * Names of the voices an agent can be assigned, split into the Vapi built-in set (English only)
 * and the ElevenLabs multilingual sets (Urdu, Spanish, German). `ALL_VOICE_NAMES` feeds the voice
 * dropdown in pages/dashboard/CreateAIAgent.tsx and the voice count in lib/marketing-facts.ts. The
 * backend (backend/services/vapi_client.py) resolves these names to real provider voice ids.
 */
// Vapi's built-in voice catalog (provider="vapi") — English-only. Single source of
// truth: CreateAIAgent.tsx, AIAgents.tsx's edit form, and AIVoices.tsx all read from
// here so their voice lists can't silently drift from what the backend
// (backend/services/vapi_client.py's _resolve_voice) actually recognizes for real calls.
export const VAPI_VOICE_NAMES = [
  "Elliot", "Savannah", "Rohan", "Emma", "Clara", "Nico", "Kai",
  "Sagar", "Godfrey", "Neil", "Layla", "Sid", "Naina",
] as const;

// ElevenLabs multilingual premade voices — same single-source-of-truth reasoning as
// VAPI_VOICE_NAMES: keep in sync with the backend's _URDU_VOICE_IDS.
export const URDU_VOICE_NAMES = ["Zara", "Ali"] as const;

// ElevenLabs multilingual voices for Spanish and German agents (female first, then male).
// Keep in sync with the backend's _SPANISH_VOICE_IDS and _GERMAN_VOICE_IDS.
export const SPANISH_VOICE_NAMES = ["Lucia", "Mateo"] as const;
export const GERMAN_VOICE_NAMES = ["Greta", "Lukas"] as const;

// The full catalog offered on the AI Voices page — every voice an agent can be given,
// regardless of the agent's own language (the backend resolves a voice by name across
// this whole set independently of language; see _resolve_voice/_VOICE_REGISTRY).
export const ALL_VOICE_NAMES = [
  ...VAPI_VOICE_NAMES, ...URDU_VOICE_NAMES, ...SPANISH_VOICE_NAMES, ...GERMAN_VOICE_NAMES,
] as const;

/**
 * True for a voice that can only speak English (Vapi's built-in set). Spanish and German agents
 * can't use these (the backend swaps in the language's own voice), and a Multilingual agent that
 * has one will read other languages with an English accent or worse.
 */
export const isEnglishOnlyVoice = (name: string | null | undefined): boolean =>
  (VAPI_VOICE_NAMES as readonly string[]).some((v) => v.toLowerCase() === (name ?? "").trim().toLowerCase());
