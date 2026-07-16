from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from dependencies import get_current_user
from database import supabase
from models.schemas import AgentCreate, AgentUpdate, AgentTest
from services import vapi_client
from services.openai_client import chat_reply, OpenAIError
from services.agent_tools import provision_tools_for_agent
from config import settings
from routers.billing import check_agent_quota, get_or_create_billing

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


def _compose_system_prompt(name: str, base_prompt: str | None, main_goal: str | None, knowledge_text: str | None) -> str:
    parts: list[str] = []
    if base_prompt and base_prompt.strip():
        parts.append(base_prompt.strip())
    else:
        parts.append(f"You are {name}, a helpful AI assistant.")
    if main_goal and main_goal.strip():
        parts.append(f"\nYour primary goal:\n{main_goal.strip()}")
    if knowledge_text and knowledge_text.strip():
        parts.append(f"\nReference knowledge — use this to answer questions accurately:\n{knowledge_text.strip()}")
    return "\n".join(parts)


@router.post("")
async def create_agent(body: AgentCreate, user=Depends(get_current_user)):
    billing = get_or_create_billing(user["user_id"])
    if not billing.get("is_active", True):
        raise HTTPException(status_code=403, detail="Your account has been deactivated. Contact support.")
    if not check_agent_quota(user["user_id"]):
        raise HTTPException(status_code=403, detail="Agent limit reached. Upgrade your plan to create more agents.")

    composed_prompt = _compose_system_prompt(body.name, body.system_prompt, body.main_goal, body.knowledge_text)

    row = {
        "user_id": user["user_id"],
        "name": body.name,
        "voice": body.voice,
        "language": body.language,
        "category": body.category,
        "status": body.status,
        "system_prompt": composed_prompt,
        "first_message": body.first_message,
        "main_goal": body.main_goal,
        "website": body.website,
        "selected_tool_keys": body.selected_tool_keys or [],
        "transfer_number": body.transfer_number,
    }

    if settings.vapi_api_key:
        tool_ids = await provision_tools_for_agent(user["user_id"], body.selected_tool_keys or [])
        # Standalone transferCall tool (shows up in VAPI's Tools library, attached by id)
        if body.transfer_number and body.transfer_number.strip():
            try:
                t = await vapi_client.create_tool(
                    vapi_client.build_transfer_tool_payload(body.name, body.transfer_number)
                )
                transfer_tool_id = t.get("id")
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"VAPI transfer tool error: {str(e)}")
            if transfer_tool_id:
                tool_ids = (tool_ids or []) + [transfer_tool_id]
                row["transfer_tool_id"] = transfer_tool_id
        try:
            payload = vapi_client.build_assistant_payload(
                name=body.name,
                voice=body.voice,
                language=body.language,
                system_prompt=composed_prompt,
                first_message=body.first_message,
                tool_ids=tool_ids or None,
            )
            vapi_agent = await vapi_client.create_assistant(payload)
            row["vapi_assistant_id"] = vapi_agent.get("id")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

    result = supabase.table("ai_agents").insert(row).execute()
    agent = result.data[0] if result.data else None

    if agent and body.knowledge_text and body.knowledge_text.strip():
        try:
            supabase.table("agent_knowledge").insert({
                "user_id": user["user_id"],
                "agent_id": agent["id"],
                "type": "text",
                "text_content": body.knowledge_text.strip(),
            }).execute()
        except Exception:
            pass

    return {"data": agent, "error": None}


@router.post("/test")
async def test_agent(body: AgentTest, user=Depends(get_current_user)):
    """Run a quick text test of an agent's prompt (used by the Create-agent wizard)."""
    if not body.message or not body.message.strip():
        raise HTTPException(status_code=400, detail="Enter a test message.")
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="AI testing is not configured — add OPENAI_API_KEY on the server.")
    try:
        reply = await chat_reply(body.system_prompt, body.message, body.first_message)
    except OpenAIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    if not reply:
        raise HTTPException(status_code=502, detail="The AI returned an empty response — please try again.")
    return {"data": {"reply": reply}, "error": None}


