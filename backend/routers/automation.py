from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/automation", tags=["Automation"])


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
        .single()
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
    result = (
        supabase.table("automation_flows")
        .update(updates)
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
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"data": result.data, "error": None}
