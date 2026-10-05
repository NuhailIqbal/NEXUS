"""Contacts API: CRUD over the `contacts` table plus bulk CSV import.

Mounted under /contacts and called by the dashboard Contacts page. Every query is
scoped to the account owner's id (a team sub-user acts on their owner's data, see
routers.team.resolve_owner_id). Responses use the {"data": ..., "error": ...}
envelope; contacts can optionally belong to a list (see routers/lists.py).
"""
import csv
import io
from fastapi import APIRouter, Depends, UploadFile, File, Query
from dependencies import get_current_user
from database import supabase
from models.schemas import ContactCreate, ContactUpdate
from routers.team import resolve_owner_id

router = APIRouter(prefix="/contacts", tags=["Contacts"])


@router.get("")
async def list_contacts(
    status: str = Query(None),
    list_id: str = Query(None),
    user=Depends(get_current_user),
):
    """List the account's contacts, newest first, optionally filtered by exact
    `status` and/or `list_id`. Returns every match (no pagination)."""
    owner_id = resolve_owner_id(user["user_id"])
    q = supabase.table("contacts").select("*").eq("user_id", owner_id)
    if status:
        q = q.eq("status", status)
    if list_id:
        q = q.eq("list_id", list_id)
    result = q.order("created_at", desc=True).execute()
    return {"data": result.data, "error": None}


@router.post("")
async def create_contact(body: ContactCreate, user=Depends(get_current_user)):
    """Create one contact owned by the caller's account and return the stored row."""
    row = body.model_dump()
    # Always stamp the owner's id server-side; ContactCreate has no user_id field.
    row["user_id"] = resolve_owner_id(user["user_id"])
    result = supabase.table("contacts").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{contact_id}")
async def get_contact(contact_id: str, user=Depends(get_current_user)):
    """Fetch one contact by id. Returns data null (not a 404) when it does not exist
    or belongs to another account."""
    result = (
        supabase.table("contacts")
        .select("*")
        .eq("id", contact_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{contact_id}")
async def update_contact(contact_id: str, body: ContactUpdate, user=Depends(get_current_user)):
    """Partially update a contact with the fields sent. Returns the updated row, or
    data null if nothing was sent or the contact is not this account's."""
    # exclude_none drops fields sent as null, so this endpoint cannot be used to clear
    # a value (for example to detach a contact from its list).
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("contacts")
        .update(updates)
        .eq("id", contact_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{contact_id}")
async def delete_contact(contact_id: str, user=Depends(get_current_user)):
    """Delete one of the account's contacts. Succeeds even if the id does not exist.
    Past conversations are kept; their contact_id is set to NULL by the foreign key.
    The TeamRoleGuard middleware (main.py) rejects DELETE for team sub-users."""
    owner_id = resolve_owner_id(user["user_id"])
    supabase.table("contacts").delete().eq("id", contact_id).eq("user_id", owner_id).execute()
    return {"data": None, "error": None}


@router.post("/import")
async def import_contacts_csv(
    file: UploadFile = File(...),
    list_id: str = Query(None),
    user=Depends(get_current_user),
):
    """Bulk-create contacts from an uploaded CSV with a header row. Recognized columns
    are name (required), phone, email and status; all rows go into the optional
    `list_id` query parameter's list. Rows without a name are skipped and reported.
    Returns {"imported": <count inserted>, "errors": [{"row", "error"}, ...]}."""
    owner_id = resolve_owner_id(user["user_id"])
    # utf-8-sig strips the byte-order mark that Excel adds when saving as CSV UTF-8.
    content = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))

    rows = []
    errors = []
    # Rows are numbered from 2 so reported row numbers match the spreadsheet
    # (row 1 is the header).
    for i, row in enumerate(reader, start=2):
        name = row.get("name", "").strip()
        if not name:
            errors.append({"row": i, "error": "Missing name"})
            continue
        rows.append({
            "user_id": owner_id,
            "name": name,
            "phone": row.get("phone", "").strip() or None,
            "email": row.get("email", "").strip() or None,
            # The "Active" default applies only when the CSV has no status column at
            # all; a blank status cell is stored as an empty string.
            "status": row.get("status", "Active").strip(),
            "list_id": list_id,
            "custom_data": {},
        })

    inserted = []
    if rows:
        # One multi-row insert for all valid rows (skips the call entirely when the
        # CSV had no valid rows).
        result = supabase.table("contacts").insert(rows).execute()
        inserted = result.data or []

    return {
        "data": {"imported": len(inserted), "errors": errors},
        "error": None,
    }
