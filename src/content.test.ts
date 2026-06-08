import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutoLinksPanel,
  fetchBacklinks,
  fetchChildPages,
  fetchPagePreview,
  findPageRoot,
  getCurrentPageContext,
  renderAutoLinksData,
  type AutoLinkData,
  type PageContext,
} from "./content";
import { DEFAULT_RENDER_OPTIONS } from "./settings";

const SAMPLE_PAGE_HTML = `
  <main>
    <h1>Current page</h1>
    <div data-testid="renderer-document" class="ak-renderer-document">
      <p>Body</p>
    </div>
  </main>
`;

const PAGE_CONTEXT: PageContext = {
  origin: "https://example.atlassian.net",
  pageId: "12345",
  pageUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/12345",
  spaceKey: "ENG",
};

const COMMENT_THEN_PAGE_HTML = `
  <div class="ak-renderer-wrapper is-comment">
    <div class="ak-renderer-document">
      <p>Inline comment body</p>
    </div>
  </div>
  <main>
    <h1>Current page</h1>
    <div class="ak-renderer-document">
      <p>Page body</p>
    </div>
  </main>
`;

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = SAMPLE_PAGE_HTML;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getCurrentPageContext", () => {
  it("extracts page id and space key from modern Confluence page URLs", () => {
    expect(
      getCurrentPageContext(
        new URL(
          "https://example.atlassian.net/wiki/spaces/ENG/pages/12345/Current+page",
        ),
        document,
      ),
    ).toEqual(PAGE_CONTEXT);
  });

  it("extracts page id from legacy query URLs and space key from meta", () => {
    document.head.innerHTML = '<meta name="ajs-space-key" content="DOCS" />';

    expect(
      getCurrentPageContext(
        new URL(
          "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=67890",
        ),
        document,
      ),
    ).toEqual({
      origin: "https://example.atlassian.net",
      pageId: "67890",
      pageUrl: "https://example.atlassian.net/wiki/spaces/DOCS/pages/67890",
      spaceKey: "DOCS",
    });
  });
});

describe("findPageRoot", () => {
  it("skips Confluence inline comment renderers", () => {
    document.body.innerHTML = COMMENT_THEN_PAGE_HTML;

    const pageRoot = findPageRoot(document);

    expect(pageRoot?.textContent).toContain("Page body");
    expect(pageRoot?.closest(".ak-renderer-wrapper.is-comment")).toBeNull();
  });
});

