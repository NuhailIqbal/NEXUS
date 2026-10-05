"""Execution engine for automation flows (the node graphs built in the dashboard Flow editor).

Entry points:
- run_post_call_automations: fires every Active flow with a call-ended trigger. Called from
  routers/webhooks.py (post-call processing) and services/vapi_sync.py (poll import).
- create_manual_run / execute_manual_run: the "Run now" path used by routers/automation.py.
- delayed_steps_loop / run_due_delayed_steps: background poller, started in main.py, that
  resumes flows parked on a long Delay node.

Tables: automation_flows (read), automation_runs (write), automation_pending_steps
(read/write), contacts (update-contact node), ai_agents and phone_numbers (call nodes).
External services: VAPI (outbound calls), Twilio via sms_service, email_service, and
user-configured webhook URLs via httpx.
"""
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
# How often delayed_steps_loop polls for due steps, so a resumed step can start up to
# roughly this long after its resume_at.
DELAYED_STEPS_POLL_SECONDS = 30


async def run_post_call_automations(user_id: str, conversation: dict):
    """Run every Active call-ended flow of `user_id` for a call that just ended.

    `conversation` is the call's conversations row; it is mutated in place (a `call_events`
    key is added) so conditions and message templates can use it. Each matching flow gets
    its own automation_runs row and runs one after another; a failure inside a flow is
    recorded on that run and does not stop the remaining flows.
    """
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

        # The Flow editor writes definition.trigger.event on save: "call_ended" when the graph
        # has an inbound-call/internet-call trigger node, otherwise "manual". The engine gates
        # on this field rather than inspecting the node graph.
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
    """Execute a manual run prepared by create_manual_run(). Only "now" trigger nodes are
    used as start points, and the outcome is written to the automation_runs row `run_id`."""
    await _execute_and_record(
        user_id, flow, flow.get("definition") or {}, conversation, run_id,
        start_kinds=MANUAL_TRIGGER_KINDS,
    )


def _create_run(user_id: str, flow: dict, conversation: dict, trigger_event: str) -> str | None:
    """Insert an automation_runs row with status "running" and return its id (None if the
    insert returned no row). `trigger_event` is "call_ended" or "manual". input_data stores
    a small snapshot of the conversation (key fields, with the transcript truncated)."""
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
            # Truncated so a long transcript does not bloat the run row.
            "transcript": (conversation.get("transcript") or "")[:500],
        },
    }
    run_result = supabase.table("automation_runs").insert(run_row).execute()
    return run_result.data[0]["id"] if run_result.data else None


async def _run_flow(user_id: str, flow: dict, definition: dict, conversation: dict, trigger_event: str):
    """Create a run row for an automatic trigger and execute the flow from its call-trigger
    nodes (inbound-call / internet-call)."""
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
    """Run the flow graph and finalize its automation_runs row; never raises for flow errors.

    On success the run is marked "success" with output_data {nodes_executed, and
    delayed_steps_scheduled when any long Delay was parked}. nodes_executed is the total
    node count of the definition, not the number actually visited. Any exception is logged
    and stored as status "failed" with the error text. With run_id None the flow still
    runs but nothing is recorded.
    """
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
    """Convert a Delay node config ({duration, unit}) to seconds. Defaults to 1 minute; an
    unparseable duration counts as 1, and an unrecognized unit is treated as minutes."""
    try:
        duration = float(config.get("duration", 1))
    except (TypeError, ValueError):
        duration = 1
    unit = config.get("unit", "minutes")
    return duration * {"minutes": 60, "hours": 3600, "days": 86400}.get(unit, 60)


def _schedule_delayed_step(user_id: str, flow_id, run_id, node_id: str, seconds: float, conversation: dict):
    """Park a long Delay node: insert an automation_pending_steps row (status "pending")
    that run_due_delayed_steps() picks up once `seconds` have elapsed. `node_id` is the
    Delay node, and the stored conversation snapshot is replayed when the flow resumes."""
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
    # Adjacency list: source node id -> the edges leaving that node.
    edge_map = {}
    for edge in edges:
        src = edge.get("source")
        if src not in edge_map:
            edge_map[src] = []
        edge_map[src].append(edge)

    # Entry points are the trigger nodes; start_kinds narrows them to the kinds matching
    # how this run was started.
    start_nodes = [n for n in nodes if n.get("type") == "trigger"]
    if start_kinds:
        matching = [n for n in start_nodes if (n.get("data") or {}).get("kind") in start_kinds]
        start_nodes = matching or start_nodes  # legacy flows with only an old trigger kind
    # A graph with no trigger node at all starts from its first node.
    if not start_nodes:
        start_nodes = nodes[:1] if nodes else []

    node_map = {n["id"]: n for n in nodes}
    # Shared by every branch of this execution: each node runs at most once, which also
    # stops cycles and a node reachable by several paths from running repeatedly.
    visited = set()
    scheduled = 0

    async def walk(node_id: str, skip_exec: bool = False):
        """Depth-first traversal step: execute the node (unless `skip_exec`), then follow
        its outgoing edges. A node failure propagates to the caller: sequential walking stops
        at the first failure, whereas Split branches all finish before the error is raised."""
        nonlocal scheduled
        if node_id in visited:
            return
        visited.add(node_id)

        node = node_map.get(node_id)
        if not node:
            return

        kind = (node.get("data") or {}).get("kind", "")

        # skip_exec is set only for the Delay node a resumed step continues from, so that
        # node is not run (and parked) a second time.
        if not skip_exec:
            if kind == "delay":
                config = (node.get("data") or {}).get("config") or {}
                seconds = _delay_seconds(config)
                # Long delay: persist it and end this branch here; the nodes after it run
                # later via _resume_step.
                if seconds > INLINE_DELAY_MAX_SECONDS:
                    if not flow_id:
                        raise RuntimeError("Delay node: cannot schedule a long delay without a flow id")
                    _schedule_delayed_step(user_id, flow_id, run_id, node_id, seconds, conversation)
                    scheduled += 1
                    return  # downstream nodes resume from delayed_steps_loop
            await _execute_node(user_id, node, conversation)

        # Choose the edges to follow. An edge leaving a Condition node carries a sourceHandle
        # of "yes" or "no" and is followed only when it matches the condition result; every
        # other edge is followed unconditionally.
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

    # Resuming after a Delay: continue from that node's outgoing edges only; the trigger
    # nodes are not walked again.
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
    # Oldest due steps first, at most 50 per pass (steps are resumed one at a time); the
    # rest wait for the next poll.
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
        # Compare-and-swap: the UPDATE only matches while status is still 'pending', so just
        # one pass gets a row back and runs the step.
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
    """True if the automation_runs row `run_id` was started by "Run now" (trigger_event is
    "manual"); False for automatic runs, a missing run or a missing id."""
    if not run_id:
        return False
    rows = supabase.table("automation_runs").select("trigger_event").eq("id", run_id).execute().data
    return bool(rows) and rows[0].get("trigger_event") == "manual"


