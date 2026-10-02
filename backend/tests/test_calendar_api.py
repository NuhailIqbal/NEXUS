import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from jose import jwt

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from config import settings
from routers import calendar as cal_router
from services import calendar_service as cal
from services.encryption import decrypt_config
from fake_google import FakeGoogle


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.g = FakeGoogle().start()
        cal._token_cache.clear()
        self.user = h.make_user()
        self.patches = [
            patch.object(settings, "google_client_id", "cid-123"),
            patch.object(settings, "google_client_secret", "secret-456"),
            patch.object(settings, "google_redirect_uri", ""),
            patch.object(settings, "public_app_url", "https://app.qa.test"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.g.stop()

    def connect(self, tz="Asia/Karachi", user=None):
        """Run the real connect -> callback flow and return the callback response."""
        uid = user or self.user
        state = cal_router._make_state(uid, tz)
        return client.get("/calendar/google/callback", params={"code": "good", "state": state}, follow_redirects=False)

    def member(self, role):
        m = h.make_user("m")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": m, "member_email": f"m-{h.uuid.uuid4().hex[:8]}@qa.test",
                                               "role": role, "status": "Active"}).execute()
        return m


class Status(Base):
    def test_A01_not_connected(self):
        d = client.get("/calendar/status", headers=auth(self.user)).json()["data"]
        self.assertEqual((d["configured"], d["connected"], d["email"]), (True, False, None))
        self.assertEqual(d["settings"]["slot_minutes"], 30)

    def test_A02_unconfigured_server_is_reported(self):
        with patch.object(settings, "google_client_id", ""):
            d = client.get("/calendar/status", headers=auth(self.user)).json()["data"]
        self.assertFalse(d["configured"])

    def test_A03_connected_status_has_email_and_never_the_token(self):
        self.connect()
        r = client.get("/calendar/status", headers=auth(self.user))
        d = r.json()["data"]
        self.assertEqual((d["connected"], d["email"], d["status"]), (True, "owner@gmail.com", "connected"))
        self.assertNotIn("rt-good", r.text)
        self.assertNotIn("refresh_token", r.text)

    def test_A03b_status_shows_the_redirect_uri_for_setup_but_never_a_secret(self):
        r = client.get("/calendar/status", headers=auth(self.user))
        self.assertEqual(r.json()["data"]["redirect_uri"], settings.active_google_redirect_uri)
        with patch.object(settings, "google_redirect_uri", "https://api.qa.test/cb"):
            self.assertEqual(client.get("/calendar/status", headers=auth(self.user)).json()["data"]["redirect_uri"], "https://api.qa.test/cb")
        self.assertNotIn("secret-456", r.text)
        self.assertNotIn(settings.google_client_secret, r.text)

    def test_A04_requires_login(self):
        self.assertIn(client.get("/calendar/status").status_code, (401, 403))

    def test_A05_status_is_per_account(self):
        self.connect()
        other = h.make_user()
        self.assertFalse(client.get("/calendar/status", headers=auth(other)).json()["data"]["connected"])

    def test_A06_member_sees_the_owners_calendar_status(self):
        self.connect()
        self.assertTrue(client.get("/calendar/status", headers=auth(self.member("member"))).json()["data"]["connected"])


