/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { D2LApiClient } from "../api/index.js";
import type { AppConfig } from "../types/index.js";

/**
 * Everything a feature function needs. Built once by the client facade and
 * passed to every call, so features never load config, read tokens, or
 * construct API clients themselves — that keeps them trivially testable with
 * a fake `api` and a literal `config`.
 */
export interface FeatureContext {
  api: D2LApiClient;
  config: AppConfig;
  /** This package's version, for diagnostics output. */
  version: string;
}
