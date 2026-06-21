from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from models.schemas import ToolCreate, ToolUpdate
from services import vapi_client
from config import settings

router = APIRouter(prefix="/tools", tags=["Tools"])


def _build_vapi_tool_payload(name: str, description: str, url: str,
                              method: str = "POST", headers: dict = None,
                              body_schema: dict = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name.lower().replace(" ", "_"),
            "description": description or name,
            "parameters": body_schema or {"type": "object", "properties": {}},
        },
        "server": {
            "url": url,
            "method": method,
            "headers": headers or {},
        },
    }


@router.get("")
async def list_tools(user=Depends(get_current_user)):
    result = (
        supabase.table("tools")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("")
async def create_tool(body: ToolCreate, user=Depends(get_current_user)):
    row = {
        "user_id": user["user_id"],
        "name": body.name,
        "description": body.description,
        "status": "Active",
    }

    if settings.vapi_api_key:
        try:
            vapi_payload = _build_vapi_tool_payload(
                name=body.name,
                description=body.description,
                url=body.url,
                method=body.method,
                headers=body.headers,
                body_schema=body.body_schema,
            )
            vapi_tool = await vapi_client.create_tool(vapi_payload)
            row["vapi_tool_id"] = vapi_tool.get("id")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

    result = supabase.table("tools").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{tool_id}")
async def get_tool(tool_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("tools")
        .select("*")
        .eq("id", tool_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{tool_id}")
async def update_tool(tool_id: str, body: ToolUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    tool_res = (
        supabase.table("tools")
        .select("vapi_tool_id")
        .eq("id", tool_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    tool = tool_res.data
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    if settings.vapi_api_key and tool.get("vapi_tool_id"):
        try:
            vapi_payload = {}
            if "name" in updates or "description" in updates or "url" in updates:
                vapi_payload = _build_vapi_tool_payload(
                    name=updates.get("name", ""),
                    description=updates.get("description", ""),
                    url=updates.get("url", ""),
                    method=updates.get("method", "POST"),
                    headers=updates.get("headers"),
                    body_schema=updates.get("body_schema"),
                )
            if vapi_payload:
                await vapi_client.update_tool(tool["vapi_tool_id"], vapi_payload)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

    db_updates = {k: v for k, v in updates.items() if k in ("name", "description", "status")}
    result = (
        supabase.table("tools")
        .update(db_updates)
        .eq("id", tool_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{tool_id}")
async def delete_tool(tool_id: str, user=Depends(get_current_user)):
    tool_res = (
        supabase.table("tools")
        .select("vapi_tool_id")
        .eq("id", tool_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    tool = tool_res.data
    if tool and settings.vapi_api_key and tool.get("vapi_tool_id"):
        try:
            await vapi_client.delete_tool(tool["vapi_tool_id"])
        except Exception:
            pass

    supabase.table("tools").delete().eq("id", tool_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}
