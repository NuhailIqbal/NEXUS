import asyncio
import httpx
import logging
from database import supabase

logger = logging.getLogger(__name__)


async def run_post_call_automations(user_id: str, conversation: dict):
    flows = (
        supabase.table("automation_flows")
        .select("*")
        .eq("user_id", user_id)
        .eq("status", "Active")
        .execute()
    )

    for flow in (flows.data or []):
        definition = flow.get("definition")
        if not definition:
            continue

        trigger = definition.get("trigger", {})
        if trigger.get("event") != "call_ended":
            continue

        run_row = {
            "user_id": user_id,
            "flow_id": flow["id"],
            "trigger_event": "call_ended",
            "status": "running",
            "input_data": {
                "conversation_id": conversation.get("id"),
                "phone": conversation.get("phone"),
                "contact_name": conversation.get("contact_name"),
                "status": conversation.get("status"),
                "transcript": (conversation.get("transcript") or "")[:500],
            },
        }
        run_result = supabase.table("automation_runs").insert(run_row).execute()
        run_id = run_result.data[0]["id"] if run_result.data else None

        try:
            nodes = definition.get("nodes", [])
            edges = definition.get("edges", [])
            await _execute_flow(user_id, nodes, edges, conversation)

            if run_id:
                supabase.table("automation_runs").update({
                    "status": "success",
                    "output_data": {"nodes_executed": len(nodes)},
                    "completed_at": "now()",
                }).eq("id", run_id).execute()

        except Exception as e:
            logger.error(f"Automation flow {flow['id']} failed: {e}")
            if run_id:
                supabase.table("automation_runs").update({
                    "status": "failed",
                    "output_data": {"error": str(e)},
                    "completed_at": "now()",
                }).eq("id", run_id).execute()


async def _execute_flow(user_id: str, nodes: list, edges: list, conversation: dict):
    edge_map = {}
    for edge in edges:
        src = edge.get("source")
        if src not in edge_map:
            edge_map[src] = []
        edge_map[src].append(edge)

    start_nodes = [n for n in nodes if n.get("type") == "trigger"]
    if not start_nodes:
        start_nodes = nodes[:1] if nodes else []

    node_map = {n["id"]: n for n in nodes}
    visited = set()

    async def walk(node_id: str):
        if node_id in visited:
            return
        visited.add(node_id)

        node = node_map.get(node_id)
        if not node:
            return

        await _execute_node(user_id, node, conversation)

        for edge in edge_map.get(node_id, []):
            target = edge.get("target")
            condition_handle = edge.get("sourceHandle")

            if node.get("type") == "condition" and condition_handle:
                result = _evaluate_condition(node, conversation)
                if condition_handle == "yes" and result:
                    await walk(target)
                elif condition_handle == "no" and not result:
                    await walk(target)
            else:
                await walk(target)

    for start in start_nodes:
        await walk(start["id"])


async def _execute_node(user_id: str, node: dict, conversation: dict):
    node_type = node.get("type", "")
    data = node.get("data", {})

    if node_type == "trigger":
        pass

    elif node_type == "sms":
        phone = conversation.get("phone")
        message = data.get("message", "")
        message = _interpolate(message, conversation)
        logger.info(f"SMS node: would send '{message}' to {phone}")

    elif node_type == "email":
        to_email = data.get("to") or conversation.get("email", "")
        subject = data.get("subject", "Follow-up")
        body = data.get("body", "")
        body = _interpolate(body, conversation)
        logger.info(f"Email node: would send '{subject}' to {to_email}")

    elif node_type == "update_contact":
        contact_id = conversation.get("contact_id")
        if contact_id:
            updates = data.get("updates", {})
            if updates:
                supabase.table("contacts").update(updates).eq("id", contact_id).eq("user_id", user_id).execute()
                logger.info(f"Updated contact {contact_id}: {updates}")

    elif node_type == "delay":
        seconds = data.get("seconds", 0)
        if seconds and seconds <= 300:
            await asyncio.sleep(seconds)
        elif seconds > 300:
            logger.info(f"Delay node: {seconds}s exceeds inline limit, skipping")

    elif node_type == "webhook":
        url = data.get("url", "")
        if url:
            payload = {
                "event": "automation_trigger",
                "conversation_id": conversation.get("id"),
                "phone": conversation.get("phone"),
                "contact_name": conversation.get("contact_name"),
            }
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(url, json=payload)
                logger.info(f"Webhook node: POST to {url}")
            except Exception as e:
                logger.error(f"Webhook node failed: {e}")

    elif node_type == "condition":
        pass

    else:
        logger.warning(f"Unknown node type: {node_type}")


def _evaluate_condition(node: dict, conversation: dict) -> bool:
    data = node.get("data", {})
    field = data.get("field", "status")
    operator = data.get("operator", "equals")
    value = data.get("value", "")

    actual = conversation.get(field, "")

    if operator == "equals":
        return str(actual).lower() == str(value).lower()
    elif operator == "not_equals":
        return str(actual).lower() != str(value).lower()
    elif operator == "contains":
        return str(value).lower() in str(actual).lower()
    elif operator == "exists":
        return bool(actual)
    return False


def _interpolate(template: str, conversation: dict) -> str:
    replacements = {
        "{{contact_name}}": conversation.get("contact_name", ""),
        "{{phone}}": conversation.get("phone", ""),
        "{{status}}": conversation.get("status", ""),
        "{{duration}}": conversation.get("duration", ""),
    }
    result = template
    for key, val in replacements.items():
        result = result.replace(key, str(val) if val else "")
    return result
