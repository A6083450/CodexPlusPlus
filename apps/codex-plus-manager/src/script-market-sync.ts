export type UserScriptInventory = {
  enabled?: boolean;
  scripts?: Array<{
    key: string;
    name: string;
    source: string;
    enabled: boolean;
    status: string;
    error: string;
    market_id?: string;
    version?: string;
    installed?: boolean;
    source_url?: string;
    homepage?: string;
  }>;
};

export type ScriptMarketItem = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  homepage: string;
  script_url: string;
  sha256: string;
  installed: boolean;
  installedVersion: string;
  updateAvailable: boolean;
};

export type ScriptMarketResult = {
  market: {
    status: string;
    message: string;
    indexUrl: string;
    updatedAt: string;
    scripts: ScriptMarketItem[];
  };
  user_scripts: UserScriptInventory;
} & {
  status: string;
  message: string;
};

export function isVersionNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const normalized = value.trim().replace(/^[vV]/, "");
    const match = normalized.match(/^[\d.]+/);
    if (!match) return null;
    const parts = match[0].split(".").map((part) => Number.parseInt(part, 10));
    if (parts.some(Number.isNaN)) return null;
    return parts;
  };
  const left = parse(candidate);
  const right = parse(current);
  if (!left || !right) return false;
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    const candidatePart = left[index] ?? 0;
    const currentPart = right[index] ?? 0;
    if (candidatePart > currentPart) return true;
    if (candidatePart < currentPart) return false;
  }
  return false;
}

export function syncMarketInstalledState(current: ScriptMarketResult | null, userScripts: UserScriptInventory): ScriptMarketResult | null {
  if (!current) return current;
  const installed = new Map(
    (userScripts.scripts ?? [])
      .filter((script) => script.market_id)
      .map((script) => [script.market_id || "", script.version || ""]),
  );
  return {
    ...current,
    user_scripts: userScripts,
    market: {
      ...current.market,
      scripts: current.market.scripts.map((script) => {
        const installedVersion = installed.get(script.id) || "";
        return {
          ...script,
          installed: Boolean(installedVersion),
          installedVersion,
          updateAvailable: Boolean(installedVersion) && isVersionNewer(script.version, installedVersion),
        };
      }),
    },
  };
}
