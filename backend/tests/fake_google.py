"""
A fake Google (OAuth + Calendar) for tests: replaces services.google_calendar._request so the
suite never touches the network, and records every request for assertions.
"""
import httpx
from unittest.mock import patch

from services import google_calendar as gc


class FakeGoogle:
    def __init__(self):
        self.busy: list[tuple[str, str]] = []          # returned by freeBusy
        self.events: list[dict] = []                   # bodies of created events
        self.event_params: list[dict] = []
        self.requests: list[tuple[str, str]] = []
        self.revoked: list[str] = []
        self.refresh_calls = 0
        self.revoked_grant = False                     # every refresh fails with invalid_grant
        self.fail_freebusy: int | None = None          # HTTP status to return
        self.fail_create: int | None = None
        self.freebusy_errors = None
        self.email = "owner@gmail.com"
        self._n = 0

    # -- helpers
    @staticmethod
    def _resp(method, url, status, body):
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    async def request(self, method, url, **kw):
        self.requests.append((method, url))
        if url == gc.TOKEN_URL:
            data = kw.get("data") or {}
            if data.get("grant_type") == "authorization_code":
                code = data.get("code")
                if code == "bad":
                    return self._resp(method, url, 400, {"error": "invalid_grant", "error_description": "Bad code"})
                body = {"access_token": "at-connect", "expires_in": 3600}
                if code != "norefresh":
                    body["refresh_token"] = "rt-good"
                return self._resp(method, url, 200, body)
            self.refresh_calls += 1
            if self.revoked_grant or data.get("refresh_token") == "rt-revoked":
                return self._resp(method, url, 400, {"error": "invalid_grant", "error_description": "Token revoked"})
            return self._resp(method, url, 200, {"access_token": f"at-{self.refresh_calls}", "expires_in": 3600})
        if url == gc.USERINFO_URL:
            return self._resp(method, url, 200, {"email": self.email})
        if url == gc.REVOKE_URL:
            self.revoked.append((kw.get("data") or {}).get("token"))
            return self._resp(method, url, 200, {})
        if url.endswith("/freeBusy"):
            if self.fail_freebusy:
                return self._resp(method, url, self.fail_freebusy, {"error": {"message": "boom"}})
            cal = {"busy": [{"start": a, "end": b} for a, b in self.busy]}
            if self.freebusy_errors:
                cal["errors"] = self.freebusy_errors
            return self._resp(method, url, 200, {"calendars": {"primary": cal}})
        if "/events" in url and method == "POST":
            if self.fail_create:
                return self._resp(method, url, self.fail_create, {"error": {"message": "nope"}})
            self._n += 1
            self.events.append(kw.get("json"))
            self.event_params.append(kw.get("params") or {})
            return self._resp(method, url, 200, {"id": f"evt{self._n}", "htmlLink": f"https://cal.test/evt{self._n}"})
        return self._resp(method, url, 404, {"error": {"message": f"unexpected {method} {url}"}})

    def start(self):
        self._patch = patch.object(gc, "_request", self.request)
        self._patch.start()
        return self

    def stop(self):
        self._patch.stop()
