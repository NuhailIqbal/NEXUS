"""Automation API: flow CRUD, version history, manual runs and run history.

Mounted under /automation. A flow is a node graph (React Flow JSON stored in
automation_flows.definition) built in the dashboard's Flow editor; executing it is the job
of services/automation_engine.py. Tables used: automation_flows, automation_flow_versions
and automation_runs. Every query is scoped through resolve_owner_id(), so team members
read and write their account owner's flows and runs.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from pydantic import BaseModel, Field
from typing import Literal, Optional
from routers.team import resolve_owner_id
from services import automation_engine
import asyncio
import uuid

router = APIRouter(prefix="/automation", tags=["Automation"])

# Maximum number of definition snapshots kept per flow; older ones are pruned by
# _snapshot_flow_version().
VERSION_HISTORY_LIMIT = 10


def _snapshot_flow_version(user_id: str, flow_id: str, definition: dict) -> None:
    """Persist a snapshot of a flow's definition, keeping at most VERSION_HISTORY_LIMIT per flow."""
    if not definition:
        return

    existing = (
        supabase.table("automation_flow_versions")
        .select("id, version_number")
        .eq("flow_id", flow_id)
        .order("version_number", desc=True)
        .execute()
    )
    rows = existing.data or []
    # Numbers are highest-existing + 1, so they keep increasing even after old versions are
    # pruned. This is a read-then-insert with no lock (the DB connection autocommits).
    next_version = (rows[0]["version_number"] + 1) if rows else 1

    supabase.table("automation_flow_versions").insert({
        "flow_id": flow_id,
        "user_id": user_id,
        "version_number": next_version,
        "definition": definition,
    }).execute()

    if len(rows) >= VERSION_HISTORY_LIMIT:
        # rows are newest-first; delete everything past the limit-1 we just added one more to
        to_delete = rows[VERSION_HISTORY_LIMIT - 1:]
        for r in to_delete:
            supabase.table("automation_flow_versions").delete().eq("id", r["id"]).execute()


# Only "Active" flows are fired by call-ended automations; a "Paused" flow is skipped
# (see services/automation_engine.run_post_call_automations).
FlowStatus = Literal["Active", "Paused"]


def _check_uuid(*values: str, what: str = "Flow") -> None:
    """Ids are uuid columns: a malformed one would raise a DB error (500), so reject it as not found."""
    for v in values:
        try:
            uuid.UUID(str(v))
        except ValueError:
            raise HTTPException(status_code=404, detail=f"{what} not found")


class FlowCreate(BaseModel):
    """Request body for creating a flow. `definition` is the editor's graph JSON
    ({nodes, edges, trigger}); it can be omitted for a blank flow. New flows start Active."""
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    definition: Optional[dict] = None
    status: FlowStatus = "Active"


class FlowUpdate(BaseModel):
    """Partial-update body for a flow. Every field is optional; fields left as None are
    dropped from the update, so none of them can be cleared back to null through this model."""
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    definition: Optional[dict] = None
    status: Optional[FlowStatus] = None


# ── Flows ──

