import "./content.css";
import {
  DEFAULT_RENDER_OPTIONS,
  RENDER_OPTIONS_STORAGE_KEY,
  normalizeRenderOptions,
  shouldRenderAnySection,
  type ChildSortOption,
  type RenderOptions,
} from "./settings";
import { readRenderOptions } from "./storage";

const ROOT_ATTR = "data-confluence-autolinks";
const SOURCE_ATTR = "data-confluence-autolinks-source";
const STATE_ATTR = "data-confluence-autolinks-state";
const SCAN_DEBOUNCE_MS = 250;
const API_PAGE_LIMIT = 100;
const DETAILS_FETCH_CONCURRENCY = 8;
const PAGE_INFO_BACKLINK_SECTION_LABELS = new Set([
  "Incoming Links",
  "受信リンク",
]);
const PAGE_INFO_SECTION_BOUNDARY_LABELS = new Set([
  "Hierarchy",
  "ページ階層",
  "Labels",
  "ラベル",
  "Outgoing Links",
  "発信リンク",
  "Recent Changes",
  "最近の変更",
]);

const PAGE_ROOT_SELECTORS = [
  '[data-testid="renderer-document"]',
  ".ak-renderer-document",
];

const PAGE_ID_META_SELECTORS = [
  'meta[name="ajs-page-id"]',
  'meta[name="ajs-content-id"]',
  'meta[name="pageId"]',
  'meta[property="ajs-page-id"]',
];

const SPACE_KEY_META_SELECTORS = [
  'meta[name="ajs-space-key"]',
  'meta[name="space-key"]',
  'meta[property="ajs-space-key"]',
];

export type PageContext = {
  origin: string;
  pageId: string;
  pageUrl: string;
  spaceKey?: string;
};

export type AutoLinkItem = {
  id: string;
  title: string;
  childPosition?: number;
  createdAt?: string;
  depth?: number;
  href?: string;
  parentId?: string;
  type?: string;
};

export type AutoLinkData = {
  backlinks: AutoLinkItem[];
  childPages: AutoLinkItem[];
  errors: Partial<Record<"backlinks" | "childPages", string>>;
};

type DescendantsResponse = {
  results?: unknown[];
  _links?: {
    next?: string;
  };
};

type RelationResponse = {
  limit?: number;
  results?: unknown[];
  size?: number;
  start?: number;
  _links?: {
    next?: string;
  };
};

type ChildNode = {
  children: ChildNode[];
  item: AutoLinkItem;
  order: number;
};

let currentOptions = DEFAULT_RENDER_OPTIONS;
let scanTimer: number | undefined;
let activeRequestId = 0;
let activeAbortController: AbortController | undefined;

export function findPageRoot(root: ParentNode = document): HTMLElement | null {
  for (const selector of PAGE_ROOT_SELECTORS) {
    const element = root.querySelector(selector);

    if (element instanceof HTMLElement) {
      return element;
    }
  }

  return null;
}

export function getCurrentPageContext(
  sourceLocation: Location | URL = window.location,
  root: ParentNode = document,
): PageContext | null {
  const url =
    sourceLocation instanceof URL
      ? sourceLocation
      : new URL(sourceLocation.href);
  const pageId = findPageId(url, root);

  if (!pageId) {
    return null;
  }

  const spaceKey = findSpaceKey(url, root);

  return {
    origin: url.origin,
    pageId,
    pageUrl: createPageHref(url.origin, spaceKey, pageId),
    ...(spaceKey ? { spaceKey } : {}),
  };
}

