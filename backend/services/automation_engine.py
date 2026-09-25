import asyncio
import httpx
import logging
from database import supabase
from services.email_service import send_email
from services.sms_service import send_sms
from services import vapi_client, whitelist_service
from routers.billing import get_or_create_billing, check_call_quota

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
    # The graph's node["type"] is only ever "trigger"/"action"/"operator"/"condition"
    # (reactFlowTypeFor groups every Action-kind node under "action") — the specific
    # node kind ("sms", "connect-agent", etc.) lives at node["data"]["kind"], and its
    # user-entered fields live one level deeper at node["data"]["config"] (see
    # NodeEditPanel.tsx). Dispatch on those, not on node["type"].
    data = node.get("data", {}) or {}
    kind = data.get("kind", "")
    config = data.get("config", {}) or {}

    if kind in ("event", "now", "inbound-call", "internet-call"):
        pass  # trigger nodes carry no action of their own

    elif kind == "split":
        pass  # pure structural fan-out — _execute_flow's walk() already visits every
              # outgoing edge for any non-condition node, so a Split node just needs
              # to not raise "unknown kind"; the branching happens via its edges.

    elif kind == "call":
        target_phone = (config.get("to") or "").strip()
        await _connect_call_agent(user_id, config, conversation, target_phone=target_phone or None)

    elif kind == "sms":
        phone = conversation.get("phone", "")
        message = _interpolate(config.get("message", ""), conversation)
        from_number = (config.get("from") or "").strip()
        if not phone:
            logger.warning("SMS node: no phone number in conversation, skipping")
        elif not message:
            logger.warning("SMS node: empty message, skipping")
        else:
            try:
                await send_sms(user_id, phone, message, from_number)
                logger.info(f"SMS node: sent to {phone}")
            except Exception as e:
                logger.error(f"SMS node failed: {e}")
                raise

    elif kind == "email":
        to_email = (config.get("to") or conversation.get("email", "")).strip()
        subject = _interpolate(config.get("subject", "Follow-up"), conversation)
        body = _interpolate(config.get("body", ""), conversation)
        if not to_email:
            logger.warning("Email node: no recipient email, skipping")
        else:
            try:
                await send_email(user_id, to_email, subject, body)
                logger.info(f"Email node: sent to {to_email}")
            except Exception as e:
                logger.error(f"Email node failed: {e}")
                raise

    elif kind == "update-contact":
        # NodeEditPanel.tsx stores this flat (field/value), matching every other
        # node's config shape, rather than a pre-built {column: value} dict.
        contact_id = conversation.get("contact_id")
        field = config.get("field", "")
        value = config.get("value", "")
        updates = {field: value} if field and value and field in ("status", "name", "email") else {}
        if contact_id and updates:
            supabase.table("contacts").update(updates).eq("id", contact_id).eq("user_id", user_id).execute()
            logger.info(f"Updated contact {contact_id}: {updates}")
        elif updates and not contact_id:
            logger.info("Update Contact node: call has no linked contact, skipping")

    elif kind == "delay":
        try:
            duration = float(config.get("duration", 1))
        except (TypeError, ValueError):
            duration = 1
        unit = config.get("unit", "minutes")
        seconds = duration * {"minutes": 60, "hours": 3600, "days": 86400}.get(unit, 60)
        if 0 < seconds <= 300:
            await asyncio.sleep(seconds)
        elif seconds > 300:
            logger.info(f"Delay node: {seconds}s exceeds inline limit, skipping")

    elif kind == "webhook":
        url = config.get("url", "")
        if url:
            payload = {
                "event": "automation_trigger",
                "conversation_id": conversation.get("id"),
                "phone": conversation.get("phone"),
                "contact_name": conversation.get("contact_name"),
            }
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.request(config.get("method", "POST"), url, json=payload)
                logger.info(f"Webhook node: {config.get('method', 'POST')} to {url}")
            except Exception as e:
                logger.error(f"Webhook node failed: {e}")

    elif kind == "connect-agent":
        await _connect_call_agent(user_id, config, conversation)

    elif kind == "condition":
        pass  # evaluated by _evaluate_condition, in the caller

    else:
        logger.warning(f"Unknown node kind: {kind!r}")


