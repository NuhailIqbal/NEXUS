/** The validated chart colours for the active light / dark mode (the dashboard defaults to dark). */
import { useTheme } from "next-themes";
import { CHART_COLORS } from "@/lib/dashboardOverview";

export function useChartColors() {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "light" ? CHART_COLORS.light : CHART_COLORS.dark;
}
