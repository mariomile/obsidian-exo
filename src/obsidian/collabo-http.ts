/**
 * The one place `core/collab-bridge`'s injected HttpFn meets Obsidian.
 *
 * `requestUrl` rather than fetch: desktop CSP and proxy safe, same choice
 * already made for the CLI version check in main.ts. `throw: false` keeps the
 * status in our hands, because the bridge turns non-2xx into CollaboError
 * itself and must not have that decision pre-empted by a thrown request.
 */
import { requestUrl } from "obsidian";
import type { HttpFn } from "../core/collab-bridge";

export const obsidianHttp: HttpFn = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  let json: unknown = null;
  try {
    json = res.json;
  } catch {
    json = null; // an error page that is not JSON: status alone carries the meaning
  }
  return { status: res.status, json };
};
