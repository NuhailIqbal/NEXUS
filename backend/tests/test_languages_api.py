"""Spanish and German agents through the API: what is saved, and what is sent to the voice service
(transcriber, voice, language directive, transfer line) when an agent is created, edited, synced
or tested, plus proof that English, Urdu and Multilingual agents are sent exactly what they were.

The voice service is mocked (qa_harness.VapiMock) and the database is the scratch one, so nothing
real is created.

Run from the backend folder:  python -m unittest discover -s tests -p test_languages_api.py -v
"""
import unittest
from unittest.mock import AsyncMock, patch

import qa_harness as h
from qa_harness import client, auth
from config import settings
from database import supabase
from routers import agents as agents_router
from services import openai_client
from services import vapi_client as vc

PROMPT = "You are a receptionist."
NUMBER = "+15551234567"
ENGLISH_LINE = "Please hold while I connect you."


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()

    def tearDown(self):
        self.vapi.stop()

    def create(self, **body):
        body = {"name": "Lang Agent", "system_prompt": PROMPT, "first_message": "Hi", **body}
        r = client.post("/agents", json=body, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def edit(self, agent, **body):
        r = client.patch(f"/agents/{agent['id']}", json=body, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def row(self, agent):
        return supabase.table("ai_agents").select("*").eq("id", agent["id"]).single().execute().data

    def created(self):
        """Payload of the assistant created last."""
        return self.vapi.create_assistant.await_args.args[0]

    def patched(self):
        """Body of the assistant update sent last."""
        return self.vapi.update_assistant.await_args.args[1]

    def transfer_line_created(self):
        return self.vapi.create_tool.await_args.args[0]["destinations"][0]["message"]

    def transfer_line_updated(self):
        return self.vapi.update_tool.await_args.args[1]["destinations"][0]["message"]


class CreateSpanishAndGerman(Base):
    def test_spanish_agent_is_built_for_spanish(self):
        a = self.create(language="Spanish", voice="Elliot", first_message="Hola, gracias por llamar.")
        p = self.created()
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "es", "model": "nova-3"})
        # An English-only built-in voice cannot read Spanish, so the language's own default is used.
        self.assertEqual(p["voice"], vc._resolve_voice("Lucia"))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._SPANISH_DIRECTIVE + PROMPT)
        self.assertEqual(p["firstMessage"], "Hola, gracias por llamar.")
        self.assertTrue(a["vapi_assistant_id"])

    def test_german_agent_is_built_for_german(self):
        self.create(language="German", voice="Lukas", first_message="Hallo, danke für Ihren Anruf.")
        p = self.created()
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "de", "model": "nova-3"})
        self.assertEqual(p["voice"], vc._resolve_voice("Lukas"))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._GERMAN_DIRECTIVE + PROMPT)
        self.assertEqual(p["firstMessage"], "Hallo, danke für Ihren Anruf.")

    def test_no_voice_chosen_gets_the_languages_default(self):
        self.create(language="Spanish")
        self.assertEqual(self.created()["voice"], vc._resolve_voice("Lucia"))
        self.create(language="German")
        self.assertEqual(self.created()["voice"], vc._resolve_voice("Greta"))

    def test_the_label_is_saved_exactly_as_sent(self):
        # `language` is a free-text column: the form's labels are stored as they are and the
        # codes are only worked out when the voice service is told.
        for label in ("Spanish", "German", "English", "Urdu", "Multilingual", "English (US)", "Urdu (PK)", "Spanish (MX)"):
            a = self.create(language=label, name=f"Agent {label}")
            self.assertEqual(self.row(a)["language"], label)
            self.assertEqual(a["language"], label)

    def test_the_voice_chosen_is_saved_even_when_the_call_uses_the_languages_default(self):
        a = self.create(language="Spanish", voice="Elliot")
        self.assertEqual(self.row(a)["voice"], "Elliot")

    def test_the_stored_prompt_never_contains_the_directive(self):
        a = self.create(language="German")
        self.assertEqual(self.row(a)["system_prompt"], PROMPT)

    def test_a_transfer_number_gets_the_spoken_line_in_the_agents_language(self):
        for language, line in [("Spanish", vc.transfer_message("Spanish")), ("German", vc.transfer_message("German")),
                               ("English", ENGLISH_LINE), ("Urdu", ENGLISH_LINE), ("Multilingual", ENGLISH_LINE),
                               ("English (US)", ENGLISH_LINE)]:
            self.create(language=language, transfer_number=NUMBER)
            self.assertEqual(self.transfer_line_created(), line, language)


