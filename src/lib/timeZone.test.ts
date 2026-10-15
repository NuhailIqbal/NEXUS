import { describe, expect, it } from "vitest";
import { formatInZone, formatTimeInZone, isValidZone } from "./timeZone";
import { describeNextOpen } from "@/components/hours/callingHours";

/** Every zone this browser's picker (Intl) can offer, plus the few the dropdown lists first. */
const ZONES: string[] = Array.from(new Set([
  ...(Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"),
  "UTC", "Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu", "America/New_York", "Europe/London",
]));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Moments chosen to land on different local dates and daylight-saving states around the world.
const INSTANTS = [
  Date.UTC(2026, 9, 14, 4, 0, 5),    // Oct 14 2026 04:00:05Z
  Date.UTC(2026, 2, 11, 23, 30, 0),  // Mar 11 2026 23:30Z (northern spring, southern autumn)
  Date.UTC(2026, 10, 4, 12, 15, 59), // Nov 4 2026 12:15:59Z
  Date.UTC(2027, 0, 13, 0, 5, 0),    // Jan 13 2027 00:05Z (southern summer)
];

/**
 * The expected wall clock in `zone` at `ms`, worked out a DIFFERENT way from what the code under test
 * does: read the zone's UTC offset ("GMT+05:45") and add it to the instant by plain arithmetic.
 */
function expectedLocal(ms: number, zone: string) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")!.value;           // "GMT", "GMT+05:45", "GMT-03:30"
  const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name)!;
  const offsetMin = m[1] ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const d = new Date(ms + offsetMin * 60000);
  const h = d.getUTCHours();
  return {
    month: MONTHS[d.getUTCMonth()], day: d.getUTCDate(), year: d.getUTCFullYear(),
    hour12: h % 12 || 12, minute: d.getUTCMinutes(), second: d.getUTCSeconds(), ampm: h < 12 ? "AM" : "PM",
  };
}
const clean = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

describe("formatInZone: every zone the user can pick", () => {
  it("is offered a long list of zones", () => {
    expect(ZONES.length).toBeGreaterThan(400);
  });

  it("shows the wall-clock date and time of THAT zone, with its name, for every zone", () => {
    for (const zone of ZONES) {
      for (const ms of INSTANTS) {
        const shown = clean(formatInZone(new Date(ms).toISOString(), zone));
        const m = /^(\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) (.+)$/.exec(shown);
        expect(m, `${zone} ${new Date(ms).toISOString()} -> "${shown}"`).not.toBeNull();
        const e = expectedLocal(ms, zone);
        expect([m![1], Number(m![2]), Number(m![3]), Number(m![4]), Number(m![5]), m![6]], `${zone} ${new Date(ms).toISOString()}`)
          .toEqual([e.month, e.day, e.year, e.hour12, e.minute, e.ampm]);
        expect(m![7].length, `${zone}: a zone name is always shown`).toBeGreaterThan(0);
      }
    }
  });

  it("the time-only form agrees for every zone, seconds included", () => {
    for (const zone of ZONES) {
      for (const ms of INSTANTS) {
        const shown = clean(formatTimeInZone(new Date(ms).toISOString(), zone));
        const m = /^(\d{1,2}):(\d{2}):(\d{2}) (AM|PM) (.+)$/.exec(shown);
        expect(m, `${zone} -> "${shown}"`).not.toBeNull();
        const e = expectedLocal(ms, zone);
        expect([Number(m![1]), Number(m![2]), Number(m![3]), m![4]], zone).toEqual([e.hour12, e.minute, e.second, e.ampm]);
      }
    }
  });

  it("the same moment reads differently in different zones, and names the right ones", () => {
    const iso = "2026-10-14T04:00:00Z";
    expect(clean(formatInZone(iso, "America/Los_Angeles"))).toBe("Oct 13, 2026, 9:00 PM PDT");
    expect(clean(formatInZone(iso, "Asia/Karachi"))).toBe("Oct 14, 2026, 9:00 AM GMT+5");
    expect(clean(formatInZone(iso, "Asia/Kathmandu"))).toBe("Oct 14, 2026, 9:45 AM GMT+5:45");
    expect(clean(formatInZone(iso, "Pacific/Kiritimati"))).toBe("Oct 14, 2026, 6:00 PM GMT+14");
    expect(clean(formatInZone(iso, "Pacific/Pago_Pago"))).toBe("Oct 13, 2026, 5:00 PM GMT-11");
    expect(clean(formatInZone(iso, "UTC"))).toBe("Oct 14, 2026, 4:00 AM UTC");
  });

  it("daylight saving follows the zone: the same wall clock on both sides of a change", () => {
    expect(clean(formatInZone("2026-03-08T06:59:00Z", "America/New_York"))).toBe("Mar 8, 2026, 1:59 AM EST");
    expect(clean(formatInZone("2026-03-08T07:00:00Z", "America/New_York"))).toBe("Mar 8, 2026, 3:00 AM EDT");
  });

  it("does not depend on the zone of the machine it runs on", () => {
    // The explicit zone wins over the viewer's; the viewer's zone only matters when there is none.
    const iso = "2026-10-14T04:00:00Z";
    const viewer = clean(formatInZone(iso));
    const chosen = clean(formatInZone(iso, "Pacific/Auckland"));
    expect(chosen).toBe("Oct 14, 2026, 5:00 PM GMT+13");
    expect(viewer).not.toBe("");
  });
});

