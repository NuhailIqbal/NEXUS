from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from dependencies import get_current_user
from database import supabase
from models.schemas import AgentCreate, AgentUpdate
from services import vapi_client
from config import settings

router = APIRouter(prefix="/agents", tags=["Agents"])


@router.get("")
async def list_agents(user=Depends(get_current_user)):
    result = (
        supabase.table("ai_agents")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("")
async def create_agent(body: AgentCreate, user=Depends(get_current_user)):
    row = {
        "user_id": user["user_id"],
        "name": body.name,
        "voice": body.voice,
        "language": body.language,
        "category": body.category,
        "status": body.status,
    }

    if settings.vapi_api_key:
        try:
            payload = vapi_client.build_assistant_payload(
                name=body.name,
                voice=body.voice,
                language=body.language,
                system_prompt=body.system_prompt,
                first_message=body.first_message,
            )
            vapi_agent = await vapi_client.create_assistant(payload)
            row["vapi_assistant_id"] = vapi_agent.get("id")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

    result = supabase.table("ai_agents").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{agent_id}")
async def get_agent(agent_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("ai_agents")
        .select("*")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{agent_id}")
async def update_agent(agent_id: str, body: AgentUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    agent_res = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .single()
        .execute()
    )
    agent = agent_res.data
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    db_updates = {k: v for k, v in updates.items() if k in ("name", "voice", "language", "category", "status")}

    if settings.vapi_api_key and agent.get("vapi_assistant_id"):
        try:
            vapi_payload = {}
            if "name" in updates:
                vapi_payload["name"] = updates["name"]
            if "system_prompt" in updates or "first_message" in updates or "voice" in updates or "language" in updates:
                vapi_payload.update(vapi_client.build_assistant_payload(
                    name=updates.get("name", ""),
                    voice=updates.get("voice"),
                    language=updates.get("language", "en"),
                    system_prompt=updates.get("system_prompt"),
                    first_message=updates.get("first_message"),
                ))
            if vapi_payload:
                await vapi_client.update_assistant(agent["vapi_assistant_id"], vapi_payload)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

    result = (
        supabase.table("ai_agents")
        .update(db_updates)
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str, user=Depends(get_current_user)):
    agent_res = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .single()
        .execute()
    )
    agent = agent_res.data
    if agent and settings.vapi_api_key and agent.get("vapi_assistant_id"):
        try:
            await vapi_client.delete_assistant(agent["vapi_assistant_id"])
        except Exception:
            pass

    supabase.table("ai_agents").delete().eq("id", agent_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}


@router.post("/{agent_id}/knowledge")
async def upload_knowledge(agent_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    agent_res = (
        supabase.table("ai_agents")
        .select("id, vapi_assistant_id")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .single()
        .execute()
    )
    if not agent_res.data:
        raise HTTPException(status_code=404, detail="Agent not found")

    content = await file.read()

    storage_path = f"{user['user_id']}/agents/{agent_id}/{file.filename}"
    supabase.storage.from_("knowledge").upload(storage_path, content, {"content-type": file.content_type or "application/pdf"})

    vapi_file_id = None
    if settings.vapi_api_key:
        try:
            vapi_file = await vapi_client.upload_file(content, file.filename)
            vapi_file_id = vapi_file.get("id")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI file upload error: {str(e)}")

    doc_row = {
        "user_id": user["user_id"],
        "agent_id": agent_id,
        "type": "document",
        "file_name": file.filename,
        "storage_path": storage_path,
        "mime_type": file.content_type,
    }
    result = supabase.table("agent_knowledge").insert(doc_row).execute()

    return {
        "data": {
            "knowledge_doc": result.data[0] if result.data else None,
            "vapi_file_id": vapi_file_id,
        },
        "error": None,
    }
