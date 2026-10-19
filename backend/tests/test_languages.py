"""Agent languages: how an agent's language label becomes a transcriber, a voice, a language
directive for the model and a transfer line, with Spanish and German added next to English,
Urdu and Multilingual.

Pure functions only (no database, no network). The tests that go through the API are in
test_languages_api.py; the check that the dashboard's language and voice lists agree with
this module is at the bottom of this file.

Run from the backend folder:  python -m unittest discover -s tests -p test_languages.py -v
"""
import hashlib
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from config import settings
from services import vapi_client as vc

NEXUS = Path(__file__).resolve().parents[2]

# sha256 of the Urdu directive and of the Multilingual directive's instructions (without the
# trailing "---" separator) exactly as they were before Spanish and German existed. Callers of
# those agents must keep getting these exact words.
URDU_DIRECTIVE_SHA256 = "fcbf1ba50d0776f851b05b9614945c1c2e6d53eeff2d0a47562c9a45cf3705b1"
OLD_MULTILINGUAL_BODY_SHA256 = "884e44493bfa17cc403a5a6d899db3b6a97a644d507f82e7ca120c813d4e09a3"
OLD_MULTILINGUAL_BODY_LENGTH = 926


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class ResolveLanguage(unittest.TestCase):
    def test_labels_the_agent_form_saves(self):
        for label, code in [("English", "en"), ("Urdu", "ur"), ("Spanish", "es"), ("German", "de"),
                            ("Multilingual", "multi")]:
            self.assertEqual(vc._resolve_language(label), code, label)

    def test_plain_spanish_and_german_are_not_mistaken_for_english(self):
        # The resolver passes short unknown text through and turns longer text into "en", so a
        # label missing from its table (7 and 6 letters) would silently have become English.
        self.assertNotEqual(vc._resolve_language("Spanish"), "en")
        self.assertNotEqual(vc._resolve_language("German"), "en")

    def test_older_labels_keep_their_codes(self):
        for label, code in [
            ("English (US)", "en-US"), ("English (UK)", "en-GB"), ("Urdu (PK)", "ur"),
            ("Spanish (ES)", "es"), ("Spanish (MX)", "es"), ("German (DE)", "de"),
            ("French (FR)", "fr"), ("Italian (IT)", "it"),
        ]:
            self.assertEqual(vc._resolve_language(label), code, label)

    def test_case_and_spacing_do_not_matter(self):
        for label, code in [(" spanish ", "es"), ("GERMAN", "de"), ("ES", "es"), ("De", "de"),
                            ("urdu", "ur"), ("MULTILINGUAL", "multi")]:
            self.assertEqual(vc._resolve_language(label), code, label)

    def test_codes_pass_through_and_free_text_falls_back_to_english(self):
        for label, code in [("fr", "fr"), ("pt-BR", "pt-BR"), ("en", "en"), ("ur", "ur"),
                            ("multi", "multi"), (None, "en"), ("", "en"),
                            ("Klingon is not a language we support", "en")]:
            self.assertEqual(vc._resolve_language(label), code, repr(label))


class Transcriber(unittest.TestCase):
    def test_spanish_and_german_use_deepgram_nova_3_in_their_own_language(self):
        self.assertEqual(vc._resolve_transcriber("Spanish"), {"provider": "deepgram", "language": "es", "model": "nova-3"})
        self.assertEqual(vc._resolve_transcriber("German"), {"provider": "deepgram", "language": "de", "model": "nova-3"})

    def test_older_spanish_and_german_labels_get_the_same_transcriber(self):
        self.assertEqual(vc._resolve_transcriber("Spanish (MX)"), vc._resolve_transcriber("Spanish"))
        self.assertEqual(vc._resolve_transcriber("German (DE)"), vc._resolve_transcriber("German"))

    def test_multilingual_still_uses_nova_3_multi_which_covers_spanish_and_german(self):
        self.assertEqual(vc._resolve_transcriber("Multilingual"), {"provider": "deepgram", "language": "multi", "model": "nova-3"})

    def test_existing_languages_are_unchanged(self):
        self.assertEqual(vc._resolve_transcriber("English"), {"provider": "deepgram", "language": "en"})
        self.assertEqual(vc._resolve_transcriber("English (US)"), {"provider": "deepgram", "language": "en-US"})
        self.assertEqual(vc._resolve_transcriber(None), {"provider": "deepgram", "language": "en"})
        self.assertEqual(vc._resolve_transcriber("Urdu"), {"provider": "deepgram", "language": "ur", "model": "nova-3"})
        self.assertEqual(vc._resolve_transcriber("French (FR)"), {"provider": "deepgram", "language": "fr"})


