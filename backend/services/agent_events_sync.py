"""
Push an agent's current call events to VAPI (its `trigger_event` tool and the events
section of its system prompt). Used when a shared library event is edited or deleted,
which changes every agent that uses it.
"""

import logging
from database import supabase
from config import settings
from services import vapi_client
from services.agent_tools import provision_tools_for_agent
from services.call_events import get_events, sync_events_tool, prompt_directive

logger = logging.getLogger(__name__)


async def resync_agent_events(agent_id: str) -> str | None:
    """Re-sync one agent with VAPI. Returns the agent's name if the sync failed, or None
    on success (including when there is nothing to push because VAPI isn't configured)."""
    # Loaded by id only, with no owner filter: callers (routers/call_events.py) pass ids taken
    # from the event library. An agent that no longer exists is skipped and counts as success.
    agent = (
        supabase.table("ai_agents").select("*").eq("id", agent_id).maybe_single().execute().data
    )
    if not agent:
        return None
    try:
        events = get_events(agent_id)
        # Create, update or delete the agent's `trigger_event` tool in VAPI to match its current
        # events. Returns the tool id to keep (None when there are no events), which is
        # saved back to `ai_agents.events_tool_id` only if it changed.
        tool_id = await sync_events_tool(agent["name"], events, agent.get("events_tool_id"))
        if tool_id != agent.get("events_tool_id"):
            supabase.table("ai_agents").update({"events_tool_id": tool_id}).eq("id", agent_id).execute()

        # Only agents that already have a VAPI assistant can be patched. Otherwise the new
        # events tool id is stored locally and used when the assistant is created later.
        if settings.vapi_api_key and agent.get("vapi_assistant_id"):
            # Rebuild the assistant's complete tool list, not just the events tool: preset
            # tools (existing VAPI tools are reused), the call-transfer tool, then the events tool.
            ids = list(await provision_tools_for_agent(agent["user_id"], agent.get("selected_tool_keys") or []) or [])
            if agent.get("transfer_tool_id"):
                ids.append(agent["transfer_tool_id"])
            if tool_id:
                ids.append(tool_id)
            # The stored system prompt plus the events directive; the directive is appended only
            # when the events tool exists, and is never saved to `ai_agents.system_prompt`.
            # The language directive is applied on top, as when the assistant was created.
            prompt = (agent.get("system_prompt") or "") + (prompt_directive(events) if tool_id else "")
            # The full `model` block is sent (provider, model, prompt, tools), mirroring
            # vapi_client.build_assistant_payload, so the tool list and prompt stay consistent
            # with an assistant created from scratch. Tool ids go in `model.toolIds`.
            model: dict = {
                "provider": "openai",
                "model": "gpt-4o-mini",
                "messages": [{"role": "system",
                              "content": vapi_client.apply_language_directive(prompt, agent.get("language"))}],
            }
            if ids:
                model["toolIds"] = ids
            await vapi_client.update_assistant(agent["vapi_assistant_id"], {"model": model})
        return None
    except Exception as e:  # noqa: BLE001 — reported to the caller, never raised
        logger.warning("resync of agent %s events failed: %s", agent_id, e)
        # Only the agent's name goes back to the UI — provider error text stays in the log.
        return str(agent.get("name") or agent_id)


async def resync_agents(agent_ids: list[str]) -> list[str]:
    """Re-sync several agents; returns the names of the agents that failed."""
    # Agents are synced one after another (not concurrently); a failure never stops the rest.
    errors = []
    for aid in agent_ids:
        err = await resync_agent_events(aid)
        if err:
            errors.append(err)
    return errors
