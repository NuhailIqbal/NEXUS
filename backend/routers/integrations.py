"""
Third-party integration records for an account: CRUD under /integrations, plus a connection test.

Rows live in the `integrations` table. Credentials are Fernet-encrypted into `config_encrypted`
and never returned; responses carry a redacted `config_masked` instead. Team members act on the
owner's rows (via resolve_owner_id), and each query is filtered by that owner id so an account only
sees and changes its own integrations. These routes only require a signed-in user (no owner-only
check). The test endpoint delegates to services/integration_test.run_test, and
`/dnc-status` reports on the WhitelistData integration used for do-not-call screening.
"""

from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from models.schemas import IntegrationCreate, IntegrationUpdate
from services.encryption import encrypt_config, decrypt_config, mask_config
from services.integration_test import run_test
from services import whitelist_service
from routers.team import resolve_owner_id

router = APIRouter(prefix="/integrations", tags=["Integrations"])


@router.get("")
async def list_integrations(user=Depends(get_current_user)):
    """List the account's integrations, newest first, with credentials masked (`config_masked`) and the ciphertext removed."""
    result = (
        supabase.table("integrations")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .execute()
    )
    for row in result.data:
        if row.get("config_encrypted"):
            try:
                row["config_masked"] = mask_config(decrypt_config(row["config_encrypted"]))
            except Exception:
                # Undecryptable (corrupted or encrypted under another key): show an empty config
                # rather than failing the whole list.
                row["config_masked"] = {}
            # The ciphertext never leaves the server.
            del row["config_encrypted"]
    return {"data": result.data, "error": None}


@router.post("")
async def create_integration(body: IntegrationCreate, user=Depends(get_current_user)):
    """Create an integration owned by the caller's account; the optional `config` (credentials) is stored encrypted.

    Returns the new row with a masked copy of the submitted config.
    """
    row = {
        "user_id": resolve_owner_id(user["user_id"]),
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


# Registered before the /{integration_id} routes so this literal path isn't captured as an id.
@router.get("/dnc-status")
async def dnc_status(user=Depends(get_current_user)):
    """Whether this user's WhitelistData integration is configured and Active, plus its row
    id so the campaign wizard's toggle can flip it on/off via PATCH /integrations/{id} below.
    Visibility only here — dial-time enforcement independently re-checks via
    whitelist_service.check_number on every call, so this endpoint can never itself be the
    thing that lets an unsuppressed number through."""
    integration = await whitelist_service.find_whitelist_integration(resolve_owner_id(user["user_id"]))
    return {
        "data": {
            "enabled": bool(integration and integration["status"] == "Active"),
            "integration_id": integration["id"] if integration else None,
        },
        "error": None,
    }


@router.get("/{integration_id}")
async def get_integration(integration_id: str, user=Depends(get_current_user)):
    """Fetch one integration by id with credentials masked.

    `data` is null (not a 404) if the id doesn't exist or belongs to another account.
    """
    result = (
        supabase.table("integrations")
        .select("*")
        .eq("id", integration_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
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
    """Partially update an integration; only the fields sent are changed.

    A supplied `config` replaces the stored credentials as a whole (it is re-encrypted, not merged).
    Changing `status` is also how the campaign wizard's DNC toggle turns WhitelistData on or off.
    With nothing to update it returns `error: "No fields to update"`; `data` is null if the row isn't found or isn't the caller's account.
    """
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
        .eq("user_id", resolve_owner_id(user["user_id"]))
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
    """Permanently delete an integration of the caller's account. Succeeds even if no row matched."""
    supabase.table("integrations").delete().eq("id", integration_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}


@router.post("/{integration_id}/test")
async def test_integration(integration_id: str, user=Depends(get_current_user)):
    """Check that a saved integration's credentials work by making a live call to the provider.

    Returns `{ok, message, latency_ms, provider}`. The provider is inferred from the integration's
    name/category (see services/integration_test). This makes a real outbound request (a Slack or
    Zapier webhook receives a test payload) and stores nothing. Responds 404 if the integration isn't found.
    """
    row = (
        supabase.table("integrations")
        .select("name, config_encrypted, status, category")
        .eq("id", integration_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
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
            # Reported as a failed test (HTTP 200) rather than an error, so the UI can show the message.
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
