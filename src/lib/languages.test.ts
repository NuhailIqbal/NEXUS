import { describe, expect, it } from "vitest";
import {
  AGENT_LANGUAGES,
  DEFAULT_VOICE_FOR_LANGUAGE,
  greetingNote,
  greetingPlaceholder,
  normalizeLanguage,
  voiceAfterLanguageChange,
  voiceLanguageNote,
} from "./languages";
import { ALL_VOICE_NAMES, GERMAN_VOICE_NAMES, SPANISH_VOICE_NAMES, URDU_VOICE_NAMES, VAPI_VOICE_NAMES, isEnglishOnlyVoice } from "./voices";
import { LANGUAGE_OPTIONS, VOICE_COUNT } from "./marketing-facts";

describe("AGENT_LANGUAGES", () => {
  it("offers English, Urdu, Spanish, German and Multilingual, in that order", () => {
    expect(AGENT_LANGUAGES.map((l) => l.value)).toEqual(["English", "Urdu", "Spanish", "German", "Multilingual"]);
    expect(AGENT_LANGUAGES.map((l) => l.label)).toEqual(["English", "Urdu", "Spanish", "German", "Multilingual (auto-detect)"]);
  });

  it("keeps the three original values exactly as agents already store them", () => {
    const values = AGENT_LANGUAGES.map((l) => l.value) as string[];
    for (const original of ["English", "Urdu", "Multilingual"]) expect(values).toContain(original);
  });

  it("feeds the marketing site, so its counts can't drift from the form", () => {
    expect(LANGUAGE_OPTIONS).toEqual(AGENT_LANGUAGES.map((l) => l.label));
    expect(LANGUAGE_OPTIONS).toHaveLength(5);
  });
});

describe("normalizeLanguage (what the edit form shows and re-saves)", () => {
  it("every option the form offers maps to itself, so saving never changes the language", () => {
    for (const { value } of AGENT_LANGUAGES) expect(normalizeLanguage(value)).toBe(value);
  });

  it("recognises Spanish and German however they were stored", () => {
    for (const s of ["Spanish", "spanish", "Spanish (ES)", "Spanish (MX)", "Español", "es", "ES", "es-ES", "es_MX", " Spanish "]) {
      expect(normalizeLanguage(s)).toBe("Spanish");
    }
    for (const s of ["German", "german", "German (DE)", "Deutsch", "de", "DE", "de-DE", "de_AT"]) {
      expect(normalizeLanguage(s)).toBe("German");
    }
  });

  it("keeps mapping the older English and Urdu labels the way it always did", () => {
    expect(normalizeLanguage(null)).toBe("English");
    expect(normalizeLanguage(undefined)).toBe("English");
    expect(normalizeLanguage("")).toBe("English");
    expect(normalizeLanguage("English (US)")).toBe("English");
    expect(normalizeLanguage("English (UK)")).toBe("English");
    expect(normalizeLanguage("Urdu (PK)")).toBe("Urdu");
    expect(normalizeLanguage("urdu")).toBe("Urdu");
    expect(normalizeLanguage("Multilingual")).toBe("Multilingual");
  });

  it("still turns the languages the form no longer offers into English", () => {
    for (const s of ["French (FR)", "Italian (IT)", "fr", "Klingon"]) expect(normalizeLanguage(s)).toBe("English");
  });

  it("does not mistake other words that merely start with the same letters", () => {
    for (const s of ["Estonian", "Esperanto", "Desi", "Germanic", "Spanglish", "Dutch"]) {
      expect(normalizeLanguage(s)).toBe("English");
    }
  });
});