class Voices(unittest.TestCase):
    MATILDA = "XrExE9yKIg1WjnnlVkGX"
    ERIC = "cjVigY5qzO86Huf0OWal"

    def block(self, voice_id):
        return {"provider": "11labs", "voiceId": voice_id, "model": "eleven_multilingual_v2"}

    def test_new_voices_are_elevenlabs_multilingual_v2(self):
        for name, voice_id in [("Lucia", self.MATILDA), ("Mateo", self.ERIC), ("Greta", self.MATILDA), ("Lukas", self.ERIC)]:
            self.assertEqual(vc._resolve_voice(name, "English"), self.block(voice_id), name)

    def test_voice_ids_look_like_elevenlabs_ids(self):
        for name, block in vc._VOICE_REGISTRY.items():
            if block["provider"] == "11labs":
                self.assertRegex(block["voiceId"], r"^[A-Za-z0-9]{20}$", name)
                self.assertEqual(block["model"], "eleven_multilingual_v2", name)

    def test_default_voice_per_language_when_none_is_chosen(self):
        for blank in (None, "", "   ", "nobody"):
            self.assertEqual(vc._resolve_voice(blank, "Spanish"), vc._resolve_voice("Lucia"), repr(blank))
            self.assertEqual(vc._resolve_voice(blank, "German"), vc._resolve_voice("Greta"), repr(blank))
            self.assertEqual(vc._resolve_voice(blank, "Spanish (MX)"), vc._resolve_voice("Lucia"), repr(blank))

    def test_a_chosen_multilingual_voice_is_kept(self):
        self.assertEqual(vc._resolve_voice("Mateo", "German"), self.block(self.ERIC))
        self.assertEqual(vc._resolve_voice("lukas", "Spanish"), self.block(self.ERIC))
        self.assertEqual(vc._resolve_voice("Zara", "Spanish"), vc._resolve_voice("Zara"))
        self.assertEqual(vc._resolve_voice("  Ali ", "German"), vc._resolve_voice("Ali"))

    def test_spanish_and_german_never_use_a_built_in_english_voice(self):
        for name in vc._VAPI_VOICE_IDS:
            self.assertEqual(vc._resolve_voice(name, "Spanish"), vc._resolve_voice("Lucia"), name)
            self.assertEqual(vc._resolve_voice(name, "German"), vc._resolve_voice("Greta"), name)
            self.assertEqual(vc._resolve_voice(name, "es"), vc._resolve_voice("Lucia"), name)

    def test_the_other_languages_still_honour_any_voice(self):
        elliot = {"provider": "vapi", "voiceId": "Elliot"}
        for language in ("English", "English (US)", "Urdu", "Multilingual", "French (FR)", None):
            self.assertEqual(vc._resolve_voice("Elliot", language), elliot, repr(language))

    def test_defaults_for_the_other_languages_are_unchanged(self):
        self.assertEqual(vc._resolve_voice(None, "English"), {"provider": "vapi", "voiceId": "Elliot"})
        self.assertEqual(vc._resolve_voice("", None), {"provider": "vapi", "voiceId": "Elliot"})
        zara = vc._resolve_voice("Zara")
        for language in ("Urdu", "Urdu (PK)", "Multilingual", "French (FR)", "Italian (IT)"):
            self.assertEqual(vc._resolve_voice(None, language), zara, language)

    def test_returned_block_is_a_copy(self):
        block = vc._resolve_voice("Lucia", "Spanish")
        block["voiceId"] = "changed"
        self.assertEqual(vc._resolve_voice("Lucia", "Spanish")["voiceId"], self.MATILDA)
        fallback = vc._resolve_voice("Elliot", "German")
        fallback["voiceId"] = "changed"
        self.assertEqual(vc._resolve_voice("Greta", "German")["voiceId"], self.MATILDA)


