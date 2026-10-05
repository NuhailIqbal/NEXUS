/**
 * Best-effort Devanagari -> Urdu (Perso-Arabic) transliteration for live call transcripts.
 * Pure string helpers with no I/O. `fixMultilingualScript` is the entry point, applied to each
 * final transcript message in components/dashboard/LiveVoiceModal.tsx. Background on why it
 * is needed is in the comment below.
 */
// Deepgram's "multi" (auto-detect) transcriber has no dedicated Urdu language — spoken
// Urdu and Hindi are phonetically identical (Hindustani), so it transcribes Urdu speech
// using Hindi's Devanagari script instead of Urdu's Nastaliq/Perso-Arabic script. This
// platform has no Hindi language option anywhere, so any Devanagari text appearing in a
// live transcript is always this exact mismatch, never an intentional Hindi reply — we
// transliterate it to Urdu script so a Multilingual agent's Urdu turns display correctly.
//
// This is a best-effort character-level mapping, not a linguistically complete
// transliteration engine: short vowel matras are dropped (matching how Urdu/Arabic-script
// writing conventionally omits short vowels) and conjuncts aren't specially handled. It
// reads correctly for common conversational phrases, which is what a live call transcript
// needs.

/** Matches any character in the Devanagari Unicode block (U+0900-U+097F). */
const DEVANAGARI_RANGE = /[ऀ-ॿ]/;

// Independent vowels (word-initial / standalone)
const INDEPENDENT_VOWELS: Record<string, string> = {
  "अ": "ا", "आ": "آ", "इ": "اِ", "ई": "ای", "उ": "اُ",
  "ऊ": "اُو", "ए": "اے", "ऐ": "اَے", "ओ": "او", "औ": "اَو",
};

// Consonants (includes nukta variants for loanword sounds)
// Caveat: each nukta entry (the last row) is a base letter plus U+093C, i.e. two code points,
// but devanagariToUrdu() looks up one code point at a time, so those keys never match. A
// nukta letter therefore comes out as the plain consonant's mapping followed by the unmapped
// U+093C, and precomposed nukta forms (U+0958-U+095F) pass through unchanged.
const CONSONANTS: Record<string, string> = {
  "क": "ک", "ख": "کھ", "ग": "گ", "घ": "گھ", "ङ": "نگ",
  "च": "چ", "छ": "چھ", "ज": "ج", "झ": "جھ", "ञ": "ن",
  "ट": "ٹ", "ठ": "ٹھ", "ड": "ڈ", "ढ": "ڈھ", "ण": "ن",
  "त": "ت", "थ": "تھ", "द": "د", "ध": "دھ", "न": "ن",
  "प": "پ", "फ": "پھ", "ब": "ب", "भ": "بھ", "म": "م",
  "य": "ی", "र": "ر", "ल": "ل", "व": "و",
  "श": "ش", "ष": "ش", "स": "س", "ह": "ہ",
  "क़": "ق", "ख़": "خ", "ग़": "غ", "ज़": "ز", "ड़": "ڑ", "ढ़": "ڑھ", "फ़": "ف",
};

// Vowel signs (matras) attached after a consonant — long vowels map to their Urdu
// matres lectionis; short vowels and the virama are dropped (see file comment).
const MATRAS: Record<string, string> = {
  "ा": "ا", "ी": "ی", "ू": "و", "े": "ے", "ै": "َے", "ो": "و", "ौ": "َو",
  "ि": "", "ु": "", "्": "",
};

// Anusvara/chandrabindu/visarga, Devanagari digits -> Extended Arabic-Indic digits, and the
// danda (sentence stop) -> Urdu full stop.
const OTHER: Record<string, string> = {
  "ं": "ں", "ँ": "ں", "ः": "ہ",
  "०": "۰", "१": "۱", "२": "۲", "३": "۳", "४": "۴",
  "५": "۵", "६": "۶", "७": "۷", "८": "۸", "९": "۹",
  "।": "۔",
};

/** Merged lookup table: one Devanagari code point -> its Urdu replacement ("" drops the character). */
const CHAR_MAP: Record<string, string> = { ...INDEPENDENT_VOWELS, ...CONSONANTS, ...MATRAS, ...OTHER };

/** True if `text` contains at least one Devanagari character. */
export function containsDevanagari(text: string): boolean {
  return DEVANAGARI_RANGE.test(text);
}

/**
 * Transliterates `text` one code point at a time via CHAR_MAP. Characters with no entry
 * (Latin letters, spaces, punctuation, unmapped marks) are copied through unchanged.
 */
export function devanagariToUrdu(text: string): string {
  let out = "";
  for (const ch of text) {
    out += CHAR_MAP[ch] ?? ch;
  }
  return out;
}

/** Only transliterates text that actually contains Devanagari — every other script passes through untouched. */
export function fixMultilingualScript(text: string): string {
  return containsDevanagari(text) ? devanagariToUrdu(text) : text;
}
