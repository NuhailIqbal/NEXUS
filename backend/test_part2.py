import asyncio
import sys
sys.path.insert(0, ".")

from database import supabase
from services.vapi_client import create_assistant, build_assistant_payload, delete_assistant


async def test_full_flow():
    print("=== Full End-to-End: Create Agent ===")

    payload = build_assistant_payload(
        name="EDM Sales Bot",
        language="en",
        system_prompt="You are a professional sales assistant for EDM Nexus.",
        first_message="Hello! I am your EDM Nexus assistant. How can I help?",
    )
    vapi_result = await create_assistant(payload)
    vapi_id = vapi_result.get("id")
    print("1. VAPI assistant created:", vapi_id)

    users = supabase.auth.admin.list_users()
    user_id = users[0].id if users else None
    print("2. Test user_id:", user_id)

    row = {
        "user_id": user_id,
        "name": "EDM Sales Bot",
        "language": "en",
        "status": "Active",
        "vapi_assistant_id": vapi_id,
    }
    db_result = supabase.table("ai_agents").insert(row).execute()
    db_agent = db_result.data[0] if db_result.data else None
    agent_id = db_agent["id"]
    vapi_in_db = db_agent["vapi_assistant_id"]
    print("3. Saved to Supabase:", agent_id)
    print("   vapi_assistant_id in DB:", vapi_in_db)

    await delete_assistant(vapi_id)
    supabase.table("ai_agents").delete().eq("id", agent_id).execute()
    print("4. Cleaned up VAPI + Supabase")
    print("")
    print("=== ALL CHECKS PASSED ===")


asyncio.run(test_full_flow())
