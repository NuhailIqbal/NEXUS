// Quick verification: probe all expected tables using the same supabase-js
// client the frontend uses. Run with:  node scripts/probe-tables.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL || 'https://hwjnipdfhgvcwvilnzro.supabase.co';
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3am5pcGRmaGd2Y3d2aWxuenJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2NjIzODgsImV4cCI6MjA5NzIzODM4OH0.mlDttcv07mRh-MCc5fbm0BT4ZQHzXDbz66nz0H5QJqY';

const supabase = createClient(url, anon);
const tables = [
  'profiles','ai_agents','tools','lists','contacts','automation_flows',
  'conversations','phone_numbers','waitlist','onboarding_progress',
  'agent_knowledge','integrations','voice_widgets','team_members',
  'custom_fields','outbound_campaigns','inbound_queues','automation_runs',
];
let ok = 0, miss = 0;
for (const t of tables) {
  const { error } = await supabase.from(t).select('*', { count: 'exact', head: true });
  if (error) { console.log(`MISS ${t}  -> ${error.message}`); miss++; }
  else { console.log(`OK   ${t}`); ok++; }
}
console.log(`\nRESULT: ${ok} reachable, ${miss} missing`);