class CreateExistingLanguagesUnchanged(Base):
    def test_english_urdu_and_multilingual_send_what_they_always_did(self):
        with patch.object(settings, "public_api_url", "https://qa.example.test"):
            for label in ("English", "Urdu", "Multilingual", "English (US)", "Urdu (PK)"):
                self.create(language=label, voice="Elliot", name=f"Old {label}", first_message="Hi")
                expected = vc.build_assistant_payload(name=f"Old {label}", voice="Elliot", language=label,
                                                      system_prompt=PROMPT, first_message="Hi")
                self.assertEqual(self.created(), expected, label)

    def test_english_urdu_and_multilingual_pipelines(self):
        self.create(language="English", voice="Elliot")
        p = self.created()
        self.assertEqual((p["transcriber"], p["voice"], p["model"]["messages"][0]["content"]),
                         ({"provider": "deepgram", "language": "en"}, {"provider": "vapi", "voiceId": "Elliot"}, PROMPT))
        self.create(language="Urdu")
        p = self.created()
        self.assertEqual((p["transcriber"], p["voice"]),
                         ({"provider": "deepgram", "language": "ur", "model": "nova-3"}, vc._resolve_voice("Zara")))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._URDU_SCRIPT_DIRECTIVE + PROMPT)
        self.create(language="Multilingual", voice="Elliot")
        p = self.created()
        # Multilingual keeps whatever voice was chosen, English-only ones included, as before.
        self.assertEqual((p["transcriber"], p["voice"]),
                         ({"provider": "deepgram", "language": "multi", "model": "nova-3"}, {"provider": "vapi", "voiceId": "Elliot"}))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._MULTILINGUAL_DIRECTIVE + PROMPT)

    def test_legacy_spanish_and_german_labels_are_treated_as_those_languages(self):
        self.create(language="Spanish (ES)")
        self.assertEqual(self.created()["transcriber"]["language"], "es")
        self.assertTrue(self.created()["model"]["messages"][0]["content"].startswith(vc._SPANISH_DIRECTIVE))
        self.create(language="German (DE)")
        self.assertEqual(self.created()["transcriber"]["language"], "de")


class EditLanguage(Base):
    def test_switching_to_spanish_repoints_transcriber_voice_and_prompt(self):
        a = self.create(language="English", voice="Elliot")
        self.edit(a, language="Spanish")
        p = self.patched()
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "es", "model": "nova-3"})
        self.assertEqual(p["voice"], vc._resolve_voice("Lucia"))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._SPANISH_DIRECTIVE + PROMPT)
        self.assertEqual(self.row(a)["language"], "Spanish")

    def test_switching_to_german_and_back_to_english_restores_the_english_pipeline(self):
        a = self.create(language="English", voice="Elliot")
        self.edit(a, language="German")
        self.assertEqual(self.patched()["transcriber"]["language"], "de")
        self.edit(a, language="English")
        p = self.patched()
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "en"})
        self.assertEqual(p["voice"], {"provider": "vapi", "voiceId": "Elliot"})
        self.assertEqual(p["model"]["messages"][0]["content"], PROMPT)
        self.assertEqual(self.row(a)["language"], "English")

    def test_changing_only_the_voice_of_a_spanish_agent(self):
        a = self.create(language="Spanish", voice="Mateo")
        self.edit(a, voice="Elliot")
        self.assertEqual(self.patched()["voice"], vc._resolve_voice("Lucia"))
        self.edit(a, voice="Mateo")
        self.assertEqual(self.patched()["voice"], vc._resolve_voice("Mateo"))
        self.assertEqual(self.row(a)["voice"], "Mateo")

    def test_changing_only_the_prompt_keeps_the_directive(self):
        a = self.create(language="German")
        self.edit(a, system_prompt="You are a dentist's receptionist.")
        self.assertEqual(self.patched()["model"]["messages"][0]["content"],
                         vc._GERMAN_DIRECTIVE + "You are a dentist's receptionist.")

    def test_the_edit_form_resends_the_language_on_every_save(self):
        # The dashboard's edit form sends language and voice on every save: nothing about a
        # Spanish agent may change when they come back unchanged.
        a = self.create(language="Spanish", voice="Lucia")
        self.edit(a, name="Renamed", language="Spanish", voice="Lucia")
        p = self.patched()
        self.assertEqual(p["transcriber"]["language"], "es")
        self.assertEqual(p["voice"], vc._resolve_voice("Lucia"))
        self.assertEqual(self.row(a)["language"], "Spanish")


