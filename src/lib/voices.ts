// Vapi's built-in voice catalog (provider="vapi") — the only voice names the backend
// (backend/services/vapi_client.py's _resolve_voice) actually recognizes for real calls.
// Single source of truth: CreateAIAgent.tsx and AIAgents.tsx's edit form both read from
// here so their dropdowns can't silently drift from what the backend accepts. If a
// dropdown offers a name that isn't in this list, the backend defaults to "Elliot" with
// no error — that's exactly the bug this file exists to prevent (the edit form used to
// hardcode an unrelated set of mock voice names, so every non-"Kai" selection there
// silently produced Elliot regardless of what the user picked).
export const VAPI_VOICE_NAMES = [
  "Elliot", "Savannah", "Rohan", "Emma", "Clara", "Nico", "Kai",
  "Sagar", "Godfrey", "Neil", "Layla", "Sid", "Naina",
] as const;

// ElevenLabs premade voices — Vapi's own built-in voices above are English-only, so an
// agent set to Urdu uses one of these instead (see backend/services/vapi_client.py's
// _resolve_voice). Same single-source-of-truth reasoning as VAPI_VOICE_NAMES: keep
// this in sync with the backend's _URDU_VOICE_IDS.
export const URDU_VOICE_NAMES = ["Zara", "Ali"] as const;
