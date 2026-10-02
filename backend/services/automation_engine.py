import asyncio
import json
import httpx
import logging
from datetime import datetime, timedelta, timezone
from database import supabase
from services.email_service import send_email
from services.sms_service import send_sms
from services import vapi_client, whitelist_service
from services.call_events import get_hits
from routers.billing import outbound_call_block_reason, get_or_create_billing, check_call_quota

logger = logging.getLogger(__name__)

# Delays up to this long just sleep inline; anything longer is persisted to
# automation_pending_steps and resumed by delayed_steps_loop, so a 1-day Delay no
# longer fires its downstream nodes immediately (and survives a restart).
INLINE_DELAY_MAX_SECONDS = 60
DELAYED_STEPS_POLL_SECONDS = 30


async def run_post_call_automations(user_id: str, conversation: dict):
    # Expose the events raised during the call to flow conditions/templates:
    # `call_events` (comma-separated event keys) and `call_outcome` (final outcome).
    if conversation.get("vapi_call_id"):
        try:
            conversation["call_events"] = ", ".join(
                h["event_key"] for h in get_hits(conversation["vapi_call_id"])
            )
        except Exception as e:
            logger.warning(f"could not load call events for automation: {e}")

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

        await _run_flow(user_id, flow, definition, conversation, "call_ended")


def create_manual_run(user_id: str, flow: dict) -> tuple[dict, str | None]:
    """Prepares a manual ("Now" trigger) run: builds the stand-in conversation from the
    Now node's config and records the run. Returns (conversation, run_id) — the caller
    then awaits execute_manual_run() (typically as a background task)."""
    definition = flow.get("definition") or {}
    now_node = next(
        (n for n in definition.get("nodes", []) if (n.get("data") or {}).get("kind") == "now"),
        None,
    )
    if not now_node:
        raise ValueError("This flow has no Now trigger")
    config = (now_node.get("data") or {}).get("config") or {}
    conversation = {
        "id": None,
        "phone": (config.get("phone") or "").strip(),
        "email": (config.get("email") or "").strip(),
        "contact_name": (config.get("contact_name") or "").strip(),
        "status": "manual",
    }
    run_id = _create_run(user_id, flow, conversation, "manual")
    return conversation, run_id


async def execute_manual_run(user_id: str, flow: dict, conversation: dict, run_id: str | None):
    await _execute_and_record(
        user_id, flow, flow.get("definition") or {}, conversation, run_id,
        start_kinds=MANUAL_TRIGGER_KINDS,
    )


def _create_run(user_id: str, flow: dict, conversation: dict, trigger_event: str) -> str | None:
    run_row = {
        "user_id": user_id,
        "flow_id": flow["id"],
        "trigger_event": trigger_event,
        "status": "running",
        "input_data": {
            "conversation_id": conversation.get("id"),
            "phone": conversation.get("phone"),
            "contact_name": conversation.get("contact_name"),
            "status": conversation.get("status"),
            "call_outcome": conversation.get("call_outcome"),
            "call_events": conversation.get("call_events"),
            "transcript": (conversation.get("transcript") or "")[:500],
        },
    }
    run_result = supabase.table("automation_runs").insert(run_row).execute()
    return run_result.data[0]["id"] if run_result.data else None


async def _run_flow(user_id: str, flow: dict, definition: dict, conversation: dict, trigger_event: str):
    run_id = _create_run(user_id, flow, conversation, trigger_event)
    await _execute_and_record(user_id, flow, definition, conversation, run_id, start_kinds=CALL_TRIGGER_KINDS)


# A flow can hold several trigger nodes; each run only walks the ones that match how
# it was started, so e.g. pressing "Run now" doesn't also fire the Call Ended branch.
CALL_TRIGGER_KINDS = {"inbound-call", "internet-call"}
MANUAL_TRIGGER_KINDS = {"now"}