describe("voices for the new languages", () => {
  it("lists a female and a male voice for each, all part of the catalog", () => {
    expect(SPANISH_VOICE_NAMES).toEqual(["Lucia", "Mateo"]);
    expect(GERMAN_VOICE_NAMES).toEqual(["Greta", "Lukas"]);
    for (const v of [...SPANISH_VOICE_NAMES, ...GERMAN_VOICE_NAMES]) expect(ALL_VOICE_NAMES).toContain(v);
  });

  it("has no duplicate voice names (the dropdown and the backend key on the name)", () => {
    const lower = ALL_VOICE_NAMES.map((v) => v.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it("counts every voice for the marketing site", () => {
    expect(VOICE_COUNT).toBe(VAPI_VOICE_NAMES.length + URDU_VOICE_NAMES.length + SPANISH_VOICE_NAMES.length + GERMAN_VOICE_NAMES.length);
    expect(VOICE_COUNT).toBe(ALL_VOICE_NAMES.length);
  });

  it("knows which voices only speak English", () => {
    expect(isEnglishOnlyVoice("Elliot")).toBe(true);
    expect(isEnglishOnlyVoice(" naina ")).toBe(true);
    for (const v of [...URDU_VOICE_NAMES, ...SPANISH_VOICE_NAMES, ...GERMAN_VOICE_NAMES]) expect(isEnglishOnlyVoice(v)).toBe(false);
    expect(isEnglishOnlyVoice("")).toBe(false);
    expect(isEnglishOnlyVoice(null)).toBe(false);
  });

  it("starts Spanish on Lucia, German on Greta and Multilingual on Zara; English and Urdu have no default", () => {
    expect(DEFAULT_VOICE_FOR_LANGUAGE).toEqual({ Spanish: "Lucia", German: "Greta", Multilingual: "Zara" });
  });
});

describe("voiceAfterLanguageChange", () => {
  it("moves an English-only voice to the language's own voice for Spanish and German", () => {
    expect(voiceAfterLanguageChange("Spanish", "Elliot")).toBe("Lucia");
    expect(voiceAfterLanguageChange("German", "Elliot")).toBe("Greta");
    for (const v of VAPI_VOICE_NAMES) {
      expect(voiceAfterLanguageChange("Spanish", v)).toBe("Lucia");
      expect(voiceAfterLanguageChange("German", v)).toBe("Greta");
    }
  });

  it("keeps a voice that can already speak the language", () => {
    expect(voiceAfterLanguageChange("Spanish", "Mateo")).toBe("Mateo");
    expect(voiceAfterLanguageChange("German", "Zara")).toBe("Zara");
    expect(voiceAfterLanguageChange("Spanish", "Greta")).toBe("Greta");
  });

  it("moves an English-only voice to Zara for Multilingual, since only a multilingual voice can speak its languages", () => {
    expect(voiceAfterLanguageChange("Multilingual", "Elliot")).toBe("Zara");
    expect(voiceAfterLanguageChange("Multilingual", "Mateo")).toBe("Mateo");
    expect(voiceAfterLanguageChange("Multilingual", "Ali")).toBe("Ali");
  });

  it("never touches the voice for English or Urdu", () => {
    for (const language of ["English", "Urdu"]) {
      expect(voiceAfterLanguageChange(language, "Elliot")).toBe("Elliot");
      expect(voiceAfterLanguageChange(language, "Zara")).toBe("Zara");
    }
  });

  it("leaves a blank voice alone", () => {
    expect(voiceAfterLanguageChange("Spanish", "")).toBe("");
  });
});

describe("voiceLanguageNote", () => {
  it("explains the swap for a Spanish or German agent that has an English-only voice", () => {
    expect(voiceLanguageNote("Spanish", "Elliot")).toBe(
      "Elliot only speaks English, so this Spanish agent will use Lucia instead. Pick Lucia or Mateo to choose a Spanish voice yourself.",
    );
    expect(voiceLanguageNote("German", "Sid")).toBe(
      "Sid only speaks English, so this German agent will use Greta instead. Pick Greta or Lukas to choose a German voice yourself.",
    );
  });

  it("tells a Multilingual agent with an English-only voice which voices can read other languages", () => {
    const note = voiceLanguageNote("Multilingual", "Elliot");
    expect(note).toMatch(/only speaks English/);
    for (const v of ["Zara", "Ali", "Lucia", "Mateo", "Greta", "Lukas"]) expect(note).toContain(v);
  });

  it("says nothing when the voice is fine or the language is English or Urdu", () => {
    expect(voiceLanguageNote("Spanish", "Lucia")).toBeNull();
    expect(voiceLanguageNote("Multilingual", "Zara")).toBeNull();
    expect(voiceLanguageNote("English", "Elliot")).toBeNull();
    expect(voiceLanguageNote("Urdu", "Elliot")).toBeNull();
  });
});

describe("greeting hints", () => {
  it("shows an example greeting in Spanish and German, and the usual English one otherwise", () => {
    expect(greetingPlaceholder("Spanish")).toBe("¡Hola! ¿En qué puedo ayudarle hoy?");
    expect(greetingPlaceholder("German")).toBe("Hallo! Wie kann ich Ihnen heute helfen?");
    for (const language of ["English", "Urdu", "Multilingual", "English (US)", ""]) {
      expect(greetingPlaceholder(language)).toBe("Hi! How can I help you today?");
    }
  });

  it("reminds the author that the greeting is spoken as written, for Spanish and German only", () => {
    expect(greetingNote("Spanish")).toBe("The greeting is spoken exactly as you write it, so write it in Spanish.");
    expect(greetingNote("German")).toBe("The greeting is spoken exactly as you write it, so write it in German.");
    for (const language of ["English", "Urdu", "Multilingual"]) expect(greetingNote(language)).toBeNull();
  });
});