class ConnectUrl(Base):
    def test_B01_builds_a_google_url_with_everything_we_need(self):
        r = client.get("/calendar/google/connect-url", params={"tz": "Asia/Karachi"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        u = urlparse(r.json()["data"]["url"])
        q = parse_qs(u.query)
        self.assertEqual(u.netloc, "accounts.google.com")
        self.assertEqual(q["client_id"], ["cid-123"])
        self.assertEqual(q["access_type"], ["offline"])
        self.assertEqual(q["prompt"], ["consent"])
        self.assertEqual(q["redirect_uri"], [settings.active_google_redirect_uri])
        scopes = q["scope"][0].split()
        self.assertIn("https://www.googleapis.com/auth/calendar.events", scopes)
        self.assertIn("https://www.googleapis.com/auth/calendar.freebusy", scopes)
        self.assertNotIn("https://www.googleapis.com/auth/calendar", scopes)       # never the full-access scope

    def test_B02_redirect_uri_override(self):
        with patch.object(settings, "google_redirect_uri", "https://api.qa.test/cb"):
            q = parse_qs(urlparse(client.get("/calendar/google/connect-url", headers=auth(self.user)).json()["data"]["url"]).query)
        self.assertEqual(q["redirect_uri"], ["https://api.qa.test/cb"])

    def test_B03_state_is_a_signed_short_lived_token_for_this_owner(self):
        url = client.get("/calendar/google/connect-url", params={"tz": "Asia/Karachi"}, headers=auth(self.user)).json()["data"]["url"]
        claims = jwt.decode(parse_qs(urlparse(url).query)["state"][0], settings.active_jwt_secret, algorithms=["HS256"])
        self.assertEqual((claims["sub"], claims["tz"], claims["typ"]), (self.user, "Asia/Karachi", "gcal_oauth"))
        self.assertLessEqual(claims["exp"] - time.time(), 601)

    def test_B04_invalid_timezone_falls_back_to_utc(self):
        url = client.get("/calendar/google/connect-url", params={"tz": "Nope/Nope"}, headers=auth(self.user)).json()["data"]["url"]
        self.assertEqual(jwt.decode(parse_qs(urlparse(url).query)["state"][0], settings.active_jwt_secret, algorithms=["HS256"])["tz"], "UTC")

    def test_B05_unconfigured_server_returns_503_with_a_clear_message(self):
        with patch.object(settings, "google_client_secret", ""):
            r = client.get("/calendar/google/connect-url", headers=auth(self.user))
        self.assertEqual(r.status_code, 503)
        self.assertIn("isn't set up", r.json()["detail"])

    def test_B06_only_the_owner_can_start_a_connection(self):
        for role in ("member", "viewer"):
            r = client.get("/calendar/google/connect-url", headers=auth(self.member(role)))
            self.assertEqual(r.status_code, 403, role)

    def test_B07_requires_login(self):
        self.assertIn(client.get("/calendar/google/connect-url").status_code, (401, 403))


class Callback(Base):
    def loc(self, r):
        return r.headers["location"]

    def test_D01_success_stores_connection_and_redirects_home(self):
        r = self.connect()
        self.assertEqual(r.status_code, 302)
        self.assertEqual(self.loc(r), "https://app.qa.test/dashboard/integrations?calendar=connected")
        row = cal.get_connection(self.user)
        self.assertEqual((row["email"], row["status"], row["calendar_id"]), ("owner@gmail.com", "connected", "primary"))
        self.assertEqual(row["settings"]["timezone"], "Asia/Karachi")          # from the browser, via state

    def test_D02_refresh_token_is_encrypted_at_rest(self):
        self.connect()
        raw = h.sql("select refresh_token_encrypted from calendar_connections where user_id=%s", (self.user,))[0][0]
        self.assertNotIn("rt-good", raw)
        self.assertEqual(decrypt_config(raw)["refresh_token"], "rt-good")

    def test_D03_reconnecting_keeps_settings_and_clears_reauth(self):
        self.connect()
        client.patch("/calendar/settings", json={"slot_minutes": 45, "end_time": "18:00"}, headers=auth(self.user))
        supabase.table("calendar_connections").update({"status": "reauth_required"}).eq("user_id", self.user).execute()
        self.connect()
        row = cal.get_connection(self.user)
        self.assertEqual((row["status"], row["settings"]["slot_minutes"], row["settings"]["end_time"]), ("connected", 45, "18:00"))
        self.assertEqual(h.sql("select count(*) from calendar_connections where user_id=%s", (self.user,))[0][0], 1)

    def test_D04_user_denied_consent(self):
        state = cal_router._make_state(self.user, "UTC")
        r = client.get("/calendar/google/callback", params={"error": "access_denied", "state": state}, follow_redirects=False)
        self.assertTrue(self.loc(r).endswith("calendar=denied"))
        self.assertIsNone(cal.get_connection(self.user))

    def test_D05_missing_code(self):
        r = client.get("/calendar/google/callback", params={"state": cal_router._make_state(self.user, "UTC")}, follow_redirects=False)
        self.assertTrue(self.loc(r).endswith("calendar=denied"))

    def test_D06_forged_tampered_or_missing_state_is_rejected(self):
        good = cal_router._make_state(self.user, "UTC")
        for state in (None, "", "garbage", good[:-3] + "abc", jwt.encode({"sub": self.user, "typ": "gcal_oauth"}, "wrong-secret", "HS256")):
            r = client.get("/calendar/google/callback", params={"code": "good", **({"state": state} if state is not None else {})}, follow_redirects=False)
            self.assertIn("calendar=error&reason=state", self.loc(r), repr(state))
        self.assertIsNone(cal.get_connection(self.user))
        self.assertEqual(self.g.refresh_calls, 0)
        self.assertFalse([1 for m, u in self.g.requests if u.endswith("/token")])      # never even called Google

    def test_D07_expired_state_is_rejected(self):
        old = jwt.encode({"sub": self.user, "tz": "UTC", "typ": "gcal_oauth", "exp": int(time.time()) - 5}, settings.active_jwt_secret, "HS256")
        r = client.get("/calendar/google/callback", params={"code": "good", "state": old}, follow_redirects=False)
        self.assertIn("reason=state", self.loc(r))

    def test_D08_a_normal_login_token_cannot_be_used_as_state(self):
        r = client.get("/calendar/google/callback", params={"code": "good", "state": h.token_for(self.user)}, follow_redirects=False)
        self.assertIn("reason=state", self.loc(r))
        self.assertIsNone(cal.get_connection(self.user))

    def test_D08b_a_token_signed_with_our_secret_but_not_made_for_this_flow_is_rejected(self):
        # No audience claim to trip over: only the "typ" check stands between this and a bogus connect.
        other_flow = jwt.encode({"sub": self.user, "exp": int(time.time()) + 600}, settings.active_jwt_secret, "HS256")
        r = client.get("/calendar/google/callback", params={"code": "good", "state": other_flow}, follow_redirects=False)
        self.assertIn("reason=state", self.loc(r))
        self.assertIsNone(cal.get_connection(self.user))

    def test_D09_google_rejects_the_code(self):
        r = client.get("/calendar/google/callback", params={"code": "bad", "state": cal_router._make_state(self.user, "UTC")}, follow_redirects=False)
        self.assertIn("calendar=error", self.loc(r))
        self.assertIsNone(cal.get_connection(self.user))

    def test_D10_no_refresh_token_is_reported_and_nothing_is_saved(self):
        r = client.get("/calendar/google/callback", params={"code": "norefresh", "state": cal_router._make_state(self.user, "UTC")}, follow_redirects=False)
        self.assertIn("reason=no_refresh", self.loc(r))
        self.assertIsNone(cal.get_connection(self.user))

    def test_D11_attaches_only_to_the_account_in_the_state(self):
        other = h.make_user()
        self.connect(user=self.user)
        self.assertIsNone(cal.get_connection(other))

    def test_D12_callback_is_reachable_without_a_login_header(self):
        # Google's redirect carries no Authorization header; the signed state is the credential.
        self.assertEqual(self.connect().status_code, 302)

    def test_D13_invalid_timezone_in_state_is_stored_as_utc(self):
        self.connect(tz="Nope/Nope")
        self.assertEqual(cal.get_connection(self.user)["settings"]["timezone"], "UTC")


class SettingsApi(Base):
    def setUp(self):
        super().setUp()
        self.connect()

    def patch(self, body, user=None):
        return client.patch("/calendar/settings", json=body, headers=auth(user or self.user))

    def test_E01_update_and_persist(self):
        r = self.patch({"timezone": "America/New_York", "work_days": [1, 2, 3], "start_time": "08:30", "end_time": "16:00",
                        "slot_minutes": 45, "buffer_minutes": 10, "min_notice_hours": 4, "max_days_ahead": 14})
        self.assertEqual(r.status_code, 200, r.text)
        s = client.get("/calendar/status", headers=auth(self.user)).json()["data"]["settings"]
        self.assertEqual((s["timezone"], s["work_days"], s["slot_minutes"], s["max_days_ahead"]), ("America/New_York", [1, 2, 3], 45, 14))

    def test_E02_partial_update_keeps_other_values(self):
        self.patch({"slot_minutes": 60})
        s = cal.get_connection(self.user)["settings"]
        self.assertEqual((s["slot_minutes"], s["timezone"], s["start_time"]), (60, "Asia/Karachi", "09:00"))

    def test_E03_invalid_values_are_400_and_change_nothing(self):
        for bad in ({"timezone": "Nope"}, {"work_days": []}, {"work_days": [9]}, {"start_time": "25:00"},
                    {"start_time": "18:00"}, {"slot_minutes": 5}, {"buffer_minutes": -1}, {"min_notice_hours": 999}, {"max_days_ahead": 0}):
            self.assertEqual(self.patch(bad).status_code, 400, bad)
        self.assertEqual(cal.get_connection(self.user)["settings"]["slot_minutes"], 30)

    def test_E04_wrong_types_are_422(self):
        for bad in ({"slot_minutes": "soon"}, {"work_days": "mon"}, {"timezone": 5}):
            self.assertEqual(self.patch(bad).status_code, 422, bad)

    def test_E05_requires_a_connection(self):
        other = h.make_user()
        self.assertEqual(self.patch({"slot_minutes": 20}, user=other).status_code, 400)

    def test_E06_only_the_owner_may_change_settings(self):
        for role in ("member", "viewer"):
            self.assertEqual(self.patch({"slot_minutes": 20}, user=self.member(role)).status_code, 403, role)
        self.assertEqual(cal.get_connection(self.user)["settings"]["slot_minutes"], 30)

    def test_E08_a_short_name_like_PST_is_saved_as_the_real_region(self):
        r = self.patch({"timezone": "PST"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(cal.get_connection(self.user)["settings"]["timezone"], "America/Los_Angeles")

    def test_E07_empty_patch_is_harmless(self):
        self.assertEqual(self.patch({}).status_code, 200)


class Disconnect(Base):
    def test_F01_revokes_at_google_and_removes_the_connection(self):
        self.connect()
        r = client.delete("/calendar/google", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.g.revoked, ["rt-good"])
        self.assertIsNone(cal.get_connection(self.user))
        self.assertFalse(client.get("/calendar/status", headers=auth(self.user)).json()["data"]["connected"])

    def test_F02_nothing_to_disconnect(self):
        self.assertEqual(client.delete("/calendar/google", headers=auth(self.user)).status_code, 404)

    def test_F03_still_disconnects_when_google_is_unreachable(self):
        self.connect()
        async def boom(*a, **k):
            raise cal.gc.CalendarError("down")
        with patch.object(cal.gc, "_request", boom):
            r = client.delete("/calendar/google", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(cal.get_connection(self.user))

    def test_F04_members_cannot_disconnect(self):
        self.connect()
        self.assertEqual(client.delete("/calendar/google", headers=auth(self.member("member"))).status_code, 403)
        self.assertIsNotNone(cal.get_connection(self.user))

    def test_F05_reconnect_after_disconnect_works(self):
        self.connect()
        client.delete("/calendar/google", headers=auth(self.user))
        self.connect()
        self.assertIsNotNone(cal.get_connection(self.user))

    def test_F06_deleting_the_account_owner_row_cascades(self):
        u = h.make_user()
        self.connect(user=u)
        h.sql("delete from users where id=%s", (u,))
        self.assertEqual(h.sql("select count(*) from calendar_connections where user_id=%s", (u,))[0][0], 0)


class Migration(unittest.TestCase):
    def test_G01_tables_and_constraints_exist(self):
        cols = {r[0] for r in h.sql("select column_name from information_schema.columns where table_name='calendar_connections'")}
        self.assertTrue({"user_id", "refresh_token_encrypted", "settings", "status", "email"} <= cols)
        bcols = {r[0] for r in h.sql("select column_name from information_schema.columns where table_name='calendar_bookings'")}
        self.assertTrue({"event_id", "start_at", "end_at", "vapi_call_id", "tool_call_id", "attendee_email"} <= bcols)

    def test_G02_one_connection_per_account_and_status_check(self):
        u = h.make_user()
        h.sql("insert into calendar_connections(user_id, refresh_token_encrypted) values(%s,'x')", (u,))
        with self.assertRaises(Exception):
            h.sql("insert into calendar_connections(user_id, refresh_token_encrypted) values(%s,'y')", (u,))
        with self.assertRaises(Exception):
            h.sql("update calendar_connections set status='weird' where user_id=%s", (u,))


if __name__ == "__main__":
    unittest.main()