class EditTransferLine(Base):
    def test_switching_to_spanish_changes_the_transfer_line(self):
        a = self.create(language="English", transfer_number=NUMBER)
        tool_id = a["transfer_tool_id"]
        self.edit(a, language="Spanish")
        self.assertEqual(self.vapi.update_tool.await_args.args[0], tool_id)
        self.assertEqual(self.transfer_line_updated(), vc.transfer_message("Spanish"))
        self.assertEqual(self.vapi.update_tool.await_args.args[1]["destinations"][0]["number"], NUMBER)

    def test_switching_from_german_to_english_changes_it_back(self):
        a = self.create(language="German", transfer_number=NUMBER)
        self.edit(a, language="English")
        self.assertEqual(self.transfer_line_updated(), ENGLISH_LINE)

    def test_saving_the_same_language_again_leaves_the_tool_alone(self):
        a = self.create(language="Spanish", transfer_number=NUMBER)
        self.edit(a, language="Spanish", name="Renamed")
        self.vapi.update_tool.assert_not_awaited()

    def test_english_urdu_and_multilingual_share_a_line_so_switching_never_touches_the_tool(self):
        a = self.create(language="English", transfer_number=NUMBER)
        for label in ("Urdu", "Multilingual", "English (US)", "English"):
            self.edit(a, language=label)
        self.vapi.update_tool.assert_not_awaited()

    def test_an_agent_without_a_transfer_number_has_no_tool_to_update(self):
        a = self.create(language="English")
        self.edit(a, language="Spanish")
        self.vapi.update_tool.assert_not_awaited()
        self.vapi.create_tool.assert_not_awaited()

    def test_changing_the_number_and_the_language_together(self):
        a = self.create(language="English", transfer_number=NUMBER)
        self.edit(a, transfer_number="+15559876543", language="German")
        self.assertEqual(self.vapi.update_tool.await_count, 1)
        sent = self.vapi.update_tool.await_args.args[1]["destinations"][0]
        self.assertEqual((sent["number"], sent["message"]), ("+15559876543", vc.transfer_message("German")))

    def test_changing_only_the_number_keeps_the_agents_language_line(self):
        a = self.create(language="Spanish", transfer_number=NUMBER)
        self.edit(a, transfer_number="+15559876543")
        self.assertEqual(self.transfer_line_updated(), vc.transfer_message("Spanish"))

    def test_a_failed_tool_update_is_reported_and_nothing_is_saved(self):
        a = self.create(language="English", transfer_number=NUMBER)
        self.vapi.update_tool.side_effect = RuntimeError("voice service down")
        r = client.patch(f"/agents/{a['id']}", json={"language": "Spanish"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 502)
        self.assertEqual(self.row(a)["language"], "English")
        self.vapi.update_assistant.assert_not_awaited()


class SyncAndTest(Base):
    def test_sync_builds_a_german_assistant_and_transfer_tool_for_an_agent_without_one(self):
        row = supabase.table("ai_agents").insert({
            "user_id": self.user, "name": "Direct", "language": "German", "voice": "Elliot",
            "system_prompt": PROMPT, "first_message": "Hallo", "transfer_number": NUMBER, "status": "Active",
        }).execute().data[0]
        r = client.post(f"/agents/{row['id']}/sync-vapi", headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.transfer_line_created(), vc.transfer_message("German"))
        p = self.created()
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "de", "model": "nova-3"})
        self.assertEqual(p["voice"], vc._resolve_voice("Greta"))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._GERMAN_DIRECTIVE + PROMPT)

    def test_the_live_voice_test_uses_the_language(self):
        r = client.post("/agents/test-voice/start", headers=auth(self.user), json={
            "name": "Trial", "language": "Spanish", "voice": "Naina", "system_prompt": PROMPT, "first_message": "Hola"})
        self.assertEqual(r.status_code, 200, r.text)
        p = self.created()
        self.assertEqual(p["name"], "[test] Trial")
        self.assertEqual(p["transcriber"], {"provider": "deepgram", "language": "es", "model": "nova-3"})
        self.assertEqual(p["voice"], vc._resolve_voice("Lucia"))
        self.assertEqual(p["model"]["messages"][0]["content"], vc._SPANISH_DIRECTIVE + PROMPT)
        self.assertEqual(p["firstMessage"], "Hola")

    def test_editing_a_library_event_keeps_the_directive_on_a_spanish_agent(self):
        # Changing an event the agent uses re-sends the agent's whole prompt: the language
        # rules must still be on it afterwards.
        ev = client.post("/call-events", json={"label": "Interested"}, headers=auth(self.user)).json()["data"]
        self.create(language="Spanish", call_events=[{"event_id": ev["id"]}])
        self.vapi.update_assistant.reset_mock()
        client.patch(f"/call-events/{ev['id']}", json={"description": "brand new wording"}, headers=auth(self.user))
        content = self.patched()["model"]["messages"][0]["content"]
        self.assertTrue(content.startswith(vc._SPANISH_DIRECTIVE))
        self.assertIn("brand new wording", content)

    def test_an_events_agent_keeps_the_directive_on_create(self):
        ev = client.post("/call-events", json={"label": "Interested"}, headers=auth(self.user)).json()["data"]
        self.create(language="German", call_events=[{"event_id": ev["id"]}])
        content = self.created()["model"]["messages"][0]["content"]
        self.assertTrue(content.startswith(vc._GERMAN_DIRECTIVE))
        self.assertIn("CALL EVENTS", content)


