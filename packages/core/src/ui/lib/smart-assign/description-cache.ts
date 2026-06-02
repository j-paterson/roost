/**
 * Persist edited cluster descriptions.
 */
export async function saveClusterDescriptionToDisk(
  name: string,
  desc: string,
  notDesc: string,
  descCachePath: string | null,
  notDescCachePath: string | null,
  log: (msg: string) => void,
): Promise<void> {
  if (!descCachePath || !notDescCachePath) return;

  try {
    const fs = require("fs");
    const descObj: Record<string, string> = (() => {
      try { return JSON.parse(fs.readFileSync(descCachePath, "utf8")); } catch { return {}; }
    })();
    const notObj: Record<string, string> = (() => {
      try { return JSON.parse(fs.readFileSync(notDescCachePath, "utf8")); } catch { return {}; }
    })();
    descObj[name] = desc;
    if (notDesc) notObj[name] = notDesc;
    else delete notObj[name];
    fs.writeFileSync(descCachePath, JSON.stringify(descObj, null, 2));
    fs.writeFileSync(notDescCachePath, JSON.stringify(notObj, null, 2));
    log(`Saved description for "${name}"`);
  } catch (e: unknown) {
    log(`[warn] Failed to persist edited description for "${name}": ${e instanceof Error ? e.message : String(e)}`);
  }
}
