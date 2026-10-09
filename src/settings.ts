import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
// Historical strategy identifiers are components, not active trading identities.
export const STYLES = ["bizzy", "breezy", "boozy"] as const;
export type StyleId = (typeof STYLES)[number];
export const SettingsSchema = z
  .object({
    version: z.literal(2),
    cats: z.tuple([
      z
        .object({
          id: z.literal("tiger"),
          name: z.string().trim().min(1).max(24),
          rules: z.string().trim().max(1000),
        })
        .strict(),
      z
        .object({
          id: z.literal("mochi"),
          name: z.string().trim().min(1).max(24),
          rules: z.string().trim().max(1000),
        })
        .strict(),
    ]),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export function loadSettings(path: string): Settings | null {
  if (!existsSync(path)) return null;
  const parsed = SettingsSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!parsed.success)
    throw new Error(
      `${path} is incompatible with Catfolio. Preserve it; choose a NEW SETTINGS_PATH and DB_PATH. Catfolio requires version 2 and exactly tiger/mochi.`,
    );
  return parsed.data;
}
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
export function saveSettings(path: string, s: Settings): void {
  writePrivateJson(path, SettingsSchema.parse(s));
}
