/* eslint-disable react-refresh/only-export-components -- test helper, not a component module */
/**
 * Stand-in for `react-apexcharts` in jsdom tests (Apex needs real SVG measuring, which jsdom lacks). Use it with
 *
 *   vi.mock("react-apexcharts", () => import("@/test/apexchartsStub"));
 *
 * Each render is recorded in `apexCalls` (the props the chart was given, functions included) and drawn as a div whose
 * `data-*` attributes carry the type, size and series count, so a test can check what a page hands to the chart.
 */
import type { ComponentProps } from "react";

export type ApexCall = {
  type?: string;
  series?: unknown;
  options?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  height?: number | string;
  width?: number | string;
};

export const apexCalls: ApexCall[] = [];

export function lastApexCall(type?: string): ApexCall | undefined {
  return [...apexCalls].reverse().find((c) => !type || c.type === type);
}

export default function ApexChartStub(props: ComponentProps<"div"> & ApexCall) {
  const { type, series, options, height, width } = props;
  apexCalls.push({ type, series, options, height, width });
  return (
    <div
      data-testid="apex-chart"
      data-type={type}
      data-height={String(height)}
      data-width={String(width)}
      data-series={Array.isArray(series) ? series.length : 0}
    />
  );
}
