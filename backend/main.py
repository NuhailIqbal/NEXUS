"""
FastAPI application entry point (`uvicorn main:app`).

Builds the `app` object: runs the schema auto-migration and starts the background loops
(VAPI call sync, phone-number billing, delayed automation steps, callback placement) on
startup, installs CORS, rate-limit and team-role middleware, defines the `/health` and
`/me` routes, and mounts every router from `routers/`. Reads configuration from
`config.settings` and talks to PostgreSQL through `database.supabase`.
"""
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from config import settings

from routers import (
    auth,
    agents,
    contacts,
    lists,
    tools,
    conversations,
    telephony,
    automation,
    voice_widgets,
    integrations,
    analytics,
    team,
    profile,
    webhooks,
    agent_tool_callbacks,
    call_events,
    calendar,
    callbacks,
    billing,
    stripe_webhook,
    admin,
    auth,
    notifications,
    referrals,
)

# Application-level rate limiter (clients keyed by remote IP). slowapi needs it on
# app.state: its 429 handler, registered below, looks it up there. The per-endpoint
# @limiter.limit(...) decorators live in individual routers, which each create their own
# Limiter.
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="EDM Nexus API",
    version="1.0.0",
    description="AI-powered revenue platform backend",
)


# Startup hooks run in registration order, so the schema is migrated before any of the
# background loops below start querying the database. Each loop runs as a fire-and-forget
# asyncio task in this process and logs its own errors. The VAPI sync, phone billing and
# delayed-step loops assume a single worker/replica (see their docstrings).
@app.on_event("startup")
def _auto_migrate() -> None:
    """Auto-create the database schema on an empty PostgreSQL database."""
    from migrate import bootstrap_schema
    bootstrap_schema()


@app.on_event("startup")
async def _start_vapi_sync() -> None:
    """Poll VAPI in the background so new calls (recording + transcript) appear in
    Conversations automatically, without the manual 'Sync from VAPI' button."""
    import asyncio
    if settings.vapi_api_key and settings.vapi_sync_interval_seconds > 0:
        from services.vapi_sync import sync_loop
        asyncio.create_task(sync_loop())


@app.on_event("startup")
async def _start_phone_billing_sweep() -> None:
    """Charge each Twilio phone number's monthly fee on its renewal date; suspend
    inbound routing (never deprovision) if the charge can't be covered."""
    import asyncio
    if settings.phone_billing_sweep_interval_seconds > 0:
        from services.phone_billing import billing_sweep_loop
        asyncio.create_task(billing_sweep_loop())


@app.on_event("startup")
async def _start_delayed_steps() -> None:
    """Resume automation flows paused on a long Delay node once their time is up."""
    import asyncio
    # Unlike the other loops, this one has no setting that disables it; its poll interval
    # is a constant in services.automation_engine.
    from services.automation_engine import delayed_steps_loop
    asyncio.create_task(delayed_steps_loop())


@app.on_event("startup")
async def _start_callback_scheduler() -> None:
    """Place due callbacks — only for accounts that turned on auto-calling (off by default)."""
    import asyncio
    if settings.callback_sweep_interval_seconds > 0:
        from services.callback_scheduler import callback_loop
        asyncio.create_task(callback_loop())


# Turn slowapi's RateLimitExceeded into a 429 JSON response with rate-limit headers.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TeamRoleGuard(BaseHTTPMiddleware):
    """Enforce team-member access rules for non-owner accounts:
      - DELETE is blocked for every sub-user (Member and Viewer alike) — owners only.
      - Every other mutating method (POST/PUT/PATCH) is blocked for Viewer-role
        sub-users — Viewers are read-only. Members can still create/edit.
    Safe no-ops (dry-run "/test" endpoints) and unauthenticated/machine routes are
    exempt since they don't touch a shared resource."""

    # Matched with startswith(). These routes are called without a user's team context:
    # provider webhooks, the admin portal (X-Admin-Auth instead of a user Bearer token),
    # login/signup, the voice provider's agent-tool callbacks, and a new invitee
    # accepting a team invite.
    EXEMPT_PATHS = {"/webhooks/", "/admin/", "/auth/", "/tools/internal/", "/team/accept-invite"}
    SAFE_SUFFIXES = ("/test",)  # dry-run endpoints — never persist anything

    async def dispatch(self, request: Request, call_next):
        """Reject the request with 403 if the caller is a sub-user who may not perform this method; otherwise pass it on."""
        method = request.method
        # Reads and CORS preflights are open to every team role.
        if method in ("GET", "HEAD", "OPTIONS"):
            return await call_next(request)

        path = request.url.path
        if any(path.startswith(p) for p in self.EXEMPT_PATHS) or path.endswith(self.SAFE_SUFFIXES):
            return await call_next(request)

        # Only requests carrying a user Bearer token are evaluated here. Authentication
        # itself is not this middleware's job: a request without a token continues to the
        # route, whose own dependencies (e.g. get_current_user) decide whether a login is required.
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            try:
                from dependencies import _decode_token
                payload = _decode_token(token)
                user_id = payload.get("sub")
                if user_id:
                    from routers.team import get_user_role
                    role = get_user_role(user_id)
                    # get_user_role returns "owner" for anyone who is not an Active team
                    # member, so only sub-users (member/viewer) can be blocked below.
                    if role != "owner":
                        if method == "DELETE":
                            return JSONResponse(
                                status_code=403,
                                content={"detail": "Sub-users cannot delete resources. Contact your account owner."},
                            )
                        if role == "viewer":
                            return JSONResponse(
                                status_code=403,
                                content={"detail": "Viewers have read-only access. Contact your account owner to make changes."},
                            )
            except Exception:
                # Any failure (undecodable or expired token, role lookup error) lets the
                # request continue unchanged; invalid tokens are rejected later by
                # get_current_user. Note this makes the guard fail-open if the
                # team_members lookup itself errors.
                pass

        return await call_next(request)


# Added after CORSMiddleware, and Starlette runs the most recently added middleware
# outermost, so this guard runs before CORS: the 403 responses it returns directly do
# not pass through CORSMiddleware and carry no CORS headers.
app.add_middleware(TeamRoleGuard)


# Health
@app.get("/health", tags=["System"])
async def health():
    """Liveness probe: always returns {"status": "ok"}. No authentication and no database access."""
    return {"status": "ok"}


from fastapi import Depends
from dependencies import get_current_user
from database import supabase


@app.get("/me", tags=["System"])
async def me(user=Depends(get_current_user)):
    """Return the authenticated user's row from the `profiles` table (`data` is null if none exists). Requires a valid user Bearer token."""
    result = supabase.table("profiles").select("*").eq("id", user["user_id"]).maybe_single().execute()
    return {"data": result.data, "error": None}


# Routers
app.include_router(auth.router)
app.include_router(agents.router)
app.include_router(contacts.router)
app.include_router(lists.router)
app.include_router(tools.router)
app.include_router(conversations.router)
app.include_router(telephony.router)
app.include_router(automation.router)
app.include_router(voice_widgets.router)
app.include_router(integrations.router)
app.include_router(analytics.router)
app.include_router(team.router)
app.include_router(profile.router)
app.include_router(webhooks.router)
app.include_router(agent_tool_callbacks.router)
app.include_router(call_events.router)
app.include_router(calendar.router)
app.include_router(callbacks.router)
app.include_router(billing.router)
app.include_router(stripe_webhook.router)
app.include_router(admin.router)
app.include_router(notifications.router)
app.include_router(referrals.router)
