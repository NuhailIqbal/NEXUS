# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Frontend
```bash
npm run dev          # Start Vite dev server at http://localhost:8080
npm run build        # Production build
npm run build:dev    # Development build
npm run lint         # ESLint
npm run test         # Run all tests once (Vitest + jsdom)
npm run test:watch   # Run tests in watch mode
npx vitest run src/path/to/file.test.ts  # Run a single test file
npm run preview      # Preview production build
```

### Backend (FastAPI)
```bash
cd backend
uvicorn main:app --reload --port 8000   # Start API server
python migrate.py                        # Run DB migrations
```

The frontend dev server proxies `/api/*` → `http://localhost:8000`.

## Architecture

**Stack:** React 18 + TypeScript + Vite, Tailwind CSS + shadcn/ui (Radix primitives), React Router v6, TanStack Query v5, Supabase (auth + database), Vapi AI (voice calls), Recharts, React Flow — plus a Python/FastAPI backend with PostgreSQL (psycopg3).

### Frontend structure

**Two distinct app areas:**
1. **Marketing site** — public pages (`/`, `/features`, `/pricing`, etc.) in `src/pages/`
2. **Dashboard** — authenticated SPA at `/dashboard/*` using a nested `DashboardLayout` outlet. Pages in `src/pages/dashboard/`.

The admin portal is at `/nexus-admin` — password-gated, no Supabase auth.

**Auth:** `AuthContext` (`src/contexts/AuthContext.tsx`) wraps the app and exposes `useAuth()`. It listens to `supabase.auth.onAuthStateChange`. Check `loading` before redirecting in dashboard pages.

**Supabase integration:** Client and fully-typed `Database` type in `src/integrations/supabase/`. Use the generated `Tables<'table_name'>` helpers — don't write inline row types. Key tables: `ai_agents`, `contacts`, `lists`, `phone_numbers`, `profiles`, `tools`, `conversations`, `automation_flows`.

**Local-first demo data:** `useLocalCollection` (`src/hooks/use-local-collection.ts`) persists items to `localStorage`. Several dashboard pages use this instead of Supabase for demo flows — check which pattern a page uses before adding backend queries.

**UI components:** shadcn/ui primitives in `src/components/ui/` — don't modify these. Feature components are in domain subdirectories: `components/dashboard/`, `components/telephony/`, `components/database/`, etc.

**Path alias:** `@/` → `src/`

### Backend structure (`backend/`)

FastAPI app with routers mirroring dashboard features: `agents`, `contacts`, `lists`, `tools`, `conversations`, `telephony`, `automation`, `voice_widgets`, `integrations`, `analytics`, `team`, `billing`, `stripe_webhook`, `admin`, `webhooks`, `agent_tool_callbacks`.

Database access via psycopg3 pool (`db_pg.py`). Auth via `python-jose` JWT. Stripe integration for billing/subscriptions with per-minute call cost tracking.

**Supabase Edge Functions** in `supabase/functions/` (Deno): `agent-chat` and `process-email-queue`.