async def _execute_and_record(
    user_id: str, flow: dict, definition: dict, conversation: dict, run_id: str | None,
    start_kinds: set | None = None,
):
    try:
        nodes = definition.get("nodes", [])
        edges = definition.get("edges", [])
        scheduled = await _execute_flow(
            user_id, nodes, edges, conversation, flow_id=flow["id"], run_id=run_id,
            start_kinds=start_kinds,
        )

        if run_id:
            output = {"nodes_executed": len(nodes)}
            if scheduled:
                output["delayed_steps_scheduled"] = scheduled
            supabase.table("automation_runs").update({
                "status": "success",
                "output_data": output,
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


def _delay_seconds(config: dict) -> float:
    try:
        duration = float(config.get("duration", 1))
    except (TypeError, ValueError):
        duration = 1
    unit = config.get("unit", "minutes")
    return duration * {"minutes": 60, "hours": 3600, "days": 86400}.get(unit, 60)


def _schedule_delayed_step(user_id: str, flow_id, run_id, node_id: str, seconds: float, conversation: dict):
    # Round-trip through JSON so datetimes/UUIDs in the conversation row are storable.
    snapshot = json.loads(json.dumps(conversation, default=str))
    supabase.table("automation_pending_steps").insert({
        "user_id": user_id,
        "flow_id": flow_id,
        "run_id": run_id,
        "node_id": node_id,
        "conversation": snapshot,
        "resume_at": (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(),
        "status": "pending",
    }).execute()
    logger.info(f"Delay node {node_id}: scheduled downstream nodes in {seconds:.0f}s")


async def _execute_flow(
    user_id: str,
    nodes: list,
    edges: list,
    conversation: dict,
    flow_id=None,
    run_id=None,
    resume_after: str | None = None,
    start_kinds: set | None = None,
) -> int:
    """Walks the graph. Returns how many long Delay nodes were scheduled for later.
    `resume_after` = a Delay node id: skip running it and continue from its edges."""
    edge_map = {}
    for edge in edges:
        src = edge.get("source")
        if src not in edge_map:
            edge_map[src] = []
        edge_map[src].append(edge)

    start_nodes = [n for n in nodes if n.get("type") == "trigger"]
    if start_kinds:
        matching = [n for n in start_nodes if (n.get("data") or {}).get("kind") in start_kinds]
        start_nodes = matching or start_nodes  # legacy flows with only an old trigger kind
    if not start_nodes:
        start_nodes = nodes[:1] if nodes else []

    node_map = {n["id"]: n for n in nodes}
    visited = set()
    scheduled = 0

    async def walk(node_id: str, skip_exec: bool = False):
        nonlocal scheduled
        if node_id in visited:
            return
        visited.add(node_id)

        node = node_map.get(node_id)
        if not node:
            return

        kind = (node.get("data") or {}).get("kind", "")

        if not skip_exec:
            if kind == "delay":
                config = (node.get("data") or {}).get("config") or {}
                seconds = _delay_seconds(config)
                if seconds > INLINE_DELAY_MAX_SECONDS:
                    if not flow_id:
                        raise RuntimeError("Delay node: cannot schedule a long delay without a flow id")
                    _schedule_delayed_step(user_id, flow_id, run_id, node_id, seconds, conversation)
                    scheduled += 1
                    return  # downstream nodes resume from delayed_steps_loop
            await _execute_node(user_id, node, conversation)

        branches = []
        for edge in edge_map.get(node_id, []):
            target = edge.get("target")
            condition_handle = edge.get("sourceHandle")

            if node.get("type") == "condition" and condition_handle:
                result = _evaluate_condition(node, conversation)
                if (condition_handle == "yes" and result) or (condition_handle == "no" and not result):
                    branches.append(target)
            else:
                branches.append(target)

        if kind == "split" and len(branches) > 1:
            # True fan-out: every branch runs concurrently and one failing doesn't stop
            # the others. The run is still marked failed (first error re-raised after all
            # branches finish).
            results = await asyncio.gather(*(walk(t) for t in branches), return_exceptions=True)
            errors = [r for r in results if isinstance(r, BaseException)]
            for err in errors:
                logger.error(f"Split branch failed: {err}")
            if errors:
                raise errors[0]
        else:
            for target in branches:
                await walk(target)

    if resume_after:
        await walk(resume_after, skip_exec=True)
    else:
        for start_node in start_nodes:
            await walk(start_node["id"])
    return scheduled


async def run_due_delayed_steps() -> int:
    """Resumes every Delay whose resume_at has passed. Each row is claimed atomically
    (pending -> processing) so a slow pass can't double-run it; a crash mid-run leaves
    the row in 'processing' rather than risking a duplicate SMS/call."""
    now = datetime.now(timezone.utc).isoformat()
    due = (
        supabase.table("automation_pending_steps")
        .select("*")
        .eq("status", "pending")
        .lte("resume_at", now)
        .order("resume_at")
        .limit(50)
        .execute()
    )
    ran = 0
    for step in (due.data or []):
        claimed = (
            supabase.table("automation_pending_steps")
            .update({"status": "processing"})
            .eq("id", step["id"])
            .eq("status", "pending")
            .execute()
        )
        if not claimed.data:
            continue  # another pass got it
        await _resume_step(step)
        ran += 1
    return ran


def _is_manual_run(run_id) -> bool:
    if not run_id:
        return False
    rows = supabase.table("automation_runs").select("trigger_event").eq("id", run_id).execute().data
    return bool(rows) and rows[0].get("trigger_event") == "manual"


async def _resume_step(step: dict):
    status, error = "done", None
    try:
        rows = (
            supabase.table("automation_flows")
            .select("*")
            .eq("id", step["flow_id"])
            .eq("user_id", step["user_id"])
            .execute()
        ).data
        flow = rows[0] if rows else None
        if not flow or not flow.get("definition") or (
            flow.get("status") != "Active" and not _is_manual_run(step.get("run_id"))
        ):
            # A manual "Run now" was asked for explicitly, so pausing the flow afterwards
            # doesn't cancel it; automatic (call-ended) runs do stop when paused.
            status, error = "cancelled", "flow deleted, paused or empty"
        else:
            definition = flow["definition"]
            await _execute_flow(
                step["user_id"],
                definition.get("nodes", []),
                definition.get("edges", []),
                step.get("conversation") or {},
                flow_id=flow["id"],
                run_id=step.get("run_id"),
                resume_after=step["node_id"],
            )
    except Exception as e:
        logger.error(f"Delayed step {step['id']} failed: {e}")
        status, error = "failed", str(e)
    supabase.table("automation_pending_steps").update({
        "status": status,
        "error": error,
        "completed_at": "now()",
    }).eq("id", step["id"]).execute()


async def delayed_steps_loop() -> None:
    """NOTE: in-process loop, single worker/replica assumed (same as sync_loop)."""
    logger.info(f"automation: delayed-step scheduler started (every {DELAYED_STEPS_POLL_SECONDS}s)")
    while True:
        try:
            await run_due_delayed_steps()
        except Exception as e:
            logger.warning(f"automation: delayed-step pass failed: {e}")
        await asyncio.sleep(DELAYED_STEPS_POLL_SECONDS)


async def _execute_node(user_id: str, node: dict, conversation: dict):
    # The graph's node["type"] is only ever "trigger"/"action"/"operator"/"condition"
    # (reactFlowTypeFor groups every Action-kind node under "action") — the specific
    # node kind ("sms", "connect-agent", etc.) lives at node["data"]["kind"], and its
    # user-entered fields live one level deeper at node["data"]["config"] (see
    # NodeEditPanel.tsx). Dispatch on those, not on node["type"].
    data = node.get("data", {}) or {}
    kind = data.get("kind", "")
    config = data.get("config", {}) or {}

    if kind in ("event", "now", "inbound-call", "internet-call"):  # event/internet-call: legacy saved flows
        pass  # trigger nodes carry no action of their own

    elif kind == "split":
        pass  # pure structural fan-out — _execute_flow's walk() already visits every
              # outgoing edge for any non-condition node, so a Split node just needs
              # to not raise "unknown kind"; the branching happens via its edges.

    elif kind == "call":
        target_phone = (config.get("to") or "").strip()
        await _connect_call_agent(user_id, config, conversation, target_phone=target_phone or None)

    elif kind == "sms":
        phone = (config.get("to") or conversation.get("phone") or "").strip()
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
        integration_id = (config.get("integration_id") or "").strip() or None
        if not to_email:
            logger.warning("Email node: no recipient email, skipping")
        else:
            try:
                await send_email(user_id, to_email, subject, body, integration_id=integration_id)
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
        # Long delays never reach here (walk() schedules them); this is the short inline wait.
        seconds = _delay_seconds(config)
        if 0 < seconds <= INLINE_DELAY_MAX_SECONDS:
            await asyncio.sleep(seconds)

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
    block_reason = outbound_call_block_reason(billing)
    if block_reason:
        logger.warning(f"{node_label} node: {block_reason}, skipping")
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
        raise ValueError(f"{node_label} node: agent {agent_id} not found or is not set up for calls")

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
        "{{call_outcome}}": conversation.get("call_outcome", ""),
        "{{call_events}}": conversation.get("call_events", ""),
    }
    result = template
    for key, val in replacements.items():
        result = result.replace(key, str(val) if val else "")
    return result
