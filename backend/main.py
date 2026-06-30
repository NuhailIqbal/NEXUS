from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from config import settings

from routers import (
    agents,
    contacts,
    lists,
    custom_fields,
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
    billing,
    stripe_webhook,
    admin,
)

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="EDM Nexus API",
    version="1.0.0",
    description="AI-powered revenue platform backend",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health + Auth
@app.get("/health", tags=["System"])
async def health():
    return {"status": "ok"}


from fastapi import Depends
from dependencies import get_current_user
from database import supabase


@app.get("/me", tags=["System"])
async def me(user=Depends(get_current_user)):
    result = supabase.table("profiles").select("*").eq("id", user["user_id"]).maybe_single().execute()
    return {"data": result.data, "error": None}


# Routers
app.include_router(agents.router)
app.include_router(contacts.router)
app.include_router(lists.router)
app.include_router(custom_fields.router)
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
app.include_router(billing.router)
app.include_router(stripe_webhook.router)
app.include_router(admin.router)
