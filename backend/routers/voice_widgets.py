"""
Voice widgets (`/voice-widgets`): embeddable "Talk to AI" buttons that let a website visitor
start a voice call with one of the account's agents from the browser.

Dashboard CRUD (JWT, scoped to the account owner) manages rows in `voice_widgets`: name,
agent_id, status and a free-form `config`. The public `GET /voice-widgets/{public_token}/embed.js`
endpoint serves the generated JavaScript that the dashboard's <script> snippet loads; it reads
`voice_widgets` and `ai_agents` and talks to VAPI only from the visitor's browser, through the
@vapi-ai/web SDK.
"""

import json
from fastapi import APIRouter, Depends, HTTPException, Response, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from dependencies import get_current_user
from database import supabase
from models.schemas import VoiceWidgetCreate, VoiceWidgetUpdate
from config import settings
from routers.team import resolve_owner_id

limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/voice-widgets", tags=["Voice Widgets"])


@router.get("")
async def list_widgets(user=Depends(get_current_user)):
    """List the voice widgets of the caller's account, newest first. Team members see the
    account owner's widgets."""
    result = (
        supabase.table("voice_widgets")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("")
async def create_widget(body: VoiceWidgetCreate, user=Depends(get_current_user)):
    """Create a voice widget owned by the caller's account. `config` is a free-form object
    read by the embed script (buttonLabel, buttonColor, position, assistantOverrides). The
    database generates the `public_token` that appears in the embed URL."""
    # The body is stored as given; this handler does not check that `agent_id` belongs to the caller.
    row = body.model_dump()
    row["user_id"] = resolve_owner_id(user["user_id"])
    result = supabase.table("voice_widgets").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{widget_id}")
async def get_widget(widget_id: str, user=Depends(get_current_user)):
    """Fetch one widget by id from the caller's account. `data` is null (not a 404) when the
    widget does not exist or belongs to another account."""
    result = (
        supabase.table("voice_widgets")
        .select("*")
        .eq("id", widget_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{widget_id}")
async def update_widget(widget_id: str, body: VoiceWidgetUpdate, user=Depends(get_current_user)):
    """Partially update a widget in the caller's account: only non-null fields in the body are
    changed. A supplied `config` replaces the stored config entirely (it is not merged), so
    send the whole object. Setting `status` to Inactive makes the embed script return 404."""
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("voice_widgets")
        .update(updates)
        .eq("id", widget_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{widget_id}")
async def delete_widget(widget_id: str, user=Depends(get_current_user)):
    """Delete a widget from the caller's account. Always returns success, including when the
    widget does not exist; pages that still embed it will get a 404 for the script."""
    supabase.table("voice_widgets").delete().eq("id", widget_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}


@router.get("/{public_token}/embed.js", include_in_schema=False)
@limiter.limit("60/minute")
async def serve_embed_script(request: Request, public_token: str):
    """Public, unauthenticated endpoint (rate limited to 60/minute per client address) that
    returns the widget's JavaScript, looked up by its `public_token`. Only Active widgets are
    served; anything else is a 404. The script is generated per request from the widget's
    config and its agent's VAPI assistant id."""
    # Not listed in the OpenAPI docs (include_in_schema=False): this URL is loaded by a
    # <script> tag on the customer's website rather than called as an API.
    result = (
        supabase.table("voice_widgets")
        .select("id, name, agent_id, config, status")
        .eq("public_token", public_token)
        .eq("status", "Active")
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Widget not found")

    widget = result.data
    # Stays empty when no agent is linked or the agent has no VAPI assistant yet; the
    # generated script then disables itself instead of failing at call time.
    vapi_assistant_id = ""
    if widget.get("agent_id"):
        agent_res = (
            supabase.table("ai_agents")
            .select("vapi_assistant_id")
            .eq("id", widget["agent_id"])
            .maybe_single()
            .execute()
        )
        if agent_res.data:
            vapi_assistant_id = agent_res.data.get("vapi_assistant_id") or ""

    # Every value is emitted through json.dumps so it lands in the script as a valid JS literal.
    # The public key is VAPI's client-side key (visible to every page that embeds the widget),
    # not the server's private API key.
    cfg = widget.get("config") or {}
    cfg_json = json.dumps(cfg)
    button_label = json.dumps(cfg.get("buttonLabel") or "Talk to AI")
    button_color = json.dumps(cfg.get("buttonColor") or "#10b981")
    position = json.dumps(cfg.get("position") or "bottom-right")
    public_key = json.dumps(settings.vapi_public_key)
    assistant_id_js = json.dumps(vapi_assistant_id)

    # The JavaScript below is a Python f-string, so its literal braces are doubled ({{ }});
    # only the {...} placeholders above are substituted. What the script does in the browser:
    # bail out with a console warning if the public key or assistant id is missing; add a
    # fixed-position button (position from config, default bottom-right); lazy-load the
    # @vapi-ai/web SDK from jsDelivr on the first click; then toggle between
    # vapi.start(assistantId, config.assistantOverrides) and vapi.stop(), switching the label
    # to "End Call" while active. Call state is tracked only by the clicks (no SDK event
    # listeners), so the label is not reset if the call ends on its own.
    script = f"""
(function () {{
  var CONFIG = {cfg_json};
  var PUBLIC_KEY = {public_key};
  var ASSISTANT_ID = {assistant_id_js};
  var POSITION = {position};
  var BUTTON_LABEL = {button_label};
  var BUTTON_COLOR = {button_color};

  if (!PUBLIC_KEY || !ASSISTANT_ID) {{
    console.warn("[EDM Nexus widget] missing publicKey or assistantId — widget disabled.");
    return;
  }}

  var posStyles = {{
    "bottom-right": "bottom:20px;right:20px;",
    "bottom-left":  "bottom:20px;left:20px;",
    "top-right":    "top:20px;right:20px;",
    "top-left":     "top:20px;left:20px;"
  }};

  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", BUTTON_LABEL);
  btn.style.cssText =
    "position:fixed;z-index:2147483647;" + (posStyles[POSITION] || posStyles["bottom-right"]) +
    "background:" + BUTTON_COLOR + ";color:#fff;border:none;border-radius:9999px;" +
    "padding:14px 22px;font:600 14px/1 system-ui,-apple-system,sans-serif;" +
    "box-shadow:0 10px 25px rgba(0,0,0,.18);cursor:pointer;display:inline-flex;align-items:center;gap:8px;";
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/></svg>' +
    '<span>' + BUTTON_LABEL + '</span>';

  var callActive = false;
  var vapi = null;

  function loadSDK(cb) {{
    if (window.Vapi) return cb(window.Vapi);
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@vapi-ai/web@latest/dist/index.umd.js";
    s.onload = function () {{ cb(window.Vapi && (window.Vapi.default || window.Vapi)); }};
    s.onerror = function () {{ console.error("[EDM Nexus widget] failed to load VAPI SDK"); }};
    document.head.appendChild(s);
  }}

  btn.addEventListener("click", function () {{
    loadSDK(function (Vapi) {{
      if (!Vapi) return;
      if (!vapi) vapi = new Vapi(PUBLIC_KEY);
      if (callActive) {{
        vapi.stop();
        callActive = false;
        btn.querySelector("span").textContent = BUTTON_LABEL;
      }} else {{
        vapi.start(ASSISTANT_ID, CONFIG.assistantOverrides || undefined);
        callActive = true;
        btn.querySelector("span").textContent = "End Call";
      }}
    }});
  }});

  document.body.appendChild(btn);
}})();
""".strip()

    return Response(content=script, media_type="application/javascript")
