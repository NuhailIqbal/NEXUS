import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from services import call_events as ce
from services import callback_service as cbs

KHI = "Asia/Karachi"


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()
        cbs.save_settings(self.user, {"timezone": KHI})
        self.cb_event = self.make_event("Callback Requested", schedules_callback=True)
        self.plain_event = self.make_event("Interested")
        self.agent = h.create_agent_via_api(self.user, name="Sara", call_events=[{"event_id": self.cb_event["id"]}, {"event_id": self.plain_event["id"]}])
        self.asst = self.agent["vapi_assistant_id"]
        self.call = f"call-{h.uuid.uuid4().hex[:8]}"
        self._n = 0

    def tearDown(self):
        self.vapi.stop()

    def make_event(self, label, user=None, **kw):
        r = client.post("/call-events", json={"label": label, **kw}, headers=auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def fire(self, event="callback_requested", args=None, call=None, phone="+15551230001", call_type="inboundPhoneCall", tcid=None, asst=None):
        self._n += 1
        a = {"event": event, **(args or {})}
        body = {"message": {"type": "tool-calls",
                            "call": {"id": call or self.call, "type": call_type, "assistantId": asst or self.asst,
                                     **({"customer": {"number": phone}} if phone else {})},
                            "toolCalls": [{"id": tcid or f"tc-{self._n}", "function": {"name": "trigger_event", "arguments": a}}]}}
        r = client.post("/tools/internal/trigger-event", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["results"][0]["result"]

    def rows(self, user=None):
        return supabase.table("callbacks").select("*").eq("user_id", user or self.user).order("created_at").execute().data

    def local(self, row):
        return datetime.fromisoformat(row["due_at"]).astimezone(ZoneInfo(row["timezone"])).strftime("%H:%M")

    def member(self, role):
        m = h.make_user("m")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": m, "member_email": f"m-{h.uuid.uuid4().hex[:8]}@qa.test",
                                               "role": role, "status": "Active"}).execute()
        return m

    def put(self, **kw):
        return client.patch("/callbacks/settings", json=kw, headers=auth(self.user))


