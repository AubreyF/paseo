import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const reservationSchema = z.object({
  workspaceId: z.string(),
  service: z.string(),
  origin: z.string().url(),
});

/** Read the broker's stable reservation; service lifecycle supplies running state. */
export function readWorkspacePreviewOrigin(
  workspaceId: string,
  service: string,
  directory = join(homedir(), ".local/share/paseo-preview/https/origins"),
): string | null {
  if (![workspaceId, service].every((value) => /^[a-zA-Z0-9_-]+$/.test(value))) return null;
  let text: string;
  try {
    text = readFileSync(join(directory, `${workspaceId}.${service}.json`), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = reservationSchema.safeParse(json);
  if (!result.success) return null;
  const reservation = result.data;
  if (reservation.workspaceId !== workspaceId || reservation.service !== service) return null;
  const url = new URL(reservation.origin);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".ts.net") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return null;
  return url.origin;
}
