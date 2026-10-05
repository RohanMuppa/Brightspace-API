/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * Brightspace sometimes puts the session itself in a link's query string
 * (`d2lSessionVal`, `d2lSecureSessionVal`). Anyone holding those values holds
 * the session, so they never belong in a returned URL, message, or log line.
 */
const SESSION_PARAM = /^d2l(?:secure)?sessionval$/i;

function isSessionParam(rawName: string): boolean {
  let name = rawName.replace(/\+/g, " ");
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape still gets compared as written.
  }
  return SESSION_PARAM.test(name.trim());
}

/**
 * `url` without any D2L session query parameter, matched case-insensitively.
 * Every other parameter (`ou`, `type`, `rcode`, ...) keeps its place and
 * spelling, and a relative URL stays relative.
 */
export function stripSessionParams(url: string): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return url;
  const base = beforeHash.slice(0, queryAt);
  const kept = beforeHash
    .slice(queryAt + 1)
    .split("&")
    .filter(pair => pair !== "" && !isSessionParam(pair.split("=")[0]));
  return `${base}${kept.length ? `?${kept.join("&")}` : ""}${hash}`;
}

