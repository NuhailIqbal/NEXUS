from fastapi import APIRouter, Depends, HTTPException, Response
from dependencies import get_current_user
from database import supabase
from models.schemas import VoiceWidgetCreate, VoiceWidgetUpdate

router = APIRouter(prefix="/voice-widgets", tags=["Voice Widgets"])


@router.get("")
async def list_widgets(user=Depends(get_current_user)):
    result = (
        supabase.table("voice_widgets")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("")
async def create_widget(body: VoiceWidgetCreate, user=Depends(get_current_user)):
    row = body.model_dump()
    row["user_id"] = user["user_id"]
    result = supabase.table("voice_widgets").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{widget_id}")
async def get_widget(widget_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("voice_widgets")
        .select("*")
        .eq("id", widget_id)
        .eq("user_id", user["user_id"])
        .single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{widget_id}")
async def update_widget(widget_id: str, body: VoiceWidgetUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("voice_widgets")
        .update(updates)
        .eq("id", widget_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{widget_id}")
async def delete_widget(widget_id: str, user=Depends(get_current_user)):
    supabase.table("voice_widgets").delete().eq("id", widget_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}


@router.get("/{public_token}/embed.js", include_in_schema=False)
async def serve_embed_script(public_token: str):
    result = (
        supabase.table("voice_widgets")
        .select("id, name, agent_id, config, status")
        .eq("public_token", public_token)
        .eq("status", "Active")
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Widget not found")

    widget = result.data
    script = f"""
(function() {{
  var config = {widget['config']};
  config.assistantId = "{widget.get('agent_id', '')}";
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@latest/dist/vapi.js';
  script.onload = function() {{
    window.vapiWidget = new Vapi(config);
  }};
  document.head.appendChild(script);
}})();
""".strip()

    return Response(content=script, media_type="application/javascript")
