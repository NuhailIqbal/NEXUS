from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from models.schemas import IntegrationCreate, IntegrationUpdate
from services.encryption import encrypt_config, decrypt_config, mask_config
from services.integration_test import run_test

router = APIRouter(prefix="/integrations", tags=["Integrations"])


@router.get("")
async def list_integrations(user=Depends(get_current_user)):
    result = (
        supabase.table("integrations")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    for row in result.data:
        if row.get("config_encrypted"):
            try:
                row["config_masked"] = mask_config(decrypt_config(row["config_encrypted"]))
            except Exception:
                row["config_masked"] = {}
            del row["config_encrypted"]
    return {"data": result.data, "error": None}


@router.post("")
async def create_integration(body: IntegrationCreate, user=Depends(get_current_user)):
    row = {
        "user_id": user["user_id"],
        "name": body.name,
        "description": body.description,
        "status": body.status,
        "category": body.category,
    }
    if body.config:
        row["config_encrypted"] = encrypt_config(body.config)
    result = supabase.table("integrations").insert(row).execute()
    created = result.data[0] if result.data else None
    if created and created.get("config_encrypted"):
        created["config_masked"] = mask_config(body.config)
        del created["config_encrypted"]
    return {"data": created, "error": None}


@router.get("/{integration_id}")
async def get_integration(integration_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("integrations")
        .select("*")
        .eq("id", integration_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    row = result.data
    if row and row.get("config_encrypted"):
        try:
            row["config_masked"] = mask_config(decrypt_config(row["config_encrypted"]))
        except Exception:
            row["config_masked"] = {}
        del row["config_encrypted"]
    return {"data": row, "error": None}


@router.patch("/{integration_id}")
async def update_integration(integration_id: str, body: IntegrationUpdate, user=Depends(get_current_user)):
    updates = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.status is not None:
        updates["status"] = body.status
    if body.category is not None:
        updates["category"] = body.category
    if body.config is not None:
        updates["config_encrypted"] = encrypt_config(body.config)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("integrations")
        .update(updates)
        .eq("id", integration_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    updated = result.data[0] if result.data else None
    if updated and updated.get("config_encrypted"):
        try:
            updated["config_masked"] = mask_config(decrypt_config(updated["config_encrypted"]))
        except Exception:
            updated["config_masked"] = {}
        del updated["config_encrypted"]
    return {"data": updated, "error": None}


@router.delete("/{integration_id}")
async def delete_integration(integration_id: str, user=Depends(get_current_user)):
    supabase.table("integrations").delete().eq("id", integration_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}


@router.post("/{integration_id}/test")
async def test_integration(integration_id: str, user=Depends(get_current_user)):
    row = (
        supabase.table("integrations")
        .select("name, config_encrypted, status")
        .eq("id", integration_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=404, detail="Integration not found")

    config = {}
    if row.data.get("config_encrypted"):
        try:
            config = decrypt_config(row.data["config_encrypted"])
        except Exception:
            return {
                "data": {
                    "ok": False,
                    "message": "Could not decrypt stored credentials — re-save the integration.",
                    "latency_ms": None,
                    "provider": None,
                },
                "error": None,
            }

    result = await run_test(
        row.data.get("name", ""),
        config,
        category=row.data.get("category", ""),
    )
    return {"data": result, "error": None}