export async function fetchBacklinks(
  context: PageContext,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<AutoLinkItem[]> {
  let relationError: unknown;

  try {
    const backlinks = await fetchRelationBacklinks(context, options, signal);

    if (backlinks.length > 0) {
      return backlinks;
    }
  } catch (error) {
    relationError = error;
  }

  try {
    return await fetchPageInfoBacklinks(context, options, signal);
  } catch {
    if (relationError) {
      throw relationError;
    }

    return [];
  }
}

async function fetchRelationBacklinks(
  context: PageContext,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<AutoLinkItem[]> {
  const backlinks: AutoLinkItem[] = [];
  let start = 0;
  let nextPath: string | undefined = createBacklinksPath(
    context.pageId,
    Math.min(API_PAGE_LIMIT, options.maxBacklinks),
    start,
  );

  while (nextPath && backlinks.length < options.maxBacklinks) {
    const response = await requestJson<RelationResponse>(nextPath, signal);
    const results = Array.isArray(response.results) ? response.results : [];

    for (const result of results) {
      const source = readRecord(result)?.source;
      const item = sourceToLinkItem(source, context);

      if (item) {
        backlinks.push(item);
      }

      if (backlinks.length >= options.maxBacklinks) {
        break;
      }
    }

    const next = normalizeNextPath(response._links?.next, context.origin);

    if (next && backlinks.length < options.maxBacklinks) {
      nextPath = next;
      continue;
    }

    const receivedSize = Number.isFinite(response.size)
      ? Number(response.size)
      : results.length;
    const responseLimit = Number.isFinite(response.limit)
      ? Number(response.limit)
      : API_PAGE_LIMIT;

    if (
      receivedSize >= responseLimit &&
      backlinks.length < options.maxBacklinks
    ) {
      start += receivedSize;
      nextPath = createBacklinksPath(
        context.pageId,
        Math.min(API_PAGE_LIMIT, options.maxBacklinks - backlinks.length),
        start,
      );
      continue;
    }

    nextPath = undefined;
  }

  return backlinks;
}

async function fetchPageInfoBacklinks(
  context: PageContext,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<AutoLinkItem[]> {
  const html = await requestText(createPageInfoPath(context.pageId), signal);

  return parsePageInfoBacklinks(html, context, options.maxBacklinks);
}

export async function fetchChildPages(
  context: PageContext,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<AutoLinkItem[]> {
  const childPages: AutoLinkItem[] = [];
  let nextPath: string | undefined = createDescendantsPath(
    context.pageId,
    options.childDepth,
    Math.min(API_PAGE_LIMIT, options.maxChildPages),
  );

  while (nextPath && childPages.length < options.maxChildPages) {
    const response: DescendantsResponse =
      await requestJson<DescendantsResponse>(nextPath, signal);
    const results = Array.isArray(response.results) ? response.results : [];

    for (const result of results) {
      const item = descendantToLinkItem(result, context);

      if (item) {
        childPages.push(item);
      }

      if (childPages.length >= options.maxChildPages) {
        break;
      }
    }

    nextPath =
      childPages.length < options.maxChildPages
        ? normalizeNextPath(response._links?.next, context.origin)
        : undefined;
  }

  const shouldFetchCreatedAt = isCreatedSort(options.childSort);
  const shouldFetchMissingLinks = childPages.some(
    (item) => item.type !== "page" && !item.href,
  );
  const enrichedChildPages =
    shouldFetchCreatedAt || shouldFetchMissingLinks
      ? await enrichItemsWithContentDetails(
          childPages,
          context,
          shouldFetchCreatedAt,
          signal,
        )
      : childPages;

  return sortChildItems(enrichedChildPages, context.pageId, options.childSort);
}

async function enrichItemsWithContentDetails(
  items: AutoLinkItem[],
  context: PageContext,
  fetchAll: boolean,
  signal?: AbortSignal,
): Promise<AutoLinkItem[]> {
  const enrichedItems: AutoLinkItem[] = [];

  for (
    let index = 0;
    index < items.length;
    index += DETAILS_FETCH_CONCURRENCY
  ) {
    const batch = items.slice(index, index + DETAILS_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) =>
        enrichItemWithContentDetails(item, context, fetchAll, signal),
      ),
    );

    enrichedItems.push(...results);
  }

  return enrichedItems;
}

async function enrichItemWithContentDetails(
  item: AutoLinkItem,
  context: PageContext,
  fetchAll: boolean,
  signal?: AbortSignal,
): Promise<AutoLinkItem> {
  if (!fetchAll && (item.href || item.type === "page")) {
    return item;
  }

  const detailPath = createContentDetailsPath(item.type, item.id);

  if (!detailPath) {
    return item;
  }

  try {
    const details = await requestJson<Record<string, unknown>>(
      detailPath,
      signal,
    );
    const detailItem = contentRecordToLinkItem(details, context, {
      childPosition: item.childPosition,
      depth: item.depth,
      parentId: item.parentId,
      requireHref: false,
      type: item.type,
    });

    return {
      ...item,
      ...(detailItem?.href ? { href: detailItem.href } : {}),
      ...(detailItem?.title ? { title: detailItem.title } : {}),
      ...pickCreatedAt(detailItem?.createdAt, details),
    };
  } catch {
    return item;
  }
}

function sortChildItems(
  items: AutoLinkItem[],
  rootPageId: string,
  sortOption: ChildSortOption,
): AutoLinkItem[] {
  const nodes = items.map((item, index) => createChildNode(item, index));
  const nodesById = new Map(nodes.map((node) => [node.item.id, node]));
  const roots: ChildNode[] = [];

  for (const node of nodes) {
    const parentId = node.item.parentId;
    const parent =
      parentId && parentId !== rootPageId ? nodesById.get(parentId) : undefined;

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const compareNodes = createChildNodeComparator(sortOption);

  function flatten(sortedNodes: ChildNode[]): AutoLinkItem[] {
    sortedNodes.sort(compareNodes);

    return sortedNodes.flatMap((node) => [
      node.item,
      ...flatten(node.children),
    ]);
  }

  return flatten(roots);
}

function createChildNode(item: AutoLinkItem, order: number): ChildNode {
  return {
    children: [],
    item,
    order,
  };
}

function createChildNodeComparator(sortOption: ChildSortOption) {
  return (left: ChildNode, right: ChildNode): number => {
    const direction = sortOption.endsWith("-desc") ? -1 : 1;
    let result = 0;

    if (sortOption.startsWith("title-")) {
      result = compareTitle(left.item.title, right.item.title);
    } else if (sortOption.startsWith("created-")) {
      result = compareCreatedAt(
        left.item.createdAt,
        right.item.createdAt,
        direction,
      );
      return result === 0 ? left.order - right.order : result;
    } else {
      result = compareChildPosition(
        left.item,
        right.item,
        left.order,
        right.order,
        direction,
      );
      return result === 0 ? left.order - right.order : result;
    }

    return result === 0 ? left.order - right.order : result * direction;
  };
}

function compareTitle(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareCreatedAt(
  left: string | undefined,
  right: string | undefined,
  direction: number,
): number {
  const leftTime = parseDateTime(left);
  const rightTime = parseDateTime(right);

  if (leftTime === undefined && rightTime === undefined) {
    return 0;
  }

  if (leftTime === undefined) {
    return 1;
  }

  if (rightTime === undefined) {
    return -1;
  }

  return (leftTime - rightTime) * direction;
}

function compareChildPosition(
  left: AutoLinkItem,
  right: AutoLinkItem,
  leftOrder: number,
  rightOrder: number,
  direction: number,
): number {
  const leftPosition = left.childPosition;
  const rightPosition = right.childPosition;

  if (leftPosition === undefined && rightPosition === undefined) {
    return leftOrder - rightOrder;
  }

  if (leftPosition === undefined) {
    return 1;
  }

  if (rightPosition === undefined) {
    return -1;
  }

  return (leftPosition - rightPosition) * direction;
}

function isCreatedSort(sortOption: ChildSortOption): boolean {
  return sortOption === "created-asc" || sortOption === "created-desc";
}

function pickCreatedAt(
  createdAt: string | undefined,
  details: Record<string, unknown>,
): Pick<AutoLinkItem, "createdAt"> | Record<string, never> {
  const normalizedCreatedAt =
    createdAt ?? normalizeText(readString(details.createdAt));

  return normalizedCreatedAt ? { createdAt: normalizedCreatedAt } : {};
}

export async function fetchAutoLinkData(
  context: PageContext,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<AutoLinkData> {
  const [backlinksResult, childPagesResult] = await Promise.allSettled([
    options.showBacklinks
      ? fetchBacklinks(context, options, signal)
      : Promise.resolve([]),
    options.showChildPages
      ? fetchChildPages(context, options, signal)
      : Promise.resolve([]),
  ]);

  return {
    backlinks:
      backlinksResult.status === "fulfilled" ? backlinksResult.value : [],
    childPages:
      childPagesResult.status === "fulfilled" ? childPagesResult.value : [],
    errors: {
      ...(backlinksResult.status === "rejected"
        ? { backlinks: getErrorMessage(backlinksResult.reason) }
        : {}),
      ...(childPagesResult.status === "rejected"
        ? { childPages: getErrorMessage(childPagesResult.reason) }
        : {}),
    },
  };
}

export async function renderAutoLinks(
  root: ParentNode = document,
  options: RenderOptions = currentOptions,
): Promise<void> {
  const pageRoot = findPageRoot(root);
  const context = getCurrentPageContext(window.location, root);
  const existingPanel = getExistingPanel(root);

  if (!pageRoot || !context || !shouldRenderAnySection(options)) {
    existingPanel?.remove();
    return;
  }

  const sourceKey = createSourceKey(context, options);

  if (
    existingPanel?.isConnected &&
    existingPanel.getAttribute(SOURCE_ATTR) === sourceKey
  ) {
    return;
  }

  const requestId = activeRequestId + 1;
  activeRequestId = requestId;
  activeAbortController?.abort();
  activeAbortController = new AbortController();

  renderLoadingPanel(pageRoot, sourceKey);

  const data = await fetchAutoLinkData(
    context,
    options,
    activeAbortController.signal,
  );

  if (requestId !== activeRequestId) {
    return;
  }

  renderAutoLinksData(root, data, options, sourceKey);
}

export function renderAutoLinksData(
  root: ParentNode,
  data: AutoLinkData,
  options: RenderOptions,
  sourceKey: string,
): void {
  const pageRoot = findPageRoot(root);

  if (!pageRoot) {
    return;
  }

  const panel = createAutoLinksPanel(data, options);
  panel.setAttribute(SOURCE_ATTR, sourceKey);
  panel.setAttribute(STATE_ATTR, "loaded");

  const existingPanel = getExistingPanel(root);

  if (existingPanel?.isConnected) {
    existingPanel.replaceWith(panel);
    return;
  }

  pageRoot.append(panel);
}

export function createAutoLinksPanel(
  data: AutoLinkData,
  options: RenderOptions,
): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "confluence-autolinks";
  panel.setAttribute(ROOT_ATTR, "true");
  panel.setAttribute("aria-label", "Related Confluence links");

  const header = document.createElement("div");
  header.className = "confluence-autolinks__header";

  const title = document.createElement("h2");
  title.className = "confluence-autolinks__title";
  title.textContent = "Related links";

  header.append(title);
  panel.append(header);

  if (options.showBacklinks) {
    panel.append(
      createSection({
        emptyMessage: "No backlinks found.",
        error: data.errors.backlinks,
        items: data.backlinks,
        title: "Backlinks",
      }),
    );
  }

  if (options.showChildPages) {
    panel.append(
      createSection({
        emptyMessage: "No child items found.",
        error: data.errors.childPages,
        items: data.childPages,
        title: `Child items depth ${options.childDepth}`,
        useDepth: true,
      }),
    );
  }

  return panel;
}

export function observePageChanges(): MutationObserver | undefined {
  if (!document.body) {
    return undefined;
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(isExtensionMutation)) {
      return;
    }

    scheduleRender();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return observer;
}

function start(): void {
  void startAsync();
}

async function startAsync(): Promise<void> {
  try {
    currentOptions = await readRenderOptions();
  } catch {
    currentOptions = DEFAULT_RENDER_OPTIONS;
  }

  observePageChanges();
  observeOptionChanges();
  scheduleRender();
}

function scheduleRender(): void {
  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }

  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    void renderAutoLinks();
  }, SCAN_DEBOUNCE_MS);
}

function observeOptionChanges(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName !== "sync" ||
      !Object.hasOwn(changes, RENDER_OPTIONS_STORAGE_KEY)
    ) {
      return;
    }

    currentOptions = normalizeRenderOptions(
      (changes[RENDER_OPTIONS_STORAGE_KEY]?.newValue ??
        DEFAULT_RENDER_OPTIONS) as Partial<
        Record<keyof RenderOptions, unknown>
      >,
    );
    scheduleRender();
  });
}