class Directives(unittest.TestCase):
    def test_urdu_directive_is_word_for_word_unchanged(self):
        self.assertEqual(sha(vc._URDU_SCRIPT_DIRECTIVE), URDU_DIRECTIVE_SHA256)
        self.assertTrue(vc.apply_language_directive("PROMPT", "Urdu").startswith(vc._URDU_SCRIPT_DIRECTIVE))

    def test_multilingual_keeps_every_old_instruction_in_place(self):
        d = vc._MULTILINGUAL_DIRECTIVE
        self.assertEqual(sha(d[:OLD_MULTILINGUAL_BODY_LENGTH]), OLD_MULTILINGUAL_BODY_SHA256)
        # What was added sits after the old instructions and before the prompt separator.
        self.assertTrue(d.endswith("\n\n---\n\n"))

    def test_multilingual_names_spanish_and_german(self):
        added = vc._MULTILINGUAL_DIRECTIVE[OLD_MULTILINGUAL_BODY_LENGTH:]
        for needle in ("Spanish", "German", "usted", "Sie", "silent", "transfer", "goodbye", "never answer"):
            self.assertIn(needle.lower(), added.lower(), needle)

    def test_multilingual_still_has_its_urdu_rules(self):
        d = vc._MULTILINGUAL_DIRECTIVE
        for needle in ("DEVANAGARI", "ROMAN URDU", "default to English"):
            self.assertIn(needle, d)

    def test_each_new_directive_covers_every_moment_of_a_call(self):
        # The requirement: greeting, silence, transfer and closing lines must all be in the language.
        examples = {
            "Spanish": ["SPANISH", "greetings", "silent", "transferred", "goodbye", "¿Sigue ahí?",
                        "Un momento, por favor, le comunico.", "Gracias por su llamada", "usted"],
            "German": ["GERMAN", "greetings", "silent", "transferred", "goodbye", "Sind Sie noch da?",
                       "Einen Moment bitte, ich verbinde Sie.", "Auf Wiederhören", "Sie"],
        }
        for language, needles in examples.items():
            d = vc.apply_language_directive("", language)
            for needle in needles:
                self.assertIn(needle, d, f"{language}: {needle}")
            self.assertIn("ENTIRE call", d)
            self.assertIn("Never switch to English", d)

    def test_a_directive_only_talks_about_its_own_language(self):
        self.assertNotIn("GERMAN", vc._SPANISH_DIRECTIVE)
        self.assertNotIn("SPANISH", vc._GERMAN_DIRECTIVE)

    def test_directive_goes_in_front_of_the_agents_own_prompt(self):
        for language, directive in [("Spanish", vc._SPANISH_DIRECTIVE), ("German", vc._GERMAN_DIRECTIVE)]:
            out = vc.apply_language_directive("You are Acme's receptionist.", language)
            self.assertEqual(out, directive + "You are Acme's receptionist.")
            self.assertEqual(vc.apply_language_directive(None, language), directive)

    def test_older_spanish_and_german_labels_get_the_directive_too(self):
        for label, directive in [("Spanish (ES)", vc._SPANISH_DIRECTIVE), ("Spanish (MX)", vc._SPANISH_DIRECTIVE),
                                 ("German (DE)", vc._GERMAN_DIRECTIVE), ("es", vc._SPANISH_DIRECTIVE), ("de", vc._GERMAN_DIRECTIVE)]:
            self.assertTrue(vc.apply_language_directive("x", label).startswith(directive), label)

    def test_english_and_unlisted_languages_get_the_prompt_back_untouched(self):
        for language in ("English", "English (US)", "en", None, "", "French (FR)", "Italian (IT)", "pt-BR"):
            self.assertEqual(vc.apply_language_directive("You are Acme's receptionist.", language),
                             "You are Acme's receptionist.", repr(language))
        self.assertEqual(vc.apply_language_directive(None, "English"), "")


