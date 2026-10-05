"""Agents API (mounted at /agents): create, read, update, delete and provision AI voice agents.

Each agent is a row in `ai_agents` that is mirrored to a VAPI assistant, plus standalone VAPI
tools (preset action tools, a transferCall tool, and a trigger_event tool for call events).
Also hosts the Create-agent wizard helpers (text test, throwaway live voice test, website
analysis), per-agent call events, and knowledge-document upload (`agent_knowledge`).

Every route needs a logged-in user and is scoped to the account owner: team sub-users act on
their parent's agents via resolve_owner_id. Data access goes through the `supabase`
query-builder shim over PostgreSQL (database.py / db_pg.py). VAPI calls go through
services.vapi_client and are skipped when settings.vapi_api_key is empty.
"""
import re
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from slowapi import Limiter
from slowapi.util import get_remote_address
from dependencies import get_current_user
from database import supabase
from models.schemas import AgentCreate, AgentUpdate, AgentTest, AgentVoiceTestStart, AgentAnalyzeWebsite
from services import vapi_client
from services.openai_client import chat_reply, analyze_website, OpenAIError
from services.website_analyzer import fetch_website_text, WebsiteFetchError
from services.agent_tools import provision_tools_for_agent, PRESETS
from services.call_events import (
    resolve_agent_events, LibraryError, get_events, replace_events, sync_events_tool, prompt_directive,
)
from config import settings
from routers.billing import account_block_reason, get_or_create_billing
from routers.team import resolve_owner_id

logger = logging.getLogger(__name__)
limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/agents", tags=["Agents"])

# E.164 phone number: "+", a non-zero first digit, then 6-14 more digits (7-15 digits in total).
_E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")


def _validate_transfer_number(number: str | None) -> None:
    """VAPI's transferCall tool 400s on anything that isn't E.164 — catch it here
    with a clear message instead of surfacing a raw VAPI error after the fact."""
    # A blank or missing number is valid: it means "no transfer" (on update, an empty
    # string removes the existing transfer tool).
    if number and number.strip() and not _E164_RE.match(number.strip()):
        raise HTTPException(
            status_code=400,
            detail="Transfer number must be in international format, e.g. +15551234567",
        )