function renderLoadingPanel(pageRoot: HTMLElement, sourceKey: string): void {
  const panel = document.createElement("section");
  panel.className = "confluence-autolinks";
  panel.setAttribute(ROOT_ATTR, "true");
  panel.setAttribute(SOURCE_ATTR, sourceKey);
  panel.setAttribute(STATE_ATTR, "loading");
  panel.setAttribute("aria-label", "Related Confluence links");

  const title = document.createElement("h2");
  title.className = "confluence-autolinks__title";
  title.textContent = "Related links";

  const message = document.createElement("p");
  message.className = "confluence-autolinks__message";
  message.textContent = "Loading related links...";

  panel.append(title, message);

  const existingPanel = getExistingPanel(document);

  if (existingPanel?.isConnected) {
    existingPanel.replaceWith(panel);
    return;
  }

  pageRoot.append(panel);
}

function createSection({
  emptyMessage,
  error,
  items,
  title,
  useDepth = false,
}: {
  emptyMessage: string;
  items: AutoLinkItem[];
  title: string;
  error?: string;
  useDepth?: boolean;
}): HTMLElement {
  const section = document.createElement("section");
  section.className = "confluence-autolinks__section";

  const heading = document.createElement("h3");
  heading.className = "confluence-autolinks__section-title";
  heading.textContent = `${title} (${items.length})`;
  section.append(heading);

  if (error) {
    const message = document.createElement("p");
    message.className =
      "confluence-autolinks__message confluence-autolinks__message--error";
    message.textContent = `Failed to load: ${error}`;
    section.append(message);
    return section;
  }

  if (items.length === 0) {
    const message = document.createElement("p");
    message.className = "confluence-autolinks__message";
    message.textContent = emptyMessage;
    section.append(message);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "confluence-autolinks__list";

  for (const item of items) {
    list.append(createLinkItem(item, useDepth));
  }

  section.append(list);
  return section;
}

function createLinkItem(item: AutoLinkItem, useDepth: boolean): HTMLLIElement {
  const listItem = document.createElement("li");
  listItem.className = "confluence-autolinks__item";

  if (useDepth) {
    listItem.style.setProperty(
      "--confluence-autolinks-depth",
      String(Math.max(0, (item.depth ?? 1) - 1)),
    );
  }

  const content = item.href
    ? createLinkContent(item.href)
    : createPlainContent();

  const icon = createTypeIcon(item.type);
  const title = document.createElement("span");
  title.className = "confluence-autolinks__link-title";
  title.textContent = item.title;

  content.append(icon, title);
  listItem.append(content);
  return listItem;
}

function createLinkContent(href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "confluence-autolinks__link";
  link.href = href;
  return link;
}

function createPlainContent(): HTMLSpanElement {
  const label = document.createElement("span");
  label.className = "confluence-autolinks__label";
  return label;
}

function createTypeIcon(type: string | undefined): HTMLSpanElement {
  const normalizedType = normalizeContentType(type);
  const icon = document.createElement("span");
  icon.className = `confluence-autolinks__type-icon confluence-autolinks__type-icon--${normalizedType}`;
  icon.setAttribute("aria-label", getTypeLabel(normalizedType));
  icon.setAttribute("role", "img");
  return icon;
}

function findPageId(url: URL, root: ParentNode): string | undefined {
  const urlPageId = findPageIdInUrl(url);

  if (urlPageId) {
    return urlPageId;
  }

  for (const selector of PAGE_ID_META_SELECTORS) {
    const pageId = normalizeId(
      root.querySelector<HTMLMetaElement>(selector)?.content,
    );

    if (pageId) {
      return pageId;
    }
  }

  return undefined;
}

function findPageIdInUrl(url: URL): string | undefined {
  const queryPageId =
    normalizeId(url.searchParams.get("pageId")) ??
    normalizeId(url.searchParams.get("contentId"));

  if (queryPageId) {
    return queryPageId;
  }

  const pagePathMatch = /\/pages\/(\d+)(?:\/|$)/.exec(url.pathname);

  return normalizeId(pagePathMatch?.[1]);
}

function findSpaceKey(url: URL, root: ParentNode): string | undefined {
  const spacePathMatch = /\/spaces\/([^/]+)(?:\/|$)/.exec(url.pathname);
  const pathSpaceKey = normalizeSpaceKey(spacePathMatch?.[1]);

  if (pathSpaceKey) {
    return pathSpaceKey;
  }

  for (const selector of SPACE_KEY_META_SELECTORS) {
    const spaceKey = normalizeSpaceKey(
      root.querySelector<HTMLMetaElement>(selector)?.content,
    );

    if (spaceKey) {
      return spaceKey;
    }
  }

  return undefined;
}

function normalizeId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(id) ? id : undefined;
}