class TransferLine(unittest.TestCase):
    ENGLISH = "Please hold while I connect you."

    def test_spanish_and_german_lines(self):
        self.assertEqual(vc.transfer_message("Spanish"), "Por favor, espere un momento mientras le comunico.")
        self.assertEqual(vc.transfer_message("German"), "Einen Moment bitte, ich verbinde Sie.")
        self.assertEqual(vc.transfer_message("Spanish (MX)"), vc.transfer_message("Spanish"))
        self.assertEqual(vc.transfer_message("de"), vc.transfer_message("German"))

    def test_every_other_language_keeps_the_english_line(self):
        for language in (None, "", "English", "English (US)", "Urdu", "Urdu (PK)", "Multilingual", "French (FR)"):
            self.assertEqual(vc.transfer_message(language), self.ENGLISH, repr(language))

    def test_the_tool_payload_carries_the_line_and_nothing_else_changes(self):
        english = vc.build_transfer_tool_payload("Sales Bot", "+15551234567")
        self.assertEqual(english["destinations"][0]["message"], self.ENGLISH)
        for language in ("Spanish", "German"):
            tool = vc.build_transfer_tool_payload("Sales Bot", "+15551234567", language)
            self.assertEqual(tool["destinations"][0]["message"], vc.transfer_message(language))
            tool["destinations"][0]["message"] = self.ENGLISH
            self.assertEqual(tool, english, language)

    def test_the_call_without_a_language_still_works(self):
        self.assertEqual(vc.build_transfer_tool_payload("A", " +15551234567 "),
                         vc.build_transfer_tool_payload("A", "+15551234567", None))


class AssistantPayload(unittest.TestCase):
    def build(self, language, **kw):
        with patch.object(settings, "public_api_url", ""):
            return vc.build_assistant_payload(name="Agent", language=language, system_prompt="You are a receptionist.",
                                              first_message="Hola, gracias por llamar.", **kw)

    def test_spanish_assistant(self):
        p = self.build("Spanish", voice="Elliot")
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "es", "model": "nova-3"})
        self.assertEqual(p["voice"], vc._resolve_voice("Lucia"))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._SPANISH_DIRECTIVE + "You are a receptionist.")
        self.assertEqual(p["model"]["model"], "gpt-4o-mini")

    def test_german_assistant(self):
        p = self.build("German", voice="Lukas")
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "de", "model": "nova-3"})
        self.assertEqual(p["voice"], vc._resolve_voice("Lukas"))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._GERMAN_DIRECTIVE + "You are a receptionist.")

    def test_the_greeting_is_spoken_exactly_as_written(self):
        # The opening line is the agent's own text: it is never rewritten or translated here.
        for language in ("Spanish", "German", "English", "Urdu", "Multilingual"):
            self.assertEqual(self.build(language)["firstMessage"], "Hola, gracias por llamar.", language)

    def test_only_language_dependent_parts_differ_from_an_english_assistant(self):
        def without_language_parts(payload):
            return {k: v for k, v in payload.items() if k not in ("transcriber", "model")}

        english = without_language_parts(self.build("English", voice="Lucia"))
        for language in ("Spanish", "German"):
            self.assertEqual(without_language_parts(self.build(language, voice="Lucia")), english, language)

    def test_tools_are_attached_whatever_the_language(self):
        for language in ("Spanish", "German"):
            self.assertEqual(self.build(language, tool_ids=["t1", "t2"])["model"]["toolIds"], ["t1", "t2"])

    def test_existing_languages_build_the_same_assistant_as_before(self):
        english = self.build("English")
        self.assertEqual(english["voice"], {"provider": "vapi", "voiceId": "Elliot"})
        self.assertEqual(english["transcriber"], {"provider": "deepgram", "language": "en"})
        self.assertEqual(english["model"]["messages"][0]["content"], "You are a receptionist.")
        urdu = self.build("Urdu")
        self.assertEqual(urdu["transcriber"], {"provider": "deepgram", "language": "ur", "model": "nova-3"})
        self.assertEqual(urdu["voice"], vc._resolve_voice("Zara"))
        self.assertEqual(urdu["model"]["messages"][0]["content"], vc._URDU_SCRIPT_DIRECTIVE + "You are a receptionist.")
        multi = self.build("Multilingual")
        self.assertEqual(multi["transcriber"], {"provider": "deepgram", "language": "multi", "model": "nova-3"})
        self.assertEqual(multi["voice"], vc._resolve_voice("Zara"))


def ts_strings(source: str, name: str) -> list[str]:
    """The quoted strings of `export const <name> = [ ... ] as const;` in a TypeScript file."""
    m = re.search(rf"export const {name} = \[(.*?)\] as const;", source, re.S)
    assert m, f"could not find `export const {name}` — did the file's layout change?"
    return re.findall(r'"([^"]+)"', m.group(1))


def ts_object(text: str) -> dict:
    """{ a: "x", b: "y" } -> {"a": "x", "b": "y"} (string values only)."""
    return dict(re.findall(r'(\w+): "([^"]*)"', text))


