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

// The full catalog offered on the AI Voices page — every voice an agent can be given,
// regardless of the agent's own language (the backend resolves a voice by name across
// this whole set independently of language; see _resolve_voice/_VOICE_REGISTRY).
export const ALL_VOICE_NAMES = [...VAPI_VOICE_NAMES, ...URDU_VOICE_NAMES] as const;