function normalizeContentType(value: unknown): string {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (
    type === "smartlink" ||
    type === "smart-link" ||
    type === "smart link" ||
    type === "smart_link"
  ) {
    return "embed";
  }

  if (
    type === "database" ||
    type === "embed" ||
    type === "folder" ||
    type === "page" ||
    type === "whiteboard"
  ) {
    return type;
  }

  return "page";
}

function getTypeLabel(type: string): string {
  if (type === "database") {
    return "Database";
  }

  if (type === "embed") {
    return "Smart Link";
  }

  if (type === "folder") {
    return "Folder";
  }

  if (type === "whiteboard") {
    return "Whiteboard";
  }

  return "Page";
}

function normalizeSpaceKey(value: unknown): string | undefined {
  const spaceKey = typeof value === "string" ? value.trim() : "";

  if (!spaceKey) {
    return undefined;
  }

  try {
    return decodeURIComponent(spaceKey);
  } catch {
    return spaceKey;
  }
}

function createBacklinksPath(
  pageId: string,
  limit: number,
  start: number,
): string {
  const params = new URLSearchParams({
    expand: "source",
    limit: String(limit),
  });

  if (start > 0) {
    params.set("start", String(start));
  }

  return `/wiki/rest/api/relation/link/to/content/${pageId}/from/content?${params}`;
}

