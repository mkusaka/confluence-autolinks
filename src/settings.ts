export const MIN_CHILD_DEPTH = 1;
export const MAX_CHILD_DEPTH = 9;
export const CHILD_DEPTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const LINK_SORT_OPTIONS = [
  { label: "Content tree", value: "tree-asc" },
  { label: "Content tree (reverse)", value: "tree-desc" },
  { label: "Title A-Z", value: "title-asc" },
  { label: "Title Z-A", value: "title-desc" },
  { label: "Created oldest first", value: "created-asc" },
  { label: "Created newest first", value: "created-desc" },
] as const;
export const CHILD_SORT_OPTIONS = LINK_SORT_OPTIONS;
export const LINK_LIMITS = [10, 25, 50, 100, 200] as const;
export const RENDER_OPTIONS_STORAGE_KEY = "renderOptions";

export type LinkSortOption = (typeof LINK_SORT_OPTIONS)[number]["value"];
export type ChildSortOption = LinkSortOption;

export type RenderOptions = {
  backlinkSort: LinkSortOption;
  childDepth: number;
  childSort: ChildSortOption;
  maxBacklinks: number;
  maxChildPages: number;
  showBacklinks: boolean;
  showChildPages: boolean;
};

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  backlinkSort: "tree-asc",
  childDepth: 2,
  childSort: "tree-asc",
  maxBacklinks: 50,
  maxChildPages: 100,
  showBacklinks: true,
  showChildPages: true,
};

export function normalizeRenderOptions(
  rawOptions: Partial<Record<keyof RenderOptions, unknown>> = {},
): RenderOptions {
  return {
    backlinkSort: normalizeLinkSort(
      rawOptions.backlinkSort,
      DEFAULT_RENDER_OPTIONS.backlinkSort,
    ),
    childDepth: normalizeInteger(
      rawOptions.childDepth,
      DEFAULT_RENDER_OPTIONS.childDepth,
      MIN_CHILD_DEPTH,
      MAX_CHILD_DEPTH,
    ),
    childSort: normalizeLinkSort(
      rawOptions.childSort,
      DEFAULT_RENDER_OPTIONS.childSort,
    ),
    maxBacklinks: normalizeInteger(
      rawOptions.maxBacklinks,
      DEFAULT_RENDER_OPTIONS.maxBacklinks,
      LINK_LIMITS[0],
      LINK_LIMITS[LINK_LIMITS.length - 1],
    ),
    maxChildPages: normalizeInteger(
      rawOptions.maxChildPages,
      DEFAULT_RENDER_OPTIONS.maxChildPages,
      LINK_LIMITS[0],
      LINK_LIMITS[LINK_LIMITS.length - 1],
    ),
    showBacklinks: normalizeBoolean(
      rawOptions.showBacklinks,
      DEFAULT_RENDER_OPTIONS.showBacklinks,
    ),
    showChildPages: normalizeBoolean(
      rawOptions.showChildPages,
      DEFAULT_RENDER_OPTIONS.showChildPages,
    ),
  };
}

export function shouldRenderAnySection(options: RenderOptions): boolean {
  return options.showBacklinks || options.showChildPages;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeLinkSort(
  value: unknown,
  fallback: LinkSortOption,
): LinkSortOption {
  if (
    typeof value === "string" &&
    LINK_SORT_OPTIONS.some((option) => option.value === value)
  ) {
    return value as LinkSortOption;
  }

  return fallback;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const numberValue =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(numberValue)));
}
