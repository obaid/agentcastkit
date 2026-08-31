import { access } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export async function availableArtifactPath(directory: string, requestedFilename: string, uniqueID: string, requiredExtension: string): Promise<string> {
  const cleaned = basename(requestedFilename).replace(/[^a-zA-Z0-9._-]/g, "-");
  const extension = requiredExtension.startsWith(".") ? requiredExtension : `.${requiredExtension}`;
  const normalized = cleaned.toLowerCase().endsWith(extension.toLowerCase()) ? cleaned : `${cleaned}${extension}`;
  const existingExtension = extname(normalized);
  const stem = normalized.slice(0, -existingExtension.length);
  let candidate = join(directory, normalized);
  let suffix = uniqueID.slice(0, 8);
  let attempt = 1;

  while (await pathExists(candidate)) {
    candidate = join(directory, `${stem}-${suffix}${attempt === 1 ? "" : `-${attempt}`}${existingExtension}`);
    attempt += 1;
  }
  return candidate;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