function createPageInfoPath(pageId: string): string {
  const params = new URLSearchParams({
    pageId,
  });

  return `/wiki/pages/viewinfo.action?${params}`;
}

function createDescendantsPath(
  pageId: string,
  depth: number,
  limit: number,
): string {
  const params = new URLSearchParams({
    depth: String(depth),
    limit: String(limit),
  });

  return `/wiki/api/v2/pages/${pageId}/descendants?${params}`;
}

function createContentDetailsPath(
  type: string | undefined,
  id: string,
): string | null {
  const normalizedType = normalizeContentType(type);

  if (normalizedType === "page") {
    return `/wiki/api/v2/pages/${id}`;
  }

  if (normalizedType === "database") {
    return `/wiki/api/v2/databases/${id}`;
  }

  if (normalizedType === "embed") {
    return `/wiki/api/v2/embeds/${id}`;
  }

  if (normalizedType === "folder") {
    return `/wiki/api/v2/folders/${id}`;
  }

  if (normalizedType === "whiteboard") {
    return `/wiki/api/v2/whiteboards/${id}`;
  }

  return null;
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }

  return (await response.json()) as T;
}

async function requestText(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      Accept: "text/html,application/xhtml+xml",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }

  return await response.text();
}

function parsePageInfoBacklinks(
  html: string,
  context: PageContext,
  limit: number,
): AutoLinkItem[] {
  if (limit <= 0) {
    return [];
  }

  const document = new DOMParser().parseFromString(html, "text/html");
  const sectionBacklinks = collectPageInfoSectionBacklinks(
    document,
    context,
    limit,
  );

  if (sectionBacklinks.length > 0) {
    return sectionBacklinks;
  }

  return collectPageInfoTableBacklinks(document, context, limit);
}

