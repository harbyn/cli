import type { ChangeEvent } from "./change-event.ts";

type Claimable = Pick<ChangeEvent, "id" | "vendor" | "affects" | "effectiveAt" | "effectiveMonth">;

const valuesOf = (event: Pick<ChangeEvent, "affects">): string[] =>
  event.affects.flatMap((t) => ("values" in t ? t.values : []));

export const claimOf = (event: Omit<Claimable, "id">): string | undefined => {
  const values = [...valuesOf(event)].sort();
  const when = event.effectiveAt ?? event.effectiveMonth ?? "";
  return values.length === 0 && when === ""
    ? undefined
    : `${event.vendor}|${values.join(",")}|${when}`;
};

export const dismissalKeys = (event: Claimable): string[] => {
  const claim = claimOf(event);
  return [`id:${event.id}`, ...(claim ? [claim] : [])];
};

export const isDismissed = (event: Claimable, dismissed: ReadonlySet<string>): boolean =>
  dismissalKeys(event).some((k) => dismissed.has(k));
