/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { FeatureContext } from "./context.js";
import { getConfigStorePath } from "../utils/config-store.js";

export interface ClientInfo {
  version: string;
  node: string;
  platform: string;
  arch: string;
  configPath: string;
  sessionStatePath: string;
  schoolUrl: string;
  hasStoredCredential: boolean;
}

/**
 * Client and runtime diagnostics, for troubleshooting.
 *
 * Answers from the loaded config alone: no network call, so it can never
 * trigger a sign-in. hasStoredCredential reflects the credential this process
 * actually holds. Nothing secret — password, username, token, cookie — is
 * ever included.
 */
export async function getInfo(ctx: FeatureContext): Promise<ClientInfo> {
  return {
    version: ctx.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    configPath: getConfigStorePath(),
    sessionStatePath: ctx.config.sessionDir,
    schoolUrl: ctx.config.baseUrl,
    hasStoredCredential: ctx.config.password !== undefined,
  };
}