function collectPageInfoSectionBacklinks(
  document: Document,
  context: PageContext,
  limit: number,
): AutoLinkItem[] {
  for (const section of findPageInfoBacklinkSections(document)) {
    const backlinks = collectPageInfoAnchorBacklinks(
      section.querySelectorAll<HTMLAnchorElement>("a[href]"),
      context,
      limit,
    );

    if (backlinks.length > 0) {
      return backlinks;
    }
  }

  return [];
}

function collectPageInfoTableBacklinks(
  document: Document,
  context: PageContext,
  limit: number,
): AutoLinkItem[] {
  return collectPageInfoAnchorBacklinks(
    document.querySelectorAll<HTMLAnchorElement>("table.pageInfoTable a[href]"),
    context,
    limit,
  );
}

function collectPageInfoAnchorBacklinks(
  anchors: Iterable<HTMLAnchorElement>,
  context: PageContext,
  limit: number,
): AutoLinkItem[] {
  const backlinks: AutoLinkItem[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const item = pageInfoAnchorToLinkItem(anchor, context);

    if (!item || item.id === context.pageId || seen.has(item.href ?? item.id)) {
      continue;
    }

    backlinks.push(item);
    seen.add(item.href ?? item.id);

    if (backlinks.length >= limit) {
      break;
    }
  }

  return backlinks;
}