async def _resume_step(step: dict):
    """Continue a flow from the node after a parked Delay and record the result on the
    automation_pending_steps row as "done", "cancelled" (flow gone, paused or empty) or
    "failed" (with the error text). Never raises. The original automation_runs row is not
    updated here, so a failure in the resumed part shows up only on the pending step."""
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
            # The conversation is the JSON snapshot taken when the step was parked, so
            # datetimes and UUIDs in it are plain strings by now.
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
        # Swallow errors so a failed pass cannot end the loop; it is started once at app
        # startup and nothing restarts it.
        try:
            await run_due_delayed_steps()
        except Exception as e:
            logger.warning(f"automation: delayed-step pass failed: {e}")
        await asyncio.sleep(DELAYED_STEPS_POLL_SECONDS)


async def _execute_node(user_id: str, node: dict, conversation: dict):
    """Perform one node's action against the conversation context.

    Side effects by kind: sms/email send a message, call/connect-agent place an outbound
    VAPI call, update-contact writes the contacts table, webhook makes an HTTP request, and
    a short delay sleeps. Trigger, split and condition nodes do nothing here. Errors from
    sms, email, call and DB writes propagate and fail the run; a failing webhook is only
    logged; an unknown kind logs a warning and is skipped.
    """
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
        # A blank `to` becomes None, so _connect_call_agent falls back to the conversation's
        # own phone number just like a connect-agent node.
        target_phone = (config.get("to") or "").strip()
        await _connect_call_agent(user_id, config, conversation, target_phone=target_phone or None)

    elif kind == "sms":
        # A recipient set on the node wins over the conversation's own phone number. An
        # empty `from` leaves the choice of sender number to send_sms.
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
                # Log, then re-raise so _execute_and_record marks the run as failed.
                logger.error(f"SMS node failed: {e}")
                raise

    elif kind == "email":
        to_email = (config.get("to") or conversation.get("email", "")).strip()
        subject = _interpolate(config.get("subject", "Follow-up"), conversation)
        body = _interpolate(config.get("body", ""), conversation)
        # Optionally pins one of the account's email integrations; None lets email_service
        # use whichever one is configured.
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
        # Only status, name and email can be set (an allow-list, since the field name comes
        # from user-edited flow JSON), and the update is limited to this account's own
        # contact via user_id. Empty field/value, or a call with no linked contact, is a no-op.
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
            # Unlike sms/email, a failed webhook is logged and does not fail the run; HTTP
            # error statuses in the response are not checked either.
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
    # A missing agent is a misconfigured flow and raises (the run fails). Everything below
    # that blocks the call (no phone, billing/quota, suppression list) only logs and
    # returns, so the run still ends as "success" without a call having been placed.
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

    # Filtering on user_id means a flow can only call with agents of its own account.
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

    # Caller-ID candidates: up to 5 of the account's active numbers that are registered
    # with VAPI, most recently updated first. They are tried in order below.
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
    # `or [None]` makes a single attempt without phoneNumberId when no number qualified.
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
            # Only an error whose message contains "does not exist" (a stale phoneNumberId)
            # moves on to the next number; any other failure aborts immediately.
            if "does not exist" not in str(e):
                raise
            logger.warning(f"{node_label} node: phoneNumberId {vapi_phone_id} is stale ({e}); trying next number")

    # Reached only when every candidate number failed with a stale-number error.
    if last_error:
        raise last_error

    logger.info(f"{node_label} node: placed call {result.get('id')} to {phone} via agent {agent_id}")


def _evaluate_condition(node: dict, conversation: dict) -> bool:
    """Return the yes/no result of a Condition node for this conversation.

    Node config: `field` (a conversations key, default "status"), `op` (equals, not_equals,
    contains, gt, lt; default equals) and `value`. The string operators ignore case; gt/lt
    compare numbers and are False when either side is not numeric. An unknown operator is False.
    """
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
    """Fill the {{contact_name}}, {{phone}}, {{status}}, {{duration}}, {{call_outcome}} and
    {{call_events}} placeholders of an SMS/email template from the conversation. Other
    placeholders are left untouched; a missing or falsy value (including a duration of 0)
    becomes an empty string."""
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