class EventFlag(Base):
    def test_E01_library_event_can_carry_the_flag(self):
        self.assertTrue(self.cb_event["schedules_callback"])
        self.assertFalse(self.plain_event["schedules_callback"])
        lib = {e["event_key"]: e for e in client.get("/call-events", headers=auth(self.user)).json()["data"]}
        self.assertTrue(lib["callback_requested"]["schedules_callback"])

    def test_E02_flag_can_be_edited_and_reaches_agents(self):
        r = client.patch(f"/call-events/{self.plain_event['id']}", json={"schedules_callback": True}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        row = [e for e in ce.get_events(self.agent["id"]) if e["event_key"] == "interested"][0]
        self.assertTrue(row["schedules_callback"])
        client.patch(f"/call-events/{self.plain_event['id']}", json={"schedules_callback": False}, headers=auth(self.user))
        self.assertFalse([e for e in ce.get_events(self.agent["id"]) if e["event_key"] == "interested"][0]["schedules_callback"])

    def test_E03_editing_something_else_keeps_the_flag(self):
        client.patch(f"/call-events/{self.cb_event['id']}", json={"outcome": "Call later"}, headers=auth(self.user))
        self.assertTrue(ce.get_library_event(self.user, self.cb_event["id"])["schedules_callback"])

    def test_E04_the_name_based_agent_form_can_set_it_on_new_events(self):
        a = h.create_agent_via_api(self.user, name="Other", call_events=[{"label": "Call Me Later", "schedules_callback": True}])
        self.assertTrue(ce.get_events(a["id"])[0]["schedules_callback"])

    def test_E05_tool_offers_the_optional_day_and_time_parameters(self):
        props = ce.tool_payload("x", ce.get_events(self.agent["id"]))["function"]["parameters"]
        self.assertEqual(props["required"], ["event"])                      # still only the event is mandatory
        self.assertIn("callback_in_days", props["properties"])
        self.assertIn("callback_time", props["properties"])

    def test_E06_directive_mentions_callbacks_only_for_flagged_events(self):
        d = ce.prompt_directive(ce.get_events(self.agent["id"]))
        lines = {l.split(":")[0].lstrip("- "): l for l in d.splitlines() if l.startswith("- ")}
        self.assertIn("callback_in_days", lines["callback_requested"])
        self.assertIn("24-hour", lines["callback_requested"])
        self.assertNotIn("callback_in_days", lines["interested"])


class RecordingCallbacks(Base):
    def test_K01_the_callers_time_becomes_a_callback(self):
        res = self.fire(args={"callback_in_days": 1, "callback_time": "17:00", "note": "kal shaam 5 baje"})
        self.assertIn("recorded", res)
        cb = self.rows()[0]
        self.assertEqual((cb["status"], cb["time_source"], cb["phone"], cb["timezone"], self.local(cb)), ("pending", "caller", "+15551230001", KHI, "17:00"))
        self.assertEqual((cb["agent_id"], cb["vapi_call_id"]), (self.agent["id"], self.call))
        self.assertIn("kal shaam 5 baje", cb["requested_text"])
        tomorrow = (datetime.now(ZoneInfo(KHI)) + timedelta(days=1)).date()
        self.assertEqual(datetime.fromisoformat(cb["due_at"]).astimezone(ZoneInfo(KHI)).date(), tomorrow)

    def test_K02_no_time_given_uses_the_default_and_says_so(self):
        self.fire(args={"note": "baad mein"})
        cb = self.rows()[0]
        self.assertEqual((cb["time_source"], self.local(cb)), ("default", "10:00"))
        self.assertIn("no time", cb["requested_text"])

    def test_K03_unusable_values_never_break_the_event(self):
        res = self.fire(args={"callback_in_days": "soon", "callback_time": "five pm"})
        self.assertIn("recorded", res)
        self.assertEqual(self.rows()[0]["time_source"], "default")

    def test_K04_events_that_do_not_schedule_callbacks_create_none(self):
        self.fire("interested", args={"callback_time": "17:00"})
        self.assertEqual(self.rows(), [])

    def test_K05_ignored_events_create_none(self):
        client.patch(f"/call-events/{self.cb_event['id']}", json={"applies_to": "outbound"}, headers=auth(self.user))
        res = self.fire(args={"callback_time": "17:00"}, call_type="inboundPhoneCall")
        self.assertIn("not enabled", res)
        self.assertEqual(self.rows(), [])

    def test_K06_a_retried_tool_call_makes_one_callback(self):
        self.fire(args={"callback_time": "17:00"}, tcid="same")
        self.fire(args={"callback_time": "17:00"}, tcid="same")
        self.assertEqual(len(self.rows()), 1)

    def test_K07_a_newer_request_from_the_same_caller_replaces_the_old_one(self):
        self.fire(args={"callback_in_days": 1, "callback_time": "10:00"}, tcid="a")
        self.fire(args={"callback_in_days": 2, "callback_time": "15:00"}, tcid="b")
        rows = self.rows()
        self.assertEqual([r["status"] for r in rows], ["cancelled", "pending"])
        self.assertIn("Replaced", rows[0]["last_error"])
        self.assertEqual(self.local(rows[1]), "15:00")

    def test_K08_different_callers_keep_their_own_callbacks(self):
        self.fire(args={"callback_time": "17:00"}, phone="+15551230001", call="c1")
        self.fire(args={"callback_time": "17:00"}, phone="+15551230002", call="c2")
        self.assertEqual([r["status"] for r in self.rows()], ["pending", "pending"])

    def test_K09_a_known_contact_is_linked(self):
        c = supabase.table("contacts").insert({"user_id": self.user, "name": "Ali Khan", "phone": "+15551230001"}).execute().data[0]
        self.fire(args={"callback_time": "17:00"})
        cb = self.rows()[0]
        self.assertEqual((cb["contact_id"], cb["contact_name"]), (c["id"], "Ali Khan"))

    def test_K10_a_call_without_a_phone_is_recorded_then_completed_at_hangup(self):
        self.fire(args={"callback_time": "17:00"}, phone=None, call_type="webCall")
        self.assertIsNone(self.rows()[0]["phone"])
        conv = h.make_conversation(self.user, self.call, self.agent["id"], phone="+15557770000")
        ce.finalize_call_events(self.call, conv["id"])
        cb = self.rows()[0]
        self.assertEqual((cb["phone"], cb["conversation_id"]), ("+15557770000", conv["id"]))

    def test_K11_hangup_does_not_overwrite_a_known_phone(self):
        self.fire(args={"callback_time": "17:00"})
        conv = h.make_conversation(self.user, self.call, self.agent["id"], phone="+15559990000")
        ce.finalize_call_events(self.call, conv["id"])
        self.assertEqual(self.rows()[0]["phone"], "+15551230001")

    def test_K12_a_scheduling_failure_never_loses_the_event(self):
        with patch.object(cbs, "schedule_from_event", side_effect=RuntimeError("db hiccup")):
            res = self.fire(args={"callback_time": "17:00"})
        self.assertIn("recorded", res)
        self.assertEqual(len(ce.get_hits(self.call)), 1)

    def test_K13_callbacks_use_the_accounts_timezone_setting(self):
        cbs.save_settings(self.user, {"timezone": "America/New_York", "start_time": "08:00", "default_time": "10:00"})
        self.fire(args={"callback_in_days": 1, "callback_time": "17:00"})
        cb = self.rows()[0]
        self.assertEqual((cb["timezone"], self.local(cb)), ("America/New_York", "17:00"))

    def test_K14_unknown_assistant_creates_nothing(self):
        self.fire(args={"callback_time": "17:00"}, asst="asst-nope")
        self.assertEqual(self.rows(), [])

    def test_K15_deleting_the_agent_keeps_the_callback(self):
        self.fire(args={"callback_time": "17:00"})
        client.delete(f"/agents/{self.agent['id']}", headers=auth(self.user))
        cb = self.rows()[0]
        self.assertIsNone(cb["agent_id"])


class CallbacksApi(Base):
    def setUp(self):
        super().setUp()
        self.fire(args={"callback_in_days": 1, "callback_time": "17:00", "note": "kal 5"})
        self.cb = self.rows()[0]

    def get(self, path="/callbacks", user=None):
        return client.get(path, headers=auth(user or self.user))

    def patch_cb(self, body, cb_id=None, user=None):
        return client.patch(f"/callbacks/{cb_id or self.cb['id']}", json=body, headers=auth(user or self.user))

    def test_L01_list_with_agent_name_and_counts(self):
        r = self.get().json()
        self.assertEqual([(c["phone"], c["agent_name"], c["status"]) for c in r["data"]], [("+15551230001", "Sara", "pending")])
        self.assertEqual(r["meta"]["counts"]["pending"], 1)
        self.assertEqual(r["meta"]["counts"]["called"], 0)

    def test_L02_status_filter(self):
        self.assertEqual(len(self.get("/callbacks?status=pending").json()["data"]), 1)
        self.assertEqual(self.get("/callbacks?status=called").json()["data"], [])
        self.assertEqual(self.get("/callbacks?status=bogus").status_code, 400)

    def test_L03_list_is_per_account(self):
        other = h.make_user()
        self.assertEqual(self.get(user=other).json()["data"], [])

    def test_L04_requires_login(self):
        self.assertIn(client.get("/callbacks").status_code, (401, 403))
        self.assertIn(client.patch(f"/callbacks/{self.cb['id']}", json={"status": "cancelled"}).status_code, (401, 403))

    def test_L05_members_see_the_owners_callbacks(self):
        self.assertEqual(len(self.get(user=self.member("member")).json()["data"]), 1)
        self.assertEqual(len(self.get(user=self.member("viewer")).json()["data"]), 1)

    def test_L10_reschedule_interprets_the_time_in_the_callbacks_timezone(self):
        when = (datetime.now(ZoneInfo(KHI)) + timedelta(days=3)).replace(hour=14, minute=15, second=0, microsecond=0)
        r = self.patch_cb({"due_local": when.strftime("%Y-%m-%dT%H:%M")})
        self.assertEqual(r.status_code, 200, r.text)
        row = r.json()["data"]
        self.assertEqual((row["status"], row["time_source"], row["attempts"]), ("pending", "manual", 0))
        self.assertEqual(self.local(row), "14:15")

    def test_L11_reschedule_accepts_an_explicit_offset(self):
        when = datetime.now(timezone.utc) + timedelta(days=2)
        r = self.patch_cb({"due_local": when.replace(microsecond=0).isoformat()})
        self.assertEqual(r.status_code, 200)

    def test_L12_bad_times_are_refused(self):
        past = (datetime.now(ZoneInfo(KHI)) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M")
        far = (datetime.now(ZoneInfo(KHI)) + timedelta(days=120)).strftime("%Y-%m-%dT%H:%M")
        for bad in (past, far, "tomorrow", "", "2026-13-45T99:99"):
            self.assertEqual(self.patch_cb({"due_local": bad}).status_code, 400, bad)
        self.assertEqual(self.rows()[0]["due_at"], self.cb["due_at"])

    def test_L13_cancel_and_mark_done(self):
        self.assertEqual(self.patch_cb({"status": "cancelled"}).json()["data"]["status"], "cancelled")
        self.assertEqual(self.patch_cb({"due_local": (datetime.now(ZoneInfo(KHI)) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")}).json()["data"]["status"], "pending")   # can be revived
        self.assertEqual(self.patch_cb({"status": "called"}).json()["data"]["status"], "called")

    def test_L14_only_cancelled_or_called_can_be_set(self):
        for bad in ("pending", "failed", "calling", "whatever"):
            self.assertEqual(self.patch_cb({"status": bad}).status_code, 422, bad)

    def test_L15_send_exactly_one_of_time_or_status(self):
        self.assertEqual(self.patch_cb({}).status_code, 400)
        self.assertEqual(self.patch_cb({"status": "cancelled", "due_local": "2030-01-01T10:00"}).status_code, 400)

    def test_L16_already_placed_or_in_progress_cannot_be_changed(self):
        for st in ("called", "calling"):
            supabase.table("callbacks").update({"status": st}).eq("id", self.cb["id"]).execute()
            self.assertEqual(self.patch_cb({"status": "cancelled"}).status_code, 409, st)
            self.assertEqual(self.patch_cb({"due_local": (datetime.now(ZoneInfo(KHI)) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")}).status_code, 409, st)

    def test_L17_a_failed_callback_can_be_rescheduled_and_resets_attempts(self):
        supabase.table("callbacks").update({"status": "failed", "attempts": 2, "last_error": "boom"}).eq("id", self.cb["id"]).execute()
        row = self.patch_cb({"due_local": (datetime.now(ZoneInfo(KHI)) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")}).json()["data"]
        self.assertEqual((row["status"], row["attempts"], row["last_error"]), ("pending", 0, None))

    def test_L18_other_accounts_and_bad_ids_get_404(self):
        other = h.make_user()
        self.assertEqual(self.patch_cb({"status": "cancelled"}, user=other).status_code, 404)
        self.assertEqual(self.patch_cb({"status": "cancelled"}, cb_id=str(h.uuid.uuid4())).status_code, 404)
        self.assertEqual(self.patch_cb({"status": "cancelled"}, cb_id="not-a-uuid").status_code, 404)
        self.assertEqual(self.rows()[0]["status"], "pending")

    def test_L19_viewers_cannot_edit_members_can(self):
        self.assertEqual(self.patch_cb({"status": "cancelled"}, user=self.member("viewer")).status_code, 403)
        self.assertEqual(self.patch_cb({"status": "cancelled"}, user=self.member("member")).status_code, 200)


class SettingsApi(Base):
    def test_S01_defaults_for_a_new_account(self):
        other = h.make_user()
        s = client.get("/callbacks/settings", headers=auth(other)).json()["data"]
        self.assertEqual((s["auto_call"], s["timezone"], s["max_attempts"]), (False, "UTC", 2))

    def test_S02_owner_updates_and_it_persists(self):
        r = self.put(auto_call=True, timezone="Europe/London", start_time="08:30", end_time="17:30", default_time="09:00", retry_minutes=20, max_attempts=3, work_days=[0, 1, 2])
        self.assertEqual(r.status_code, 200, r.text)
        s = client.get("/callbacks/settings", headers=auth(self.user)).json()["data"]
        self.assertEqual((s["auto_call"], s["timezone"], s["work_days"], s["max_attempts"]), (True, "Europe/London", [0, 1, 2], 3))

    def test_S03_auto_call_is_off_until_someone_turns_it_on(self):
        self.assertFalse(cbs.get_settings(self.user)["auto_call"])
        self.put(timezone="Europe/London")
        self.assertFalse(cbs.get_settings(self.user)["auto_call"])

    def test_S04_invalid_values_are_400_and_change_nothing(self):
        for bad in ({"timezone": "Nope"}, {"work_days": []}, {"start_time": "99:00"}, {"end_time": "08:00"}, {"retry_minutes": 1}, {"max_attempts": 9}, {"default_time": "03:00"}):
            self.assertEqual(self.put(**bad).status_code, 400, bad)
        self.assertEqual(cbs.get_settings(self.user)["timezone"], KHI)

    def test_S05_wrong_types_are_422(self):
        for bad in ({"auto_call": "yes"}, {"retry_minutes": "soon"}, {"work_days": "mon"}):
            self.assertEqual(self.put(**bad).status_code, 422, bad)

    def test_S06_only_the_owner_may_change_settings(self):
        for role in ("member", "viewer"):
            r = client.patch("/callbacks/settings", json={"auto_call": True}, headers=auth(self.member(role)))
            self.assertEqual(r.status_code, 403, role)
        self.assertFalse(cbs.get_settings(self.user)["auto_call"])

    def test_S07_members_can_read_the_owners_settings(self):
        self.assertEqual(client.get("/callbacks/settings", headers=auth(self.member("member"))).json()["data"]["timezone"], KHI)

    def test_S08_settings_are_per_account(self):
        other = h.make_user()
        self.put(auto_call=True)
        self.assertFalse(cbs.get_settings(other)["auto_call"])

    def test_S10_a_short_name_like_EST_is_saved_as_the_real_region(self):
        self.assertEqual(self.put(timezone="EST").json()["data"]["timezone"], "America/New_York")
        self.assertEqual(cbs.get_settings(self.user)["timezone"], "America/New_York")

    def test_S09_empty_patch_is_harmless_and_repeatable(self):
        self.assertEqual(self.put().status_code, 200)
        self.assertEqual(self.put(timezone=KHI).status_code, 200)
        self.assertEqual(h.sql("select count(*) from callback_settings where user_id=%s", (self.user,))[0][0], 1)


class Migration(unittest.TestCase):
    def test_M01_tables_and_constraints(self):
        cols = {r[0] for r in h.sql("select column_name from information_schema.columns where table_name='callbacks'")}
        self.assertTrue({"due_at", "timezone", "time_source", "status", "attempts", "placed_call_id", "phone", "tool_call_id"} <= cols)
        with self.assertRaises(Exception):
            u = h.make_user()
            h.sql("insert into callbacks(user_id, due_at, status) values(%s, now(), 'weird')", (u,))
        with self.assertRaises(Exception):
            u = h.make_user()
            h.sql("insert into callbacks(user_id, due_at, time_source) values(%s, now(), 'weird')", (u,))

    def test_M02_flag_columns_default_false(self):
        u = h.make_user()
        h.sql("insert into call_event_library(user_id,event_key,label) values(%s,'k','K')", (u,))
        self.assertFalse(h.sql("select schedules_callback from call_event_library where user_id=%s", (u,))[0][0])

    def test_M03_deleting_the_account_removes_its_callbacks_and_settings(self):
        u = h.make_user()
        h.sql("insert into callbacks(user_id, due_at) values(%s, now())", (u,))
        h.sql("insert into callback_settings(user_id) values(%s)", (u,))
        h.sql("delete from users where id=%s", (u,))
        self.assertEqual(h.sql("select count(*) from callbacks where user_id=%s", (u,))[0][0], 0)
        self.assertEqual(h.sql("select count(*) from callback_settings where user_id=%s", (u,))[0][0], 0)


if __name__ == "__main__":
    unittest.main()