class DashboardAgreesWithBackend(unittest.TestCase):
    """The dashboard keeps its own copies of the language list, the voice names and the voice
    blocks it previews with (a browser cannot import Python). They must say what this module says,
    or an agent would look one way on screen and sound another way on a call."""

    @classmethod
    def setUpClass(cls):
        cls.voices_ts = (NEXUS / "src/lib/voices.ts").read_text(encoding="utf-8")
        cls.languages_ts = (NEXUS / "src/lib/languages.ts").read_text(encoding="utf-8")
        cls.aivoices_tsx = (NEXUS / "src/pages/dashboard/AIVoices.tsx").read_text(encoding="utf-8")

    def test_every_language_the_form_offers_has_its_own_backend_code(self):
        found = re.findall(r'\{ value: "([^"]+)", label: "([^"]+)" \}', self.languages_ts)
        self.assertEqual([v for v, _ in found], ["English", "Urdu", "Spanish", "German", "Multilingual"])
        codes = [vc._resolve_language(v) for v, _ in found]
        self.assertEqual(codes, ["en", "ur", "es", "de", "multi"])

    def test_voice_names_are_the_backends_voices(self):
        groups = {name: ts_strings(self.voices_ts, name)
                  for name in ("VAPI_VOICE_NAMES", "URDU_VOICE_NAMES", "SPANISH_VOICE_NAMES", "GERMAN_VOICE_NAMES")}
        listed = [n.lower() for names in groups.values() for n in names]
        self.assertEqual(sorted(listed), sorted(vc._VOICE_REGISTRY))
        for n in groups["VAPI_VOICE_NAMES"]:
            self.assertEqual(vc._VOICE_REGISTRY[n.lower()], {"provider": "vapi", "voiceId": n})
        for group in ("URDU_VOICE_NAMES", "SPANISH_VOICE_NAMES", "GERMAN_VOICE_NAMES"):
            for n in groups[group]:
                self.assertEqual(vc._VOICE_REGISTRY[n.lower()]["provider"], "11labs", n)

    def test_the_default_voices_are_the_first_spanish_and_german_voices(self):
        spanish = ts_strings(self.voices_ts, "SPANISH_VOICE_NAMES")
        german = ts_strings(self.voices_ts, "GERMAN_VOICE_NAMES")
        self.assertEqual(spanish[0].lower(), vc._DEFAULT_VOICE_BY_LANGUAGE["es"])
        self.assertEqual(german[0].lower(), vc._DEFAULT_VOICE_BY_LANGUAGE["de"])

    def test_the_forms_multilingual_default_is_what_the_backend_uses_for_a_blank_voice(self):
        # The form moves a new Multilingual agent to the first Urdu voice; the backend has no
        # Multilingual entry of its own and falls back to this same voice when none is chosen.
        urdu = ts_strings(self.voices_ts, "URDU_VOICE_NAMES")
        self.assertIn("Multilingual: URDU_VOICE_NAMES[0]", self.languages_ts)
        self.assertEqual(vc._resolve_voice(urdu[0]), vc._resolve_voice(None, "Multilingual"))

    def test_the_voices_page_previews_with_exactly_what_a_call_uses(self):
        src = self.aivoices_tsx
        catalog = dict(re.findall(r'\{ id: \d+, name: "(\w+)", language: "(\w+)"', src))
        self.assertGreaterEqual(len(catalog), 19)
        transcribers = {name: ts_object(body) for name, body in re.findall(r"const (\w+_TRANSCRIBER) = (\{[^}]*\});", src)}
        blocks = {name: (ts_object(voice), transcribers[tr])
                  for name, voice, tr in re.findall(r"^\s+(\w+): \{ voice: (\{[^}]*\}), transcriber: (\w+) \},?$", src, re.M)}
        # Every voice on the page can be previewed, and nothing else can.
        self.assertEqual(sorted(blocks), sorted(n.lower() for n in catalog))
        self.assertEqual(sorted(blocks), sorted(vc._VOICE_REGISTRY))
        for name, language in catalog.items():
            voice, transcriber = blocks[name.lower()]
            self.assertEqual(voice, vc._resolve_voice(name, language), name)
            self.assertEqual(transcriber, vc._resolve_transcriber(language), name)


if __name__ == "__main__":
    unittest.main()
