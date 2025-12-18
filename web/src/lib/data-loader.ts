// Centralized data loading from R2
import { getJsonFromR2, getTextFromR2 } from './r2-data';

export interface ToolMeta {
  name: string;
  latest_version: string;
  latest_stable_version?: string;
  version_count: number;
  last_updated: string | null;
  description?: string;
  backends?: string[];
  github?: string;
  homepage?: string;
  repo_url?: string;
  license?: string;
  authors?: string[];
  security?: Array<{ type: string; algorithm?: string }>;
  package_urls?: Record<string, string>;
  aqua_link?: string;
}

export interface ToolsData {
  tool_count: number;
  tools: ToolMeta[];
}

export interface VersionUpdatesData {
  daily: Array<{ date: string; count: number }>;
  total_updates: number;
  unique_tools: number;
  avg_per_day: number;
  days: number;
}

/**
 * Load tools.json manifest from R2
 */
export async function loadToolsJson(bucket: R2Bucket): Promise<ToolsData | null> {
  return getJsonFromR2<ToolsData>(bucket, 'tools.json');
}

/**
 * Load tools_updated.json from R2 (version update statistics)
 */
export async function loadToolsUpdatedJson(bucket: R2Bucket): Promise<VersionUpdatesData | null> {
  return getJsonFromR2<VersionUpdatesData>(bucket, 'tools_updated.json');
}

/**
 * Load a tool's TOML version file from R2
 */
export async function loadToolToml(bucket: R2Bucket, tool: string): Promise<string | null> {
  return getTextFromR2(bucket, `${tool}.toml`);
}
