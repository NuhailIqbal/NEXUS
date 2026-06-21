import csv
import io
from fastapi import APIRouter, Depends, UploadFile, File, Query
from dependencies import get_current_user
from database import supabase
from models.schemas import ContactCreate, ContactUpdate

router = APIRouter(prefix="/contacts", tags=["Contacts"])


@router.get("")
async def list_contacts(
    status: str = Query(None),
    list_id: str = Query(None),
    user=Depends(get_current_user),
):
    q = supabase.table("contacts").select("*").eq("user_id", user["user_id"])
    if status:
        q = q.eq("status", status)
    if list_id:
        q = q.eq("list_id", list_id)
    result = q.order("created_at", desc=True).execute()
    return {"data": result.data, "error": None}


@router.post("")
async def create_contact(body: ContactCreate, user=Depends(get_current_user)):
    row = body.model_dump()
    row["user_id"] = user["user_id"]
    result = supabase.table("contacts").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{contact_id}")
async def get_contact(contact_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("contacts")
        .select("*")
        .eq("id", contact_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{contact_id}")
async def update_contact(contact_id: str, body: ContactUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("contacts")
        .update(updates)
        .eq("id", contact_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{contact_id}")
async def delete_contact(contact_id: str, user=Depends(get_current_user)):
    supabase.table("contacts").delete().eq("id", contact_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}


@router.post("/import")
async def import_contacts_csv(
    file: UploadFile = File(...),
    list_id: str = Query(None),
    user=Depends(get_current_user),
):
    content = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))

    rows = []
    errors = []
    for i, row in enumerate(reader, start=2):
        name = row.get("name", "").strip()
        if not name:
            errors.append({"row": i, "error": "Missing name"})
            continue
        rows.append({
            "user_id": user["user_id"],
            "name": name,
            "phone": row.get("phone", "").strip() or None,
            "email": row.get("email", "").strip() or None,
            "status": row.get("status", "Active").strip(),
            "list_id": list_id,
            "custom_data": {},
        })

    inserted = []
    if rows:
        result = supabase.table("contacts").insert(rows).execute()
        inserted = result.data or []

    return {
        "data": {"imported": len(inserted), "errors": errors},
        "error": None,
    }