@router.get("/flows")
async def list_flows(user=Depends(get_current_user)):
    """List every automation flow in the caller's account (a team member sees the owner's flows), newest first."""
    result = (
        supabase.table("automation_flows")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("/flows")
async def create_flow(body: FlowCreate, user=Depends(get_current_user)):
    """Create a flow owned by the caller's account (the owner's id, even for a team member) and return the new row. No version snapshot is taken on create."""
    row = body.model_dump()
    row["user_id"] = resolve_owner_id(user["user_id"])
    result = supabase.table("automation_flows").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/flows/{flow_id}")
async def get_flow(flow_id: str, user=Depends(get_current_user)):
    """Return one flow, including its definition. Responds 404 if the id is malformed, unknown, or belongs to another account."""
    _check_uuid(flow_id)
    result = (
        supabase.table("automation_flows")
        .select("*")
        .eq("id", flow_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Flow not found")
    return {"data": result.data, "error": None}


@router.patch("/flows/{flow_id}")
async def update_flow(flow_id: str, body: FlowUpdate, user=Depends(get_current_user)):
    """Partially update a flow (name, description, definition, status) and return the updated row.

    When the definition changes, the definition being replaced is first saved as a version
    snapshot (see the versions endpoints). An empty body returns HTTP 200 with an error
    message; an unknown or foreign flow id matches no row and returns data=null rather than 404.
    """
    _check_uuid(flow_id)
    owner_id = resolve_owner_id(user["user_id"])
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    if "definition" in updates:
        # Snapshot the stored (soon to be replaced) definition before the update below
        # overwrites it. Nothing is saved if the flow has no definition yet.
        current = (
            supabase.table("automation_flows")
            .select("definition")
            .eq("id", flow_id)
            .eq("user_id", owner_id)
            .maybe_single()
            .execute()
        )
        if current.data and current.data.get("definition"):
            _snapshot_flow_version(owner_id, flow_id, current.data["definition"])

    result = (
        supabase.table("automation_flows")
        .update(updates)
        .eq("id", flow_id)
        .eq("user_id", owner_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/flows/{flow_id}/versions")
async def list_flow_versions(flow_id: str, user=Depends(get_current_user)):
    """List a flow's saved version snapshots (id, version_number, created_at; newest first, without the definition body). 404 if the flow is not in the caller's account."""
    _check_uuid(flow_id)
    owner_id = resolve_owner_id(user["user_id"])
    # Verify flow ownership explicitly so an unknown flow gives 404 instead of an empty list.
    owner = (
        supabase.table("automation_flows")
        .select("id")
        .eq("id", flow_id)
        .eq("user_id", owner_id)
        .execute()
    )
    if not owner.data:
        raise HTTPException(status_code=404, detail="Flow not found")

    result = (
        supabase.table("automation_flow_versions")
        .select("id, version_number, created_at")
        .eq("flow_id", flow_id)
        .eq("user_id", owner_id)
        .order("version_number", desc=True)
        .execute()
    )
    return {"data": result.data or [], "error": None}


@router.get("/flows/{flow_id}/versions/{version_id}")
async def get_flow_version(flow_id: str, version_id: str, user=Depends(get_current_user)):
    """Return one saved version of a flow, including its full definition. 404 if the version does not belong to that flow and the caller's account."""
    _check_uuid(flow_id, version_id)
    result = (
        supabase.table("automation_flow_versions")
        .select("*")
        .eq("id", version_id)
        .eq("flow_id", flow_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"data": result.data, "error": None}


@router.post("/flows/{flow_id}/versions/{version_id}/restore")
async def restore_flow_version(flow_id: str, version_id: str, user=Depends(get_current_user)):
    """Roll a flow's definition back to a saved version and return the updated flow row.

    The current definition is snapshotted first, so a restore can itself be undone. Only
    the definition changes (not name or status), and the restored version row is kept.
    """
    _check_uuid(flow_id, version_id)
    owner_id = resolve_owner_id(user["user_id"])
    version = (
        supabase.table("automation_flow_versions")
        .select("definition")
        .eq("id", version_id)
        .eq("flow_id", flow_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    if not version.data:
        raise HTTPException(status_code=404, detail="Version not found")

    # Preserve the definition about to be overwritten as a new version.
    current = (
        supabase.table("automation_flows")
        .select("definition")
        .eq("id", flow_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    if current.data and current.data.get("definition"):
        _snapshot_flow_version(owner_id, flow_id, current.data["definition"])

    result = (
        supabase.table("automation_flows")
        .update({"definition": version.data["definition"]})
        .eq("id", flow_id)
        .eq("user_id", owner_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


_manual_runs: set = set()  # strong refs so background runs aren't garbage-collected


@router.post("/flows/{flow_id}/run")
async def run_flow_now(flow_id: str, user=Depends(get_current_user)):
    """Start a manual run of a flow that has a "Now" trigger node and return its run_id right away.

    The flow executes in a background task (Delay nodes can take minutes); follow progress
    through the runs endpoints. The flow's Active/Paused status is not checked. Returns 404
    if the flow is not in the caller's account and 400 if the flow has no Now trigger.
    """
    _check_uuid(flow_id)
    # The string literal below is not the function docstring (it follows a statement, so
    # Python treats it as a plain expression); the docstring above is what /docs shows.
    """Runs a flow that starts with a Now trigger. Executes in the background (Delay
    nodes can take minutes); progress and the outcome show up under Runs."""
    owner_id = resolve_owner_id(user["user_id"])
    result = (
        supabase.table("automation_flows")
        .select("*")
        .eq("id", flow_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    flow = result.data
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")

    try:
        conversation, run_id = automation_engine.create_manual_run(owner_id, flow)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Fire and forget so the HTTP response does not wait for the flow; the done-callback
    # drops the task from _manual_runs once it finishes.
    task = asyncio.create_task(automation_engine.execute_manual_run(owner_id, flow, conversation, run_id))
    _manual_runs.add(task)
    task.add_done_callback(_manual_runs.discard)
    return {"data": {"run_id": run_id}, "error": None}


@router.delete("/flows/{flow_id}")
async def delete_flow(flow_id: str, user=Depends(get_current_user)):
    """Delete a flow from the caller's account. Succeeds even if nothing matched. Its versions, runs and pending delayed steps are removed by ON DELETE CASCADE foreign keys."""
    _check_uuid(flow_id)
    supabase.table("automation_flows").delete().eq("id", flow_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}


# ── Runs ──

@router.get("/runs")
async def list_runs(
    user=Depends(get_current_user),
    flow_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = 0,
):
    """List the account's automation runs, newest first, optionally filtered by flow_id and status.

    Paginated with limit (default 50, max 200) and offset. meta.count is the number of rows
    in this page, not the total number of runs.
    """
    if flow_id:
        _check_uuid(flow_id)
    query = (
        supabase.table("automation_runs")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
    )
    if flow_id:
        query = query.eq("flow_id", flow_id)
    if status:
        query = query.eq("status", status)

    result = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    return {"data": result.data, "error": None, "meta": {"count": len(result.data)}}


# Declared before "/runs/{run_id}" so the literal path "stats" is matched here instead of
# being treated as a run id.
@router.get("/runs/stats")
async def runs_stats(user=Depends(get_current_user)):
    """Return the account's run counts: total, success, failed, running and queued. Counted in Python over every run's status, not with a SQL aggregate."""
    all_runs = (
        supabase.table("automation_runs")
        .select("status")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .execute()
    )
    data = all_runs.data or []
    return {
        "data": {
            "total": len(data),
            "success": sum(1 for r in data if r.get("status") == "success"),
            "failed": sum(1 for r in data if r.get("status") == "failed"),
            "running": sum(1 for r in data if r.get("status") == "running"),
            "queued": sum(1 for r in data if r.get("status") == "queued"),
        },
        "error": None,
    }


@router.get("/runs/{run_id}")
async def get_run(run_id: str, user=Depends(get_current_user)):
    """Return one run with its input_data and output_data. 404 if the run is not in the caller's account."""
    _check_uuid(run_id, what="Run")
    result = (
        supabase.table("automation_runs")
        .select("*")
        .eq("id", run_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"data": result.data, "error": None}