describe("fetchBacklinks", () => {
  it("uses the Confluence relation API and maps source pages", async () => {
    const fetchMock = vi.fn(async () =>
      createJsonResponse({
        results: [
          {
            source: {
              id: "111",
              title: "Source page",
              type: "page",
              _links: {
                webui: "/spaces/ENG/pages/111/Source+page",
              },
            },
          },
        ],
        size: 1,
        limit: 50,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBacklinks(PAGE_CONTEXT, DEFAULT_RENDER_OPTIONS),
    ).resolves.toEqual([
      {
        href: "https://example.atlassian.net/wiki/spaces/ENG/pages/111/Source+page",
        id: "111",
        title: "Source page",
        type: "page",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/rest/api/relation/link/to/content/12345/from/content?expand=source&limit=50",
      expect.objectContaining({
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
        },
      }),
    );
  });

  it("sorts relation backlinks by title", async () => {
    const fetchMock = vi.fn(async () =>
      createJsonResponse({
        results: [
          {
            source: {
              id: "222",
              title: "Beta source",
              type: "page",
            },
          },
          {
            source: {
              id: "111",
              title: "Alpha source",
              type: "page",
            },
          },
        ],
        size: 2,
        limit: 50,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBacklinks(PAGE_CONTEXT, {
        ...DEFAULT_RENDER_OPTIONS,
        backlinkSort: "title-asc",
      }),
    ).resolves.toMatchObject([
      {
        id: "111",
        title: "Alpha source",
      },
      {
        id: "222",
        title: "Beta source",
      },
    ]);
  });

  it("fetches source details for created date backlink sorting", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path.includes("/relation/link/")) {
        return createJsonResponse({
          results: [
            {
              source: {
                id: "111",
                title: "Old source",
                type: "page",
              },
            },
            {
              source: {
                id: "222",
                title: "New source",
                type: "page",
              },
            },
          ],
          size: 2,
          limit: 50,
        });
      }

      if (path === "/wiki/api/v2/pages/111") {
        return createJsonResponse({
          createdAt: "2024-01-01T00:00:00.000Z",
          id: "111",
          title: "Old source",
          type: "page",
        });
      }

      return createJsonResponse({
        createdAt: "2024-02-01T00:00:00.000Z",
        id: "222",
        title: "New source",
        type: "page",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBacklinks(PAGE_CONTEXT, {
        ...DEFAULT_RENDER_OPTIONS,
        backlinkSort: "created-desc",
      }),
    ).resolves.toMatchObject([
      {
        createdAt: "2024-02-01T00:00:00.000Z",
        id: "222",
      },
      {
        createdAt: "2024-01-01T00:00:00.000Z",
        id: "111",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/111",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/222",
      expect.any(Object),
    );
  });

  it("falls back to Page Information incoming links when relation API is empty", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path.includes("/relation/link/")) {
        return createJsonResponse({
          results: [],
          size: 0,
          limit: 50,
        });
      }

      return createHtmlResponse(`
        <main>
          <h2>Incoming Links</h2>
          <ul>
            <li>
              <a href="/spaces/ENG/pages/111/Source+page">Source page</a>
            </li>
            <li>
              <a href="/wiki/spaces/ENG/pages/222/Second+source">Second source</a>
            </li>
          </ul>
          <h2>Outgoing Links</h2>
          <a href="/wiki/spaces/ENG/pages/999/Outgoing">Outgoing</a>
        </main>
      `);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBacklinks(PAGE_CONTEXT, DEFAULT_RENDER_OPTIONS),
    ).resolves.toEqual([
      {
        href: "https://example.atlassian.net/wiki/spaces/ENG/pages/111/Source+page",
        id: "111",
        title: "Source page",
        type: "page",
      },
      {
        href: "https://example.atlassian.net/wiki/spaces/ENG/pages/222/Second+source",
        id: "222",
        title: "Second source",
        type: "page",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/pages/viewinfo.action?pageId=12345",
      expect.objectContaining({
        credentials: "same-origin",
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      }),
    );
  });

  it("parses Page Information table backlinks and ignores child page duplicates", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path.includes("/relation/link/")) {
        return createJsonResponse({
          results: [],
          size: 0,
          limit: 50,
        });
      }

      return createHtmlResponse(`
        <main>
          <div class="basicPanelContainer">
            <div class="basicPanelTitle">受信リンク</div>
            <div class="basicPanelBody">
              <span>Example space (1)</span>
              <table class="pageInfoTable">
                <tbody>
                  <tr>
                    <td><span>ページ:</span></td>
                    <td>
                      <a id="1807909723" href="/wiki/spaces/ENG/pages/1807909723/backlink+test">
                        backlink検証用ページ
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td><span>ページ:</span></td>
                    <td>
                      <a id="12345" href="/wiki/spaces/ENG/pages/12345/Current+page">
                        Current page
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="basicPanelContainer">
            <div class="basicPanelTitle">ページ階層</div>
            <div class="basicPanelBody">
              <a id="1807909723" href="/wiki/spaces/ENG/pages/1807909723/backlink+test">
                backlink検証用ページ
              </a>
            </div>
          </div>
        </main>
      `);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBacklinks(PAGE_CONTEXT, DEFAULT_RENDER_OPTIONS),
    ).resolves.toEqual([
      {
        href: "https://example.atlassian.net/wiki/spaces/ENG/pages/1807909723/backlink+test",
        id: "1807909723",
        title: "backlink検証用ページ",
        type: "page",
      },
    ]);
  });

  it("uses Page Information incoming links when relation API fails", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path.includes("/relation/link/")) {
        return new Response("Forbidden", {
          status: 403,
          statusText: "Forbidden",
        });
      }

      return createHtmlResponse(`
        <main>
          <h2>Incoming Links</h2>
          <a href="/wiki/spaces/ENG/pages/111/Source+page">Source page</a>
        </main>
      `);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBacklinks(PAGE_CONTEXT, DEFAULT_RENDER_OPTIONS),
    ).resolves.toMatchObject([
      {
        id: "111",
        title: "Source page",
      },
    ]);
  });
});

