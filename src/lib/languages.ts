/**
 * The languages an agent can be set to, as the dashboard shows and saves them. The agent form
 * stores the `value` string (the label, not an ISO code) in `ai_agents.language`; the backend
 * (backend/services/vapi_client.py's _resolve_language) turns it into a speech-recognition code
 * and picks the matching voice, model instructions and transfer line. Adding a language here
 * also needs an entry there: backend/tests/test_languages.py checks that every value below
 * resolves to its own code.
 */
import { SPANISH_VOICE_NAMES, GERMAN_VOICE_NAMES, URDU_VOICE_NAMES, isEnglishOnlyVoice } from "@/lib/voices";

/** Dropdown options in display order. `value` is what is saved, `label` is what the user reads. */
export const AGENT_LANGUAGES = [
  { value: "English", label: "English" },
  { value: "Urdu", label: "Urdu" },
  { value: "Spanish", label: "Spanish" },
  { value: "German", label: "German" },
  { value: "Multilingual", label: "Multilingual (auto-detect)" },
] as const;

export type AgentLanguage = (typeof AGENT_LANGUAGES)[number]["value"];

/**
 * Maps a stored language string onto one of the dropdown values. Agents saved before the list
 * was simplified can hold values like "Urdu (PK)", "Spanish (ES)" or "English (US)", and agents
 * created through the API can hold a bare code such as "es" — none of which match an option, and
 * a dropdown with no match shows blank. Anything unrecognized (including French and Italian
 * from the old list, which the form no longer offers) becomes English, as it always has.
 *
 * The edit form re-saves whatever this returns, so every language the form offers MUST map to
 * itself here; otherwise opening and saving that agent would quietly turn it into English.
 */
export function normalizeLanguage(lang: string | null | undefined): AgentLanguage {
  if (!lang) return "English";
  if (lang === "Multilingual") return "Multilingual";
  if (/urdu/i.test(lang)) return "Urdu";
  if (/^\s*(spanish|español|espanol)\b|^\s*es(?:[-_]|$)/i.test(lang)) return "Spanish";
  if (/^\s*(german|deutsch)\b|^\s*de(?:[-_]|$)/i.test(lang)) return "German";
  return "English";
}

/**
 * The voice the form moves to when one of these languages is picked while an English-only voice is
 * selected. Spanish and German match the backend's _DEFAULT_VOICE_BY_LANGUAGE. Multilingual has no
 * language of its own, so it gets the voice the backend already uses for any non-English agent
 * that has no voice (Zara); a Multilingual agent can only speak Spanish, German or Urdu aloud
 * through a multilingual voice. English and Urdu keep whatever voice is chosen.
 */
export const DEFAULT_VOICE_FOR_LANGUAGE: Partial<Record<AgentLanguage, string>> = {
  Spanish: SPANISH_VOICE_NAMES[0],
  German: GERMAN_VOICE_NAMES[0],
  Multilingual: URDU_VOICE_NAMES[0],
};

/**
 * The voices made for a language that is spoken on every call, for messages that name them. Only
 * Spanish and German have this: the backend never uses an English-only voice for them (see
 * _resolve_voice), whereas it leaves a Multilingual agent's voice as it was chosen.
 */
const VOICES_FOR_LANGUAGE: Partial<Record<AgentLanguage, readonly string[]>> = {
  Spanish: SPANISH_VOICE_NAMES,
  German: GERMAN_VOICE_NAMES,
};

/**
 * The voice to show after the language dropdown changes to `language`. Spanish, German and
 * Multilingual agents can't speak their languages through an English-only voice, so picking one of
 * them while such a voice is selected moves the selection to that language's default. Every other
 * change keeps the current voice, so English and Urdu behave exactly as before, and so does any
 * agent that is merely opened and saved.
 */
export function voiceAfterLanguageChange(language: string, currentVoice: string): string {
  const fallback = DEFAULT_VOICE_FOR_LANGUAGE[normalizeLanguage(language)];
  return fallback && isEnglishOnlyVoice(currentVoice) ? fallback : currentVoice;
}

/**
 * A short note for the voice field when the chosen voice can't speak the agent's language, or null
 * when there is nothing to say. Spanish and German get the backend's substitution explained;
 * Multilingual (whose voice is never replaced) is told which voices can read other languages.
 */
export function voiceLanguageNote(language: string, voice: string): string | null {
  if (!isEnglishOnlyVoice(voice)) return null;
  const lang = normalizeLanguage(language);
  const names = VOICES_FOR_LANGUAGE[lang];
  if (names) {
    return `${voice} only speaks English, so this ${lang} agent will use ${DEFAULT_VOICE_FOR_LANGUAGE[lang]} instead. Pick ${names.join(" or ")} to choose a ${lang} voice yourself.`;
  }
  if (lang === "Multilingual") {
    return `${voice} only speaks English. For callers in Spanish, German or Urdu, pick a multilingual voice: Zara, Ali, Lucia, Mateo, Greta or Lukas.`;
  }
  return null;
}

/**
 * Example greeting shown in the empty greeting box. The greeting is spoken exactly as written, so
 * for Spanish and German the example is in that language to nudge the author to write it there.
 */
export function greetingPlaceholder(language: string): string {
  switch (normalizeLanguage(language)) {
    case "Spanish": return "¡Hola! ¿En qué puedo ayudarle hoy?";
    case "German": return "Hallo! Wie kann ich Ihnen heute helfen?";
    default: return "Hi! How can I help you today?";
  }
}

/**
 * Reminder under the greeting box for Spanish and German, null for the other languages. The model
 * answers everything after the greeting in the agent's language, but the greeting itself is played
 * word for word, so only the author can make the opening line match.
 */
export function greetingNote(language: string): string | null {
  const lang = normalizeLanguage(language);
  return lang === "Spanish" || lang === "German"
    ? `The greeting is spoken exactly as you write it, so write it in ${lang}.`
    : null;
}
