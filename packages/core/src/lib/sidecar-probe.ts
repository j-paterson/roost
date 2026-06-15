import { requestUrl } from "obsidian";
import { EMBED_URL } from "@/config";

/** Probe whether the fine-tuned embedding sidecar is reachable on EMBED_URL. */
export async function probeSidecarUp(): Promise<boolean> {
  try {
    const res = await requestUrl({ url: `${EMBED_URL}/api/tags`, method: "GET" });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
