import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_OPTIONS, normalizeRenderOptions } from "./settings";

describe("normalizeRenderOptions", () => {
  it("returns defaults for empty input", () => {
    expect(normalizeRenderOptions()).toEqual(DEFAULT_RENDER_OPTIONS);
  });

  it("clamps depth and link limits", () => {
    expect(
      normalizeRenderOptions({
        childDepth: 99,
        maxBacklinks: 1,
        maxChildPages: 999,
      }),
    ).toMatchObject({
      childDepth: 9,
      maxBacklinks: 10,
      maxChildPages: 200,
    });
  });

  it("preserves supported child sort options", () => {
    expect(
      normalizeRenderOptions({
        childSort: "created-desc",
      }),
    ).toMatchObject({
      childSort: "created-desc",
    });
  });

  it("preserves explicit section toggles", () => {
    expect(
      normalizeRenderOptions({
        showBacklinks: false,
        showChildPages: true,
      }),
    ).toMatchObject({
      showBacklinks: false,
      showChildPages: true,
    });
  });

  it("falls back for unsupported values", () => {
    expect(
      normalizeRenderOptions({
        childDepth: "nope",
        childSort: "updated-desc",
        showBacklinks: "false",
      }),
    ).toMatchObject({
      childDepth: DEFAULT_RENDER_OPTIONS.childDepth,
      childSort: DEFAULT_RENDER_OPTIONS.childSort,
      showBacklinks: DEFAULT_RENDER_OPTIONS.showBacklinks,
    });
  });
});