@router.post("/{agent_id}/sync-vapi")
async def sync_agent_vapi(agent_id: str, user=Depends(get_current_user)):
    if not settings.vapi_api_key:
        raise HTTPException(status_code=400, detail="VAPI is not configured on this server.")

    agent_res = (
        supabase.table("ai_agents")
        .select("*")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    agent = agent_res.data
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    if agent.get("vapi_assistant_id"):
        return {"data": agent, "error": None}

    tool_ids = await provision_tools_for_agent(user["user_id"], agent.get("selected_tool_keys") or [])
    transfer_tool_id = agent.get("transfer_tool_id")
    if agent.get("transfer_number") and str(agent["transfer_number"]).strip() and not transfer_tool_id:
        try:
            t = await vapi_client.create_tool(
                vapi_client.build_transfer_tool_payload(agent["name"], agent["transfer_number"])
            )
            transfer_tool_id = t.get("id")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI transfer tool error: {str(e)}")
    if transfer_tool_id:
        tool_ids = (tool_ids or []) + [transfer_tool_id]
    try:
        payload = vapi_client.build_assistant_payload(
            name=agent["name"],
            voice=agent.get("voice"),
            language=agent.get("language"),
            system_prompt=agent.get("system_prompt"),
            first_message=agent.get("first_message"),
            tool_ids=tool_ids or None,
        )
        vapi_agent = await vapi_client.create_assistant(payload)
        vapi_assistant_id = vapi_agent.get("id")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

    result = (
        supabase.table("ai_agents")
        .update({"vapi_assistant_id": vapi_assistant_id, "transfer_tool_id": transfer_tool_id})
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{agent_id}")
async def get_agent(agent_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("ai_agents")
        .select("*")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
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
        .select("vapi_assistant_id, system_prompt, transfer_number, transfer_tool_id, name, selected_tool_keys")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    agent = agent_res.data
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    db_updates = {k: v for k, v in updates.items() if k in (
        "name", "voice", "language", "category", "status",
        "system_prompt", "first_message", "main_goal", "website", "selected_tool_keys",
        "transfer_number",
    )}

    # If system_prompt is explicitly provided, use it as-is — the UI shows and edits
    # the full final prompt, so re-composing would double-append the goal section.
    # Only compose when main_goal changes but system_prompt is not being updated.
    if "main_goal" in updates and "system_prompt" not in updates:
        existing = (
            supabase.table("ai_agents")
            .select("system_prompt, main_goal, name")
            .eq("id", agent_id)
            .eq("user_id", user["user_id"])
            .maybe_single()
            .execute()
        )
        cur = existing.data or {}
        new_prompt = _compose_system_prompt(
            updates.get("name", cur.get("name", "")),
            cur.get("system_prompt"),
            updates["main_goal"],
            None,
        )
        updates["system_prompt"] = new_prompt
        db_updates["system_prompt"] = new_prompt

    if settings.vapi_api_key and agent.get("vapi_assistant_id"):
        try:
            vapi_payload: dict = {}
            if "name" in updates:
                vapi_payload["name"] = updates["name"]
            if "first_message" in updates:
                vapi_payload["firstMessage"] = updates["first_message"]
            # Rebuild the model block when the prompt OR the transfer number changes.
            # The transfer is a standalone VAPI transferCall tool attached by id, so we
            # recompute the full toolIds (preset tools + transfer tool) to avoid dropping them.
            if "system_prompt" in updates or "transfer_number" in updates:
                preset_ids = await provision_tools_for_agent(
                    user["user_id"],
                    updates.get("selected_tool_keys") or agent.get("selected_tool_keys") or [],
                )
                transfer_tool_id = agent.get("transfer_tool_id")
                if "transfer_number" in updates:
                    new_num = (updates.get("transfer_number") or "").strip()
                    agent_name = updates.get("name") or agent.get("name") or ""
                    if new_num:
                        t_payload = vapi_client.build_transfer_tool_payload(agent_name, new_num)
                        if transfer_tool_id:
                            await vapi_client.update_tool(transfer_tool_id, t_payload)
                        else:
                            created = await vapi_client.create_tool(t_payload)
                            transfer_tool_id = created.get("id")
                            db_updates["transfer_tool_id"] = transfer_tool_id
                    else:
                        if transfer_tool_id:
                            try:
                                await vapi_client.delete_tool(transfer_tool_id)
                            except Exception:
                                pass
                        transfer_tool_id = None
                        db_updates["transfer_tool_id"] = None

                all_tool_ids = list(preset_ids or [])
                if transfer_tool_id:
                    all_tool_ids.append(transfer_tool_id)

                effective_prompt = updates.get("system_prompt", agent.get("system_prompt")) or ""
                model_block: dict = {
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "system", "content": effective_prompt}],
                }
                if all_tool_ids:
                    model_block["toolIds"] = all_tool_ids
                vapi_payload["model"] = model_block
            if "voice" in updates:
                vapi_payload["voice"] = vapi_client._resolve_voice(updates["voice"])
            if "language" in updates:
                vapi_payload["transcriber"] = {
                    "provider": "deepgram",
                    "language": vapi_client._resolve_language(updates["language"]),
                }
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
        .select("vapi_assistant_id, transfer_tool_id")
        .eq("id", agent_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    agent = agent_res.data
    if agent and settings.vapi_api_key and agent.get("vapi_assistant_id"):
        try:
            await vapi_client.delete_assistant(agent["vapi_assistant_id"])
        except Exception:
            pass
    # Clean up the standalone transferCall tool so it doesn't orphan in VAPI's Tools list.
    if agent and settings.vapi_api_key and agent.get("transfer_tool_id"):
        try:
            await vapi_client.delete_tool(agent["transfer_tool_id"])
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
        .maybe_single()
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
