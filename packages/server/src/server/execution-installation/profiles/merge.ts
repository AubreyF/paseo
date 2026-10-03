import { isDeepStrictEqual } from "node:util";

export interface ProfileConflictValue {
  field: string;
  sharedValue: string;
  environmentValue: string;
}

export class ProfileSharingConflict extends Error {
  constructor(
    readonly fields: string[],
    readonly values: ProfileConflictValue[] = [],
  ) {
    super(
      `Profiles changed in multiple environments: ${fields.join(", ")}. Review the conflicting edits before synchronizing.`,
    );
    this.name = "ProfileSharingConflict";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyedItems(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const result: Record<string, unknown> = {};
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || Object.hasOwn(result, item.id))
      return null;
    result[item.id] = item;
  }
  return result;
}

/** Merge independent edits. A conflicting field is never resolved by arrival order. */
export function mergeProfileEdits(
  base: unknown,
  current: unknown,
  incoming: unknown,
  resolution?: "shared" | "environment",
): unknown {
  const conflicts: string[] = [];
  const values: ProfileConflictValue[] = [];
  function merge(previous: unknown, shared: unknown, local: unknown, field: string): unknown {
    if (isDeepStrictEqual(local, previous)) return shared;
    if (isDeepStrictEqual(shared, previous) || isDeepStrictEqual(shared, local)) return local;
    if (isRecord(previous) && isRecord(shared) && isRecord(local)) {
      const keys = new Set([
        ...Object.keys(previous),
        ...Object.keys(shared),
        ...Object.keys(local),
      ]);
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const value = merge(previous[key], shared[key], local[key], `${field}.${key}`);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    const priorItems = keyedItems(previous);
    const sharedItems = keyedItems(shared);
    const localItems = keyedItems(local);
    if (priorItems && sharedItems && localItems) {
      const result = merge(priorItems, sharedItems, localItems, field);
      if (!isRecord(result)) throw new Error("Invalid workflow merge");
      return Object.values(result);
    }
    if (resolution === "environment") return local;
    if (resolution === "shared") return shared;
    conflicts.push(field);
    values.push({
      field,
      sharedValue: JSON.stringify(shared) ?? "Deleted",
      environmentValue: JSON.stringify(local) ?? "Deleted",
    });
    return shared;
  }
  const result = merge(base, current, incoming, "profiles");
  if (conflicts.length) throw new ProfileSharingConflict(conflicts, values);
  return result;
}