function findPageInfoBacklinkSections(document: Document): HTMLElement[] {
  const sections: HTMLElement[] = [];

  for (const heading of document.querySelectorAll<HTMLElement>(
    "h1,h2,h3,h4,h5,h6,legend,dt,strong,b,span,div",
  )) {
    if (!isPageInfoBacklinkLabel(heading.textContent)) {
      continue;
    }

    sections.push(findPageInfoSectionContainer(heading));
  }

  return sections;
}

function findPageInfoSectionContainer(heading: HTMLElement): HTMLElement {
  const panel = heading.closest<HTMLElement>(".basicPanelContainer");

  if (panel) {
    return panel;
  }

  const section = heading.closest<HTMLElement>("section,fieldset");

  return section ?? collectUntilPageInfoSectionBoundary(heading);
}

function collectUntilPageInfoSectionBoundary(
  heading: HTMLElement,
): HTMLElement {
  const fragment = heading.ownerDocument.createElement("div");
  let sibling = heading.nextElementSibling;

  while (sibling && sibling instanceof HTMLElement) {
    if (isPageInfoSectionBoundary(sibling)) {
      break;
    }

    fragment.append(sibling.cloneNode(true));
    sibling = sibling.nextElementSibling;
  }

  return fragment;
}

function isPageInfoBacklinkLabel(value: string | null): boolean {
  const label = normalizeText(value ?? undefined);

  return Boolean(label && PAGE_INFO_BACKLINK_SECTION_LABELS.has(label));
}

function isPageInfoSectionBoundary(element: HTMLElement): boolean {
  const label = normalizeText(element.textContent ?? undefined);

  if (!label) {
    return false;
  }

  if (PAGE_INFO_SECTION_BOUNDARY_LABELS.has(label)) {
    return true;
  }

  return /^H[1-6]$/.test(element.tagName);
}

function pageInfoAnchorToLinkItem(
  anchor: HTMLAnchorElement,
  context: PageContext,
): AutoLinkItem | null {
  const href = anchor.getAttribute("href");
  const title = normalizeText(anchor.textContent ?? undefined);

  if (!href || !title) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(href, context.origin);
  } catch {
    return null;
  }

  if (url.origin !== context.origin || !isLikelyPageInfoBacklink(url)) {
    return null;
  }

  return {
    href: url.href,
    id: findPageIdInUrl(url) ?? url.href,
    title,
    type: "page",
  };
}

function isLikelyPageInfoBacklink(url: URL): boolean {
  return Boolean(
    findPageIdInUrl(url) ??
    (url.pathname.includes("/display/") ? url.href : undefined),
  );
}

function sourceToLinkItem(
  source: unknown,
  context: PageContext,
): AutoLinkItem | null {
  const sourceRecord = readRecord(source);

  if (!sourceRecord) {
    return null;
  }

  return contentRecordToLinkItem(sourceRecord, context);
}

function descendantToLinkItem(
  descendant: unknown,
  context: PageContext,
): AutoLinkItem | null {
  const descendantRecord = readRecord(descendant);

  if (!descendantRecord) {
    return null;
  }

  const type = normalizeContentType(readString(descendantRecord.type));

  return contentRecordToLinkItem(descendantRecord, context, {
    childPosition: normalizeIntegerValue(descendantRecord.childPosition),
    createdAt: normalizeText(readString(descendantRecord.createdAt)),
    depth: normalizeDepth(descendantRecord.depth),
    parentId: normalizeId(descendantRecord.parentId),
    requireHref: false,
    type,
  });
}

