from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/automation", tags=["Automation"])

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


class FlowCreate(BaseModel):
    name: str
    description: Optional[str] = None
    definition: Optional[dict] = None
    status: str = "Active"


class FlowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    definition: Optional[dict] = None
    status: Optional[str] = None


# ── Flows ──

@router.get("/flows")
async def list_flows(user=Depends(get_current_user)):
    result = (
        supabase.table("automation_flows")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("/flows")
async def create_flow(body: FlowCreate, user=Depends(get_current_user)):
    row = body.model_dump()
    row["user_id"] = user["user_id"]
    result = supabase.table("automation_flows").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/flows/{flow_id}")
async def get_flow(flow_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("automation_flows")
        .select("*")
        .eq("id", flow_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Flow not found")
    return {"data": result.data, "error": None}


@router.patch("/flows/{flow_id}")
async def update_flow(flow_id: str, body: FlowUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    if "definition" in updates:
        current = (
            supabase.table("automation_flows")
            .select("definition")
            .eq("id", flow_id)
            .eq("user_id", user["user_id"])
            .maybe_single()
            .execute()
        )
        if current.data and current.data.get("definition"):
            _snapshot_flow_version(user["user_id"], flow_id, current.data["definition"])

    result = (
        supabase.table("automation_flows")
        .update(updates)
        .eq("id", flow_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/flows/{flow_id}/versions")
async def list_flow_versions(flow_id: str, user=Depends(get_current_user)):
    owner = (
        supabase.table("automation_flows")
        .select("id")
        .eq("id", flow_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    if not owner.data:
        raise HTTPException(status_code=404, detail="Flow not found")

    result = (
        supabase.table("automation_flow_versions")
        .select("id, version_number, created_at")
        .eq("flow_id", flow_id)
        .eq("user_id", user["user_id"])
        .order("version_number", desc=True)
        .execute()
    )
    return {"data": result.data or [], "error": None}


@router.get("/flows/{flow_id}/versions/{version_id}")
async def get_flow_version(flow_id: str, version_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("automation_flow_versions")
        .select("*")
        .eq("id", version_id)
        .eq("flow_id", flow_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"data": result.data, "error": None}


@router.post("/flows/{flow_id}/versions/{version_id}/restore")
async def restore_flow_version(flow_id: str, version_id: str, user=Depends(get_current_user)):
    version = (
        supabase.table("automation_flow_versions")
        .select("definition")
        .eq("id", version_id)
        .eq("flow_id", flow_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not version.data:
        raise HTTPException(status_code=404, detail="Version not found")

    current = (
        supabase.table("automation_flows")
        .select("definition")
        .eq("id", flow_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if current.data and current.data.get("definition"):
        _snapshot_flow_version(user["user_id"], flow_id, current.data["definition"])

    result = (
        supabase.table("automation_flows")
        .update({"definition": version.data["definition"]})
        .eq("id", flow_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/flows/{flow_id}")
async def delete_flow(flow_id: str, user=Depends(get_current_user)):
    supabase.table("automation_flows").delete().eq("id", flow_id).eq("user_id", user["user_id"]).execute()
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
    query = (
        supabase.table("automation_runs")
        .select("*")
        .eq("user_id", user["user_id"])
    )
    if flow_id:
        query = query.eq("flow_id", flow_id)
    if status:
        query = query.eq("status", status)

    result = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    return {"data": result.data, "error": None, "meta": {"count": len(result.data)}}


@router.get("/runs/stats")
async def runs_stats(user=Depends(get_current_user)):
    all_runs = (
        supabase.table("automation_runs")
        .select("status")
        .eq("user_id", user["user_id"])
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
    result = (
        supabase.table("automation_runs")
        .select("*")
        .eq("id", run_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"data": result.data, "error": None}
