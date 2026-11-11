/** The icon of each kind of referred-user activity: used by the live feed and by a single user's history. */
import { Activity, Bot, CheckCircle2, DollarSign, Phone, UserPlus } from "lucide-react";
import type { ActivityKind } from "@/lib/partners";

export const ACTIVITY_ICONS: Record<ActivityKind, typeof Activity> = {
  signup: UserPlus, verified: CheckCircle2, funds: DollarSign, agent: Bot, call: Phone,
};
