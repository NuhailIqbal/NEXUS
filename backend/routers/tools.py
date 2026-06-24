import time
import httpx
from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from models.schemas import ToolCreate, ToolUpdate
from services import vapi_client
from config import settings

router = APIRouter(prefix="/tools", tags=["Tools"])


def _params_to_json_schema(parameters: list[dict] | None) -> dict:
    if not parameters:
        return {"type": "object", "properties": {}}
    props = {}
    required = []
    for p in parameters:
        prop: dict = {"type": p.get("type", "string")}
        if p.get("description"):
            prop["description"] = p["description"]
        if p.get("enumValues"):
            prop["enum"] = p["enumValues"]
        if p.get("defaultValue"):
            prop["default"] = p["defaultValue"]
        props[p["name"]] = prop
        if p.get("required"):
            required.append(p["name"])
    schema: dict = {"type": "object", "properties": props}
    if required:
        schema["required"] = required
    return schema


def _build_vapi_tool_payload(name: str, description: str, url: str,
                              method: str = "POST", headers: dict = None,
                              parameters: list[dict] | None = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name.lower().replace(" ", "_"),
            "description": description or name,
            "parameters": _params_to_json_schema(parameters),
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
        "url": body.url,
        "method": body.method or "POST",
        "headers": body.headers or {},
        "parameters": body.parameters or [],
    }

    if settings.vapi_api_key and body.url:
        try:
            vapi_payload = _build_vapi_tool_payload(
                name=body.name,
                description=body.description,
                url=body.url,
                method=body.method,
                headers=body.headers,
                parameters=body.parameters,
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
        .select("vapi_tool_id, url, method, headers, parameters")
        .eq("id", tool_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    tool = tool_res.data
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    db_updates = {k: v for k, v in updates.items() if k in (
        "name", "description", "status", "url", "method", "headers", "parameters",
    )}

    if settings.vapi_api_key and tool.get("vapi_tool_id"):
        needs_vapi = any(k in updates for k in ("name", "description", "url", "method", "headers", "parameters"))
        if needs_vapi:
            try:
                vapi_payload = _build_vapi_tool_payload(
                    name=updates.get("name", tool.get("name", "")),
                    description=updates.get("description", tool.get("description", "")),
                    url=updates.get("url", tool.get("url", "")),
                    method=updates.get("method", tool.get("method", "POST")),
                    headers=updates.get("headers", tool.get("headers")),
                    parameters=updates.get("parameters", tool.get("parameters")),
                )
                await vapi_client.update_tool(tool["vapi_tool_id"], vapi_payload)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

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


@router.post("/{tool_id}/test")
async def test_tool(tool_id: str, user=Depends(get_current_user)):
    tool_res = (
        supabase.table("tools")
        .select("name, url, method, headers, parameters")
        .eq("id", tool_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    tool = tool_res.data
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    url = tool.get("url")
    if not url:
        return {"data": {"ok": False, "message": "No API URL configured for this tool.", "latency_ms": None}, "error": None}

    method = (tool.get("method") or "POST").upper()
    hdrs = tool.get("headers") or {}
    hdrs.setdefault("Content-Type", "application/json")

    sample_body = {}
    for p in (tool.get("parameters") or []):
        name = p.get("name", "")
        ptype = p.get("type", "string")
        if ptype == "number":
            sample_body[name] = 0
        elif ptype == "boolean":
            sample_body[name] = True
        elif ptype == "array":
            sample_body[name] = []
        elif ptype == "object":
            sample_body[name] = {}
        else:
            sample_body[name] = p.get("defaultValue") or "test"

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if method in ("GET", "DELETE"):
                resp = await client.request(method, url, headers=hdrs, params=sample_body)
            else:
                resp = await client.request(method, url, headers=hdrs, json=sample_body)
        latency_ms = int((time.perf_counter() - started) * 1000)

        if 200 <= resp.status_code < 300:
            body_preview = resp.text[:300] if resp.text else ""
            return {"data": {"ok": True, "message": f"HTTP {resp.status_code} OK", "latency_ms": latency_ms, "response_preview": body_preview}, "error": None}
        else:
            body_preview = resp.text[:300] if resp.text else ""
            return {"data": {"ok": False, "message": f"HTTP {resp.status_code}: {body_preview}", "latency_ms": latency_ms}, "error": None}
    except httpx.TimeoutException:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return {"data": {"ok": False, "message": "Request timed out after 10s", "latency_ms": latency_ms}, "error": None}
    except Exception as e:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return {"data": {"ok": False, "message": f"Connection error: {e}", "latency_ms": latency_ms}, "error": None}