class TextTest(Base):
    """The wizard's quick text test follows the agent's language like a real call does."""

    def test_the_router_passes_the_language_on(self):
        with patch.object(settings, "openai_api_key", "test-key"), \
                patch.object(agents_router, "chat_reply", AsyncMock(return_value="hola")) as chat:
            r = client.post("/agents/test", headers=auth(self.user),
                            json={"message": "hi", "system_prompt": PROMPT, "first_message": "Hola", "language": "Spanish"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(chat.await_args.args, (PROMPT, "hi", "Hola", "Spanish"))

    def test_an_older_client_that_sends_no_language_still_works(self):
        with patch.object(settings, "openai_api_key", "test-key"), \
                patch.object(agents_router, "chat_reply", AsyncMock(return_value="hello")) as chat:
            r = client.post("/agents/test", headers=auth(self.user), json={"message": "hi"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(chat.await_args.args, (None, "hi", None, None))

    def system_message_sent(self, language):
        """Run chat_reply against a fake OpenAI and return the system message it sent."""
        sent = {}

        class FakeResponse:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {"choices": [{"message": {"content": " reply "}}]}

        class FakeClient:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def post(self, url, headers=None, json=None):
                sent["messages"] = json["messages"]
                return FakeResponse()

        async def run():
            with patch.object(settings, "openai_api_key", "test-key"), \
                    patch.object(openai_client.httpx, "AsyncClient", FakeClient):
                return await openai_client.chat_reply(PROMPT, "hello", "Hi there", language)

        import asyncio
        self.assertEqual(asyncio.run(run()), "reply")
        return sent["messages"][0]["content"]

    def test_spanish_and_german_replies_get_the_language_rules(self):
        self.assertTrue(self.system_message_sent("Spanish").startswith(vc._SPANISH_DIRECTIVE.strip()))
        self.assertTrue(self.system_message_sent("German").startswith(vc._GERMAN_DIRECTIVE.strip()))
        self.assertIn(PROMPT, self.system_message_sent("Spanish"))

    def test_english_and_no_language_are_exactly_what_they_were(self):
        none = self.system_message_sent(None)
        self.assertEqual(self.system_message_sent("English"), none)
        self.assertEqual(self.system_message_sent("English (US)"), none)
        self.assertTrue(none.startswith(PROMPT))
        self.assertNotIn("LANGUAGE (MUST FOLLOW)", none)


if __name__ == "__main__":
    unittest.main()