type ContentRecordOverrides = Partial<
  Pick<
    AutoLinkItem,
    "childPosition" | "createdAt" | "depth" | "parentId" | "type"
  >
> & {
  requireHref?: boolean;
};

function contentRecordToLinkItem(
  content: Record<string, unknown>,
  context: PageContext,
  overrides: ContentRecordOverrides = {},
): AutoLinkItem | null {
  const id = normalizeId(content.id) ?? normalizeId(content.contentId);
  const title =
    normalizeText(readString(content.title)) ??
    normalizeText(readString(content.displayTitle)) ??
    normalizeText(readString(content.name));

  if (!id || !title) {
    return null;
  }

  const type = overrides.type ?? normalizeContentType(readString(content.type));
  const href = getContentHref(content, context, id, type);

  if (!href && (overrides.requireHref ?? true)) {
    return null;
  }

  return {
    id,
    title,
    ...(overrides.childPosition !== undefined
      ? { childPosition: overrides.childPosition }
      : {}),
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    ...(overrides.depth ? { depth: overrides.depth } : {}),
    ...(href ? { href } : {}),
    ...(overrides.parentId ? { parentId: overrides.parentId } : {}),
    ...(type ? { type } : {}),
  };
}

function getContentHref(
  content: Record<string, unknown>,
  context: PageContext,
  id: string,
  type: string,
): string | null {
  const links = readRecord(content._links);
  const webui = readString(links?.webui) ?? readString(links?.tinyui);
  const embedUrl = readString(content.embedUrl);

  if (webui) {
    return createAbsoluteUrl(context.origin, webui);
  }

  if (embedUrl) {
    return embedUrl;
  }

  if (!type || type === "page") {
    return createPageHref(context.origin, context.spaceKey, id);
  }

  if (type === "whiteboard" && context.spaceKey) {
    return createWhiteboardHref(context.origin, context.spaceKey, id);
  }

  return null;
}

function createPageHref(
  origin: string,
  spaceKey: string | undefined,
  pageId: string,
): string {
  if (spaceKey) {
    return `${origin}/wiki/spaces/${encodeURIComponent(spaceKey)}/pages/${pageId}`;
  }

  return `${origin}/wiki/pages/viewpage.action?pageId=${pageId}`;
}

function createWhiteboardHref(
  origin: string,
  spaceKey: string,
  whiteboardId: string,
): string {
  return `${origin}/wiki/spaces/${encodeURIComponent(spaceKey)}/whiteboard/${whiteboardId}`;
}

function createAbsoluteUrl(origin: string, value: string): string {
  return new URL(value, origin).href;
}

function normalizeNextPath(
  nextPath: string | undefined,
  origin: string,
): string | undefined {
  if (!nextPath) {
    return undefined;
  }

  try {
    const url = new URL(nextPath, origin);

    if (url.origin !== origin) {
      return undefined;
    }

    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function normalizeDepth(value: unknown): number {
  const numberValue =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isFinite(numberValue)) {
    return 1;
  }

  return Math.max(1, Math.trunc(numberValue));
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function normalizeIntegerValue(value: unknown): number | undefined {
  const numberValue =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isFinite(numberValue)) {
    return undefined;
  }

  return Math.trunc(numberValue);
}

function parseDateTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

function createSourceKey(context: PageContext, options: RenderOptions): string {
  return `${context.origin}:${context.pageId}:${context.spaceKey ?? ""}\n${JSON.stringify(
    options,
  )}`;
}

function getExistingPanel(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${ROOT_ATTR}]`);
}

function isExtensionMutation(mutation: MutationRecord): boolean {
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];

  if (changedNodes.length === 0) {
    return isExtensionNode(mutation.target);
  }

  return changedNodes.every(isExtensionNode);
}

function isExtensionNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  return Boolean(node.closest(`[${ROOT_ATTR}]`));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function shouldAutoStart(): boolean {
  return import.meta.env.MODE !== "test";
}

if (shouldAutoStart() && document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else if (shouldAutoStart()) {
  start();
}