describe("formatInZone: when no zone was chosen", () => {
  const iso = "2026-10-14T04:00:00Z";
  const viewersOwn = clean(new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso)));

  it("falls back to the viewer's own zone, still named", () => {
    for (const none of [null, undefined, "", "   "]) expect(clean(formatInZone(iso, none))).toBe(viewersOwn);
  });

  it("an unusable zone is treated as none rather than breaking the page", () => {
    expect(clean(formatInZone(iso, "Mars/Olympus"))).toBe(viewersOwn);
    expect(clean(formatTimeInZone(iso, "Mars/Olympus"))).toMatch(/\d:\d{2}:\d{2} (AM|PM) .+/);
  });

  it("handles missing and unreadable moments", () => {
    expect(formatInZone(null, "UTC")).toBe("—");
    expect(formatInZone(undefined, "UTC")).toBe("—");
    expect(formatInZone("", "UTC")).toBe("—");
    expect(formatInZone("not a date", "UTC")).toBe("not a date");
    expect(formatTimeInZone("", "UTC")).toBe("—");
    expect(formatTimeInZone("nope", "UTC")).toBe("nope");
  });

  it("accepts a Date or a number as well as an ISO string", () => {
    expect(clean(formatInZone(new Date(iso), "Asia/Karachi"))).toBe("Oct 14, 2026, 9:00 AM GMT+5");
    expect(clean(formatInZone(Date.parse(iso), "Asia/Karachi"))).toBe("Oct 14, 2026, 9:00 AM GMT+5");
  });
});

describe("isValidZone", () => {
  it("accepts every zone in the list and refuses everything else", () => {
    for (const zone of ZONES) expect(isValidZone(zone), zone).toBe(true);
    for (const bad of [null, undefined, "", "  ", "Mars/Olympus", "not a zone"]) expect(isValidZone(bad), String(bad)).toBe(false);
  });
});

describe("the \"opens next\" text on campaign and receptionist cards, in every zone", () => {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  it("is the next opening in the zone the user chose, whatever the viewer's zone is", () => {
    for (const zone of ZONES) {
      for (const ms of INSTANTS) {
        const shown = clean(describeNextOpen({ enabled: true, open: false, next_open_at: new Date(ms).toISOString(), summary: null }, zone) ?? "");
        const m = /^(\w{3}), (\w{3}) (\d{1,2}), (\d{1,2}):(\d{2}) (AM|PM) (.+)$/.exec(shown);
        expect(m, `${zone} -> "${shown}"`).not.toBeNull();
        const e = expectedLocal(ms, zone);
        const weekday = WEEKDAYS[new Date(Date.UTC(e.year, MONTHS.indexOf(e.month), e.day)).getUTCDay()];
        expect([m![1], m![2], Number(m![3]), Number(m![4]), Number(m![5]), m![6]], zone)
          .toEqual([weekday, e.month, e.day, e.hour12, e.minute, e.ampm]);
      }
    }
  });

  it("without a chosen zone it still shows a named zone (the viewer's), and nothing when there is no opening", () => {
    const st = { enabled: true, open: false, next_open_at: "2026-10-14T04:00:00Z", summary: null };
    for (const none of [null, undefined, ""]) expect(clean(describeNextOpen(st, none) ?? "")).toMatch(/^\w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} (AM|PM) .+/);
    expect(describeNextOpen({ ...st, next_open_at: null }, "Asia/Karachi")).toBeNull();
    expect(describeNextOpen(undefined, "Asia/Karachi")).toBeNull();
  });
});