describe("fetchChildPages", () => {
  it("uses the descendants API and maps child item types", async () => {
    const fetchMock = vi.fn(async () =>
      createJsonResponse({
        results: [
          {
            childPosition: 0,
            depth: 1,
            id: "222",
            _links: {
              webui: "/spaces/ENG/pages/222/Direct+child",
            },
            parentId: "12345",
            title: "Direct child",
            type: "page",
          },
          {
            childPosition: 0,
            depth: 2,
            id: "333",
            parentId: "222",
            title: "Nested child",
            type: "page",
          },
          {
            childPosition: 1,
            depth: 1,
            id: "444",
            title: "Whiteboard",
            type: "whiteboard",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchChildPages(PAGE_CONTEXT, DEFAULT_RENDER_OPTIONS),
    ).resolves.toEqual([
      {
        childPosition: 0,
        depth: 1,
        href: "https://example.atlassian.net/wiki/spaces/ENG/pages/222/Direct+child",
        id: "222",
        parentId: "12345",
        title: "Direct child",
        type: "page",
      },
      {
        childPosition: 0,
        depth: 2,
        href: "https://example.atlassian.net/wiki/spaces/ENG/pages/333",
        id: "333",
        parentId: "222",
        title: "Nested child",
        type: "page",
      },
      {
        childPosition: 1,
        depth: 1,
        href: "https://example.atlassian.net/wiki/spaces/ENG/whiteboard/444",
        id: "444",
        title: "Whiteboard",
        type: "whiteboard",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/12345/descendants?depth=2&limit=100",
      expect.any(Object),
    );
  });

  it("sorts child items by title while preserving hierarchy", async () => {
    const fetchMock = vi.fn(async () =>
      createJsonResponse({
        results: [
          {
            depth: 1,
            id: "222",
            parentId: "12345",
            title: "Beta",
            type: "page",
          },
          {
            depth: 2,
            id: "333",
            parentId: "222",
            title: "Alpha nested",
            type: "page",
          },
          {
            depth: 1,
            id: "444",
            parentId: "12345",
            title: "Alpha",
            type: "page",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const childPages = await fetchChildPages(PAGE_CONTEXT, {
      ...DEFAULT_RENDER_OPTIONS,
      childSort: "title-asc",
    });

    expect(childPages.map((item) => item.title)).toEqual([
      "Alpha",
      "Beta",
      "Alpha nested",
    ]);
  });

  it("fetches details for non-page items without a display link", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path.includes("/descendants?")) {
        return createJsonResponse({
          results: [
            {
              depth: 1,
              id: "555",
              parentId: "12345",
              title: "Design doc",
              type: "embed",
            },
          ],
        });
      }

      return createJsonResponse({
        embedUrl: "https://example.com/design-doc",
        id: "555",
        title: "Design doc",
        type: "embed",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchChildPages(PAGE_CONTEXT, DEFAULT_RENDER_OPTIONS),
    ).resolves.toMatchObject([
      {
        href: "https://example.com/design-doc",
        id: "555",
        title: "Design doc",
        type: "embed",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/embeds/555",
      expect.any(Object),
    );
  });

  it("fetches content details for created date sorting", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path.includes("/descendants?")) {
        return createJsonResponse({
          results: [
            {
              depth: 1,
              id: "222",
              parentId: "12345",
              title: "Older",
              type: "page",
            },
            {
              depth: 1,
              id: "333",
              parentId: "12345",
              title: "Newer",
              type: "page",
            },
          ],
        });
      }

      if (path === "/wiki/api/v2/pages/222") {
        return createJsonResponse({
          createdAt: "2024-01-01T00:00:00.000Z",
          id: "222",
          title: "Older",
          type: "page",
        });
      }

      return createJsonResponse({
        createdAt: "2024-02-01T00:00:00.000Z",
        id: "333",
        title: "Newer",
        type: "page",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const childPages = await fetchChildPages(PAGE_CONTEXT, {
      ...DEFAULT_RENDER_OPTIONS,
      childSort: "created-desc",
    });

    expect(childPages.map((item) => item.title)).toEqual(["Newer", "Older"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/222",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/333",
      expect.any(Object),
    );
  });
});

describe("fetchPagePreview", () => {
  it("uses REST API v2 page details and extracts preview metadata", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/wiki/api/v2/users-bulk") {
        return createJsonResponse({
          results: [
            {
              accountId: "account-1",
              displayName: "Example User",
            },
          ],
        });
      }

      return createJsonResponse({
        id: "111",
        title: "Source page",
        createdAt: "2026-01-01T00:00:00.000Z",
        version: {
          authorId: "account-1",
          createdAt: "2026-01-05T00:00:00.000Z",
          number: 3,
        },
        body: {
          view: {
            value: `
              <h1>Source page</h1>
              <p>Example project launch planning notes.</p>
            `,
          },
        },
        labels: {
          results: [{ name: "example" }, { label: "launch" }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPagePreview({
        href: "https://example.atlassian.net/wiki/spaces/ENG/pages/111",
        id: "111",
        title: "Fallback title",
        type: "page",
      }),
    ).resolves.toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      excerpt: "Example project launch planning notes.",
      href: "https://example.atlassian.net/wiki/spaces/ENG/pages/111",
      id: "111",
      labels: ["example", "launch"],
      title: "Source page",
      type: "page",
      updatedBy: {
        accountId: "account-1",
        displayName: "Example User",
      },
      updatedAt: "2026-01-05T00:00:00.000Z",
      versionNumber: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/111?body-format=view&include-labels=true&include-version=true",
      expect.objectContaining({
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/wiki/api/v2/users-bulk",
      expect.objectContaining({
        body: JSON.stringify({ accountIds: ["account-1"] }),
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
  });
});

describe("createAutoLinksPanel", () => {
  it("renders backlinks and depth-indented child items", () => {
    const panel = createAutoLinksPanel(
      {
        backlinks: [
          {
            href: "https://example.atlassian.net/wiki/spaces/ENG/pages/111",
            id: "111",
            title: "Source page",
          },
        ],
        childPages: [
          {
            depth: 1,
            href: "https://example.atlassian.net/wiki/spaces/ENG/pages/222",
            id: "222",
            title: "Direct child",
            type: "page",
          },
          {
            depth: 2,
            href: "https://example.atlassian.net/wiki/spaces/ENG/pages/333",
            id: "333",
            title: "Nested child",
            type: "database",
          },
        ],
        errors: {},
      },
      DEFAULT_RENDER_OPTIONS,
    );

    expect(panel.querySelector("h1")?.textContent).toBe("Related links");
    expect(
      [...panel.querySelectorAll("a")].map((link) => link.textContent),
    ).toEqual(["Source page", "Direct child", "Nested child"]);
    expect(
      panel
        .querySelectorAll<HTMLElement>(".confluence-autolinks__item")[2]
        .style.getPropertyValue("--confluence-autolinks-depth"),
    ).toBe("1");
    expect(
      panel
        .querySelectorAll(".confluence-autolinks__type-icon")[2]
        .getAttribute("aria-label"),
    ).toBe("Database");
  });

  it("shows a REST API page preview when a page link is hovered", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/wiki/api/v2/users-bulk") {
        return createJsonResponse({
          results: [
            {
              accountId: "account-1",
              displayName: "Example User",
            },
          ],
        });
      }

      return createJsonResponse({
        id: "111",
        title: "Source page",
        version: {
          authorId: "account-1",
          createdAt: "2026-01-05T00:00:00.000Z",
          number: 4,
        },
        body: {
          view: {
            value: "<p>Preview body from REST API v2.</p>",
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const panel = createAutoLinksPanel(
      {
        backlinks: [
          {
            href: "https://example.atlassian.net/wiki/spaces/ENG/pages/111",
            id: "111",
            title: "Source page",
            type: "page",
          },
        ],
        childPages: [],
        errors: {},
      },
      DEFAULT_RENDER_OPTIONS,
    );
    document.body.append(panel);

    const link = panel.querySelector("a");
    link?.dispatchEvent(new Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();

    const preview = document.querySelector<HTMLElement>(
      "[data-confluence-autolinks-preview]",
    );
    expect(preview?.textContent).toContain("Source page");
    expect(preview?.textContent).toContain("Updated by Example User");
    expect(preview?.textContent).toContain("Preview body from REST API v2.");
    expect(link?.getAttribute("aria-describedby")).toBe(preview?.id);
  });

  it("keeps the preview open while the preview itself is hovered", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      createJsonResponse({
        id: "222",
        title: "Source page",
        body: {
          view: {
            value: "<p>Preview body from REST API v2.</p>",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const panel = createAutoLinksPanel(
      {
        backlinks: [
          {
            href: "https://example.atlassian.net/wiki/spaces/ENG/pages/222",
            id: "222",
            title: "Source page",
            type: "page",
          },
        ],
        childPages: [],
        errors: {},
      },
      DEFAULT_RENDER_OPTIONS,
    );
    document.body.append(panel);

    const link = panel.querySelector("a");
    link?.dispatchEvent(new Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();

    const preview = document.querySelector<HTMLElement>(
      "[data-confluence-autolinks-preview]",
    );
    link?.dispatchEvent(new Event("pointerleave"));
    preview?.dispatchEvent(new Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(120);

    expect(preview?.isConnected).toBe(true);

    preview?.dispatchEvent(new Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(120);

    expect(
      document.querySelector("[data-confluence-autolinks-preview]"),
    ).toBeNull();
  });
});

describe("renderAutoLinksData", () => {
  it("appends the panel to the end of the Confluence page root", () => {
    const data: AutoLinkData = {
      backlinks: [],
      childPages: [],
      errors: {},
    };

    renderAutoLinksData(document, data, DEFAULT_RENDER_OPTIONS, "source-key");

    const pageRoot = document.querySelector<HTMLElement>(
      '[data-testid="renderer-document"]',
    );
    const panel = document.querySelector<HTMLElement>(
      "[data-confluence-autolinks]",
    );

    expect(pageRoot?.lastElementChild).toBe(panel);
    expect(panel?.getAttribute("data-confluence-autolinks-source")).toBe(
      "source-key",
    );
  });

  it("moves an existing panel out of an inline comment renderer", () => {
    document.body.innerHTML = COMMENT_THEN_PAGE_HTML;
    const commentRoot = document.querySelector<HTMLElement>(
      ".ak-renderer-wrapper.is-comment .ak-renderer-document",
    );
    const existingPanel = document.createElement("section");
    existingPanel.setAttribute("data-confluence-autolinks", "true");
    commentRoot?.append(existingPanel);

    const data: AutoLinkData = {
      backlinks: [],
      childPages: [],
      errors: {},
    };

    renderAutoLinksData(document, data, DEFAULT_RENDER_OPTIONS, "source-key");

    const pageRoot = findPageRoot(document);
    const panel = document.querySelector<HTMLElement>(
      "[data-confluence-autolinks]",
    );

    expect(
      commentRoot?.querySelector("[data-confluence-autolinks]"),
    ).toBeNull();
    expect(pageRoot?.lastElementChild).toBe(panel);
    expect(panel?.getAttribute("data-confluence-autolinks-source")).toBe(
      "source-key",
    );
  });
});

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
    status: 200,
  });
}

function createHtmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html",
    },
    status: 200,
  });
}