@router.get("")
async def list_agents(user=Depends(get_current_user)):
    """List all agents of the caller's account, newest first. Team sub-users see their owner's agents."""
    result = (
        supabase.table("ai_agents")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.get("/tool-presets")
async def list_tool_presets(user=Depends(get_current_user)):
    """The actions an agent can be given during a call (SMS, email, calendar...)."""
    # Each key is what the wizard sends back in selected_tool_keys; "requires" is the
    # integration the account must have set up for the action to work (may be None).
    # Static paths like this one must stay registered above GET /{agent_id}, otherwise
    # "tool-presets" would be matched as an agent id.
    return {"data": [
        {"key": k, "label": v["label"], "description": v["description"], "requires": v.get("requires")}
        for k, v in PRESETS.items()
    ], "error": None}


def _compose_system_prompt(name: str, base_prompt: str | None, main_goal: str | None, knowledge_text: str | None) -> str:
    """Assemble an agent's full system prompt: the base prompt (or a default "You are
    {name}" line when it is blank), then an optional "primary goal" section, then an
    optional "reference knowledge" section. Blank parts are skipped; sections are
    joined with newlines."""
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
    """Create an agent for the caller's account and, when VAPI is configured, its VAPI assistant.

    Rejected with 403 if the account is deactivated or past due/canceled (trial accounts may
    still build agents), with 400 for a non-E.164 transfer number and with 404 for a call
    event that is not in the account's library.

    With VAPI configured it provisions the preset tools, the call-events tool, a transferCall
    tool and the assistant; any VAPI failure returns 502 and nothing is saved (only the events
    tool is deleted again; preset and transfer tools stay in VAPI). Then it inserts the
    ai_agents row, stores the selected call events and, if knowledge text was given, an
    agent_knowledge row.
    """
    owner_id = resolve_owner_id(user["user_id"])
    billing = get_or_create_billing(owner_id)
    block_reason = account_block_reason(billing)
    if block_reason:
        raise HTTPException(status_code=403, detail=block_reason)
    _validate_transfer_number(body.transfer_number)

    composed_prompt = _compose_system_prompt(body.name, body.system_prompt, body.main_goal, body.knowledge_text)

    # The stored system_prompt is the composed prompt only. VAPI-only additions (the
    # language directive and the call-events directive) are added when the assistant
    # payload is built and are never persisted.
    row = {
        "user_id": owner_id,
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

    # Resolved before any VAPI call so an unknown library event fails (with the
    # LibraryError's own HTTP status) before external resources are created.
    try:
        events = resolve_agent_events(owner_id, [e.model_dump() for e in (body.call_events or [])])
    except LibraryError as e:
        raise HTTPException(status_code=e.status, detail=str(e))

    # Without a VAPI key the agent is saved to the database only (no vapi_assistant_id);
    # POST /{agent_id}/sync-vapi can create the assistant later.
    if settings.vapi_api_key:
        tool_ids = await provision_tools_for_agent(owner_id, body.selected_tool_keys or [])
        if events:
            try:
                events_tool_id = await sync_events_tool(body.name, events, None)
            except Exception as e:
                logger.error("VAPI events tool error: %s", e)
                raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
            if events_tool_id:
                tool_ids = (tool_ids or []) + [events_tool_id]
                row["events_tool_id"] = events_tool_id
        # Standalone transferCall tool (shows up in VAPI's Tools library, attached by id)
        if body.transfer_number and body.transfer_number.strip():
            try:
                t = await vapi_client.create_tool(
                    vapi_client.build_transfer_tool_payload(body.name, body.transfer_number)
                )
                transfer_tool_id = t.get("id")
            except Exception as e:
                logger.error("VAPI transfer tool error: %s", e)
                raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
            if transfer_tool_id:
                tool_ids = (tool_ids or []) + [transfer_tool_id]
                row["transfer_tool_id"] = transfer_tool_id
        try:
            # The events directive is appended only if an events tool really exists
            # (sync_events_tool returns None when PUBLIC_API_URL is not configured).
            payload = vapi_client.build_assistant_payload(
                name=body.name,
                voice=body.voice,
                language=body.language,
                system_prompt=composed_prompt + (prompt_directive(events) if row.get("events_tool_id") else ""),
                first_message=body.first_message,
                tool_ids=tool_ids or None,
            )
            vapi_agent = await vapi_client.create_assistant(payload)
            row["vapi_assistant_id"] = vapi_agent.get("id")
        except Exception as e:
            # Don't leave the events tool orphaned in VAPI's Tools library.
            if row.get("events_tool_id"):
                try:
                    await vapi_client.delete_tool(row["events_tool_id"])
                except Exception:
                    pass
            logger.error("VAPI error: %s", e)
            raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    result = supabase.table("ai_agents").insert(row).execute()
    agent = result.data[0] if result.data else None

    # call_events rows reference the agent id, so they are written after the insert.
    if agent and events:
        replace_events(owner_id, agent["id"], events)

    if agent and body.knowledge_text and body.knowledge_text.strip():
        # Best-effort: a failure here does not fail creation, because the text is already
        # part of the composed system prompt saved on the agent.
        try:
            supabase.table("agent_knowledge").insert({
                "user_id": owner_id,
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
    # Nothing is saved or sent to VAPI: this is a single OpenAI completion built from the
    # wizard's unsaved prompt, so it works before the agent exists.
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


@router.post("/test-voice/start")
async def start_voice_test(body: AgentVoiceTestStart, user=Depends(get_current_user)):
    """Create a throwaway VAPI assistant from the in-progress Create-agent wizard form
    so the user can do a real live voice call before the agent is actually saved —
    mirrors the existing "Talk to <agent>" flow (LiveVoiceModal), but against a
    temporary assistant instead of a persisted one. Never touches ai_agents; the caller
    is expected to call DELETE /test-voice/{assistant_id} once the test call ends."""
    if not settings.vapi_api_key:
        raise HTTPException(status_code=503, detail="Voice testing is not available right now.")
    # The request model has no main_goal or knowledge text, so only the base prompt is
    # composed; no tools or call events are attached to the throwaway assistant.
    composed_prompt = _compose_system_prompt(body.name, body.system_prompt, None, None)
    payload = vapi_client.build_assistant_payload(
        # The "[test]" prefix marks the throwaway assistant in VAPI's assistant list.
        name=f"[test] {body.name}",
        voice=body.voice,
        language=body.language,
        system_prompt=composed_prompt,
        first_message=body.first_message,
    )
    try:
        vapi_agent = await vapi_client.create_assistant(payload)
    except Exception as e:
        logger.error("VAPI error: %s", e)
        raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
    assistant_id = vapi_agent.get("id")
    if not assistant_id:
        raise HTTPException(status_code=502, detail="The voice service did not return an assistant id.")
    return {"data": {"vapi_assistant_id": assistant_id}, "error": None}


@router.delete("/test-voice/{assistant_id}")
async def end_voice_test(assistant_id: str, user=Depends(get_current_user)):
    """Best-effort cleanup of a throwaway assistant created by /test-voice/start."""
    # The id is trusted to be one returned by /test-voice/start: it is not checked against
    # ai_agents or the caller's account. Errors (e.g. already deleted) are swallowed so the
    # endpoint always reports success.
    try:
        await vapi_client.delete_assistant(assistant_id)
    except Exception:
        pass
    return {"data": None, "error": None}


@router.post("/analyze-website")
@limiter.limit("10/minute")
async def analyze_agent_website(request: Request, body: AgentAnalyzeWebsite, user=Depends(get_current_user)):
    """Fetch a business's website and suggest a Main Goal + Industry for the Create-agent
    wizard's "Analyze" button."""
    # Rate limited to 10 calls per minute per client IP; slowapi requires the `request`
    # parameter in the signature. Fetch problems (invalid URL, non-public host, site error)
    # are the caller's to fix and return 400; OpenAI failures and unusable results return 502.
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="AI analysis is not configured — add OPENAI_API_KEY on the server.")
    try:
        title, text = await fetch_website_text(body.url)
    except WebsiteFetchError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        result = await analyze_website(title, text)
    except OpenAIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    if not result.get("main_goal"):
        raise HTTPException(status_code=502, detail="Couldn't summarize this website — try a different page.")
    return {"data": result, "error": None}


@router.post("/{agent_id}/sync-vapi")
async def sync_agent_vapi(agent_id: str, user=Depends(get_current_user)):
    """Create the VAPI assistant for an agent that does not have one yet (for example an
    agent saved while VAPI was not configured).

    Idempotent: an agent that already has a vapi_assistant_id is returned unchanged.
    Otherwise it provisions the preset, transferCall and call-events tools the same way
    create_agent does, creates the assistant from the stored prompt and saves the new
    vapi_assistant_id (and tool ids) on the ai_agents row. Returns 400 when VAPI is not
    configured, 404 for an agent outside the caller's account and 502 on VAPI errors.
    """
    owner_id = resolve_owner_id(user["user_id"])
    if not settings.vapi_api_key:
        raise HTTPException(status_code=400, detail="The voice service is not configured on this server.")

    agent_res = (
        supabase.table("ai_agents")
        .select("*")
        .eq("id", agent_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    agent = agent_res.data
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Already synced: nothing to create, which also stops a repeated call from making a
    # second assistant.
    if agent.get("vapi_assistant_id"):
        return {"data": agent, "error": None}

    tool_ids = await provision_tools_for_agent(owner_id, agent.get("selected_tool_keys") or [])
    # Reuse the stored transfer tool id; a new tool is created only when a transfer
    # number is set but no tool exists yet.
    transfer_tool_id = agent.get("transfer_tool_id")
    if agent.get("transfer_number") and str(agent["transfer_number"]).strip() and not transfer_tool_id:
        try:
            t = await vapi_client.create_tool(
                vapi_client.build_transfer_tool_payload(agent["name"], agent["transfer_number"])
            )
            transfer_tool_id = t.get("id")
        except Exception as e:
            logger.error("VAPI transfer tool error: %s", e)
            raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
    if transfer_tool_id:
        tool_ids = (tool_ids or []) + [transfer_tool_id]
    events = get_events(agent_id)
    events_tool_id = agent.get("events_tool_id")
    if events:
        # Passing the saved events_tool_id lets sync_events_tool update that tool in place
        # instead of creating a duplicate.
        try:
            events_tool_id = await sync_events_tool(agent["name"], events, events_tool_id)
        except Exception as e:
            logger.error("VAPI events tool error: %s", e)
            raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
        if events_tool_id:
            tool_ids = (tool_ids or []) + [events_tool_id]
    try:
        # The stored prompt is already fully composed (goal and knowledge included), so it
        # is sent as-is plus the VAPI-only events directive.
        payload = vapi_client.build_assistant_payload(
            name=agent["name"],
            voice=agent.get("voice"),
            language=agent.get("language"),
            system_prompt=(agent.get("system_prompt") or "") + (prompt_directive(events) if events_tool_id else ""),
            first_message=agent.get("first_message"),
            tool_ids=tool_ids or None,
        )
        vapi_agent = await vapi_client.create_assistant(payload)
        vapi_assistant_id = vapi_agent.get("id")
    except Exception as e:
        logger.error("VAPI error: %s", e)
        raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    result = (
        supabase.table("ai_agents")
        .update({"vapi_assistant_id": vapi_assistant_id, "transfer_tool_id": transfer_tool_id,
                 "events_tool_id": events_tool_id})
        .eq("id", agent_id)
        .eq("user_id", owner_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{agent_id}")
async def get_agent(agent_id: str, user=Depends(get_current_user)):
    """Return one agent of the caller's account. `data` is null (not a 404) when the id does
    not exist or belongs to another account."""
    result = (
        supabase.table("ai_agents")
        .select("*")
        .eq("id", agent_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.get("/{agent_id}/events")
async def list_agent_events(agent_id: str, user=Depends(get_current_user)):
    """List the call events configured on an agent, in display order. 404 if the agent is
    not in the caller's account."""
    # get_events filters by agent_id only, so ownership has to be verified first.
    owned = (
        supabase.table("ai_agents")
        .select("id")
        .eq("id", agent_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not owned.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    return {"data": get_events(agent_id), "error": None}


@router.patch("/{agent_id}")
async def update_agent(agent_id: str, body: AgentUpdate, user=Depends(get_current_user)):
    """Partially update an agent and push the change to its VAPI assistant.

    Only fields present in the body change (null/omitted fields are ignored; send "" or []
    to clear a value). An empty body returns data=null with error "No fields to update".
    When the agent has a VAPI assistant, the matching name, first message, prompt, tools,
    voice, language and transcriber are patched there first; a VAPI failure returns 502 and
    leaves the ai_agents row unchanged. call_events, if present, is the agent's complete
    event list and replaces the stored one. 404 if the agent is not in the caller's account.
    """
    owner_id = resolve_owner_id(user["user_id"])
    # exclude_none: a field left out (or null) means "leave unchanged".
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    if "transfer_number" in updates:
        _validate_transfer_number(updates["transfer_number"])
    # Call events arrive as the agent's full list; [] clears them.
    new_events = None
    if "call_events" in updates:
        try:
            new_events = resolve_agent_events(owner_id, updates["call_events"])
        except LibraryError as e:
            raise HTTPException(status_code=e.status, detail=str(e))

    # Current values needed to rebuild the VAPI assistant for fields that did not change;
    # the user_id filter doubles as the ownership check.
    agent_res = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id, system_prompt, transfer_number, transfer_tool_id, events_tool_id, name, selected_tool_keys, voice, language")
        .eq("id", agent_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    agent = agent_res.data
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Only real ai_agents columns are written; call_events lives in its own table and is
    # handled separately via replace_events.
    db_updates = {k: v for k, v in updates.items() if k in (
        "name", "voice", "language", "category", "status",
        "system_prompt", "first_message", "main_goal", "website", "selected_tool_keys",
        "transfer_number",
    )}

    # If system_prompt is explicitly provided, use it as-is — the UI shows and edits
    # the full final prompt, so re-composing would double-append the goal section.
    # Only compose when main_goal changes but system_prompt is not being updated.
    # The stored prompt is the base here, so a goal section added earlier stays in it and
    # the new goal is appended after it.
    if "main_goal" in updates and "system_prompt" not in updates:
        existing = (
            supabase.table("ai_agents")
            .select("system_prompt, main_goal, name")
            .eq("id", agent_id)
            .eq("user_id", owner_id)
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

    # Agents without a VAPI assistant are updated in the database only; sync-vapi builds
    # their assistant from the stored row later.
    if settings.vapi_api_key and agent.get("vapi_assistant_id"):
        try:
            # The language the assistant will have after this update. It is also needed when
            # only the voice changes, because the fallback voice depends on the language.
            effective_language = updates.get("language", agent.get("language"))
            # Sparse PATCH body: only the parts that changed are added below.
            vapi_payload: dict = {}
            if "name" in updates:
                vapi_payload["name"] = updates["name"]
            if "first_message" in updates:
                vapi_payload["firstMessage"] = updates["first_message"]
            # Rebuild the model block when the prompt, the transfer number, OR the
            # language changes (Urdu needs a script directive injected — see
            # vapi_client.apply_language_directive). The transfer is a standalone VAPI
            # transferCall tool attached by id, so we recompute the full toolIds (preset
            # tools + transfer tool) to avoid dropping them.
            # Changes to the selected preset tools or the call events land here too, since
            # both feed the same model block (toolIds, and the events directive appended to
            # the prompt).
            if ("system_prompt" in updates or "transfer_number" in updates or "language" in updates
                    or "selected_tool_keys" in updates or new_events is not None):
                events = new_events if new_events is not None else get_events(agent_id)
                events_tool_id = agent.get("events_tool_id")
                # Also (re)create the tool when events exist but it was never made — e.g. the
                # events were saved before PUBLIC_API_URL was configured.
                if new_events is not None or (events and not events_tool_id):
                    events_tool_id = await sync_events_tool(
                        updates.get("name") or agent.get("name"), events, events_tool_id
                    )
                    # Store the resulting id. It is None when no events remain (sync_events_tool
                    # then deletes the VAPI tool) or when no public API URL is configured.
                    db_updates["events_tool_id"] = events_tool_id
                # Preset tools: reuses the account's existing VAPI tool per preset or
                # creates missing ones. Uses the incoming key list if sent, else the saved one.
                preset_ids = await provision_tools_for_agent(
                    owner_id,
                    (updates["selected_tool_keys"] if "selected_tool_keys" in updates else agent.get("selected_tool_keys")) or [],
                )
                transfer_tool_id = agent.get("transfer_tool_id")
                # A non-empty number updates the existing transfer tool (or creates one);
                # an empty string deletes it and clears the stored tool id.
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

                # Every kind of tool goes into one list: the toolIds sent here are the
                # assistant's full set, so leaving one out would detach it.
                all_tool_ids = list(preset_ids or [])
                if transfer_tool_id:
                    all_tool_ids.append(transfer_tool_id)
                if events_tool_id:
                    all_tool_ids.append(events_tool_id)

                # The prompt as saved (new value if one was sent) plus the VAPI-only events
                # directive; the language directive is added by apply_language_directive below.
                effective_prompt = (updates.get("system_prompt", agent.get("system_prompt")) or "") + (
                    prompt_directive(events) if events_tool_id else ""
                )
                # Same provider/model as vapi_client.build_assistant_payload and
                # services/agent_events_sync.py; keep the three in step.
                model_block: dict = {
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "system", "content": vapi_client.apply_language_directive(effective_prompt, effective_language)}],
                }
                if all_tool_ids:
                    model_block["toolIds"] = all_tool_ids
                vapi_payload["model"] = model_block
            # A language change re-resolves the voice too (using the unchanged voice name),
            # because an unrecognized voice falls back to a default that depends on language.
            if "voice" in updates or "language" in updates:
                vapi_payload["voice"] = vapi_client._resolve_voice(
                    updates.get("voice", agent.get("voice")), effective_language
                )
            if "language" in updates:
                vapi_payload["transcriber"] = vapi_client._resolve_transcriber(updates["language"])
            # Skip the VAPI call when nothing VAPI-relevant changed (e.g. only category or status).
            if vapi_payload:
                await vapi_client.update_assistant(agent["vapi_assistant_id"], vapi_payload)
        except Exception as e:
            logger.error("VAPI error: %s", e)
            raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    # Stored only after the VAPI update succeeded, so a failed sync leaves the saved events untouched.
    if new_events is not None:
        replace_events(owner_id, agent_id, new_events)

    if not db_updates:  # e.g. only call_events changed on an agent with no VAPI tool to record
        return {"data": None, "error": None}
    result = (
        supabase.table("ai_agents")
        .update(db_updates)
        .eq("id", agent_id)
        .eq("user_id", owner_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str, user=Depends(get_current_user)):
    """Delete an agent from the caller's account along with its VAPI resources.

    Removes the events tool, the assistant and the transferCall tool in VAPI, then the
    ai_agents row. VAPI cleanup is best-effort (errors are swallowed), so the row is
    deleted even if VAPI is unreachable or a resource is already gone. Returns success
    even when the agent does not exist. In the database, agent_knowledge and call_events
    rows are removed with the agent (ON DELETE CASCADE) while conversations, phone numbers,
    campaigns and voice widgets that referenced it keep existing with agent_id set to null.
    """
    agent_res = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id, transfer_tool_id, events_tool_id")
        .eq("id", agent_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    agent = agent_res.data
    if agent and settings.vapi_api_key and agent.get("events_tool_id"):
        try:
            await vapi_client.delete_tool(agent["events_tool_id"])
        except Exception:
            pass
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

    # The user_id filter limits the delete to agents in the caller's own account.
    supabase.table("ai_agents").delete().eq("id", agent_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}


@router.post("/{agent_id}/knowledge")
async def upload_knowledge(agent_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    """Upload a knowledge document for one of the caller's agents.

    Saves the file to the "knowledge" storage bucket (a local directory on the server) at
    {owner_id}/agents/{agent_id}/{filename}, uploads a copy to VAPI when configured, and
    records the document in agent_knowledge. Returns the new row and the VAPI file id; the
    VAPI id is only returned, not stored or attached to the assistant here. 404 if the agent
    is not in the caller's account, 502 if the VAPI upload fails.
    """
    owner_id = resolve_owner_id(user["user_id"])
    agent_res = (
        supabase.table("ai_agents")
        .select("id, vapi_assistant_id")
        .eq("id", agent_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    if not agent_res.data:
        raise HTTPException(status_code=404, detail="Agent not found")

    content = await file.read()

    # Order matters: the file is stored first, then sent to VAPI, then the row is inserted.
    # If the VAPI upload fails (502) the stored file is left behind with no agent_knowledge row.
    storage_path = f"{owner_id}/agents/{agent_id}/{file.filename}"
    supabase.storage.from_("knowledge").upload(storage_path, content, {"content-type": file.content_type or "application/pdf"})

    vapi_file_id = None
    if settings.vapi_api_key:
        try:
            vapi_file = await vapi_client.upload_file(content, file.filename)
            vapi_file_id = vapi_file.get("id")
        except Exception as e:
            logger.error("VAPI file upload error: %s", e)
            raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    doc_row = {
        "user_id": owner_id,
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