async def _connect_call_agent(user_id: str, config: dict, conversation: dict, target_phone: str | None = None):
    """Places a real outbound VAPI call using the agent selected on the node — the
    same call path as POST /telephony/call, including its billing/quota and DNC
    checks, since this fires automatically rather than from a user click.

    Shared by two node kinds: "connect-agent" (calls the conversation's own
    contact back) and "call" (calls a fixed number typed into the node's config,
    e.g. to notify a manager), which passes `target_phone` to override the
    conversation's phone."""
    node_label = "Call" if target_phone is not None else "Connect Call Agent"
    agent_id = config.get("agent_id")
    phone = target_phone or conversation.get("phone")
    if not agent_id:
        raise ValueError(f"{node_label} node: no agent selected")
    if not phone:
        logger.warning(f"{node_label} node: no phone number to call, skipping")
        return

    billing = get_or_create_billing(user_id)
    if not billing.get("is_active", True):
        logger.warning(f"{node_label} node: account deactivated, skipping")
        return
    if not check_call_quota(user_id, "outbound"):
        logger.warning(f"{node_label} node: balance empty, skipping")
        return

    screen = await whitelist_service.check_number(user_id, phone)
    if not screen["allowed"]:
        logger.warning(f"{node_label} node: {phone} is suppressed ({screen['reason']}), skipping")
        return

    agent = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", agent_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    if not agent.data or not agent.data.get("vapi_assistant_id"):
        raise ValueError(f"{node_label} node: agent {agent_id} not found or has no VAPI assistant")

    candidate_numbers = (
        supabase.table("phone_numbers")
        .select("vapi_phone_id")
        .eq("user_id", user_id)
        .eq("status", "Active")
        .not_.is_("vapi_phone_id", "null")
        .order("updated_at", desc=True)
        .limit(5)
        .execute()
    )
    vapi_phone_ids = [r["vapi_phone_id"] for r in (candidate_numbers.data or [])]

    call_payload = {
        "assistantId": agent.data["vapi_assistant_id"],
        "customer": {"number": phone},
    }

    result = None
    last_error: Exception | None = None
    # A stored vapi_phone_id can go stale if the number was removed on VAPI's side
    # outside this app (e.g. released, or an org/project change) — try the next
    # candidate rather than failing the whole flow over one bad number.
    for vapi_phone_id in vapi_phone_ids or [None]:
        attempt_payload = dict(call_payload)
        if vapi_phone_id:
            attempt_payload["phoneNumberId"] = vapi_phone_id
        try:
            result = await vapi_client.create_call(attempt_payload)
            last_error = None
            break
        except Exception as e:
            last_error = e
            if "does not exist" not in str(e):
                raise
            logger.warning(f"{node_label} node: phoneNumberId {vapi_phone_id} is stale ({e}); trying next number")

    if last_error:
        raise last_error

    logger.info(f"{node_label} node: placed call {result.get('id')} to {phone} via agent {agent_id}")


def _evaluate_condition(node: dict, conversation: dict) -> bool:
    config = (node.get("data", {}) or {}).get("config", {}) or {}
    field = config.get("field", "status")
    operator = config.get("op", "equals")
    value = config.get("value", "")

    actual = conversation.get(field, "")

    if operator == "equals":
        return str(actual).lower() == str(value).lower()
    elif operator == "not_equals":
        return str(actual).lower() != str(value).lower()
    elif operator == "contains":
        return str(value).lower() in str(actual).lower()
    elif operator in ("gt", "lt"):
        try:
            a, v = float(actual), float(value)
        except (TypeError, ValueError):
            return False
        return a > v if operator == "gt" else a < v
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
