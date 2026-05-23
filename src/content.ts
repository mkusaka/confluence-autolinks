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
const PREVIEW_ATTR = "data-confluence-autolinks-preview";
const SOURCE_ATTR = "data-confluence-autolinks-source";
const STATE_ATTR = "data-confluence-autolinks-state";
const SCAN_DEBOUNCE_MS = 250;
const PREVIEW_SHOW_DELAY_MS = 250;
const PREVIEW_HIDE_DELAY_MS = 120;
const API_PAGE_LIMIT = 100;
const DETAILS_FETCH_CONCURRENCY = 8;
const PREVIEW_EXCERPT_LIMIT = 220;
const PREVIEW_LABEL_LIMIT = 3;
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

export type AutoLinkPreview = {
  id: string;
  title: string;
  createdAt?: string;
  excerpt?: string;
  href?: string;
  labels: string[];
  type?: string;
  updatedBy?: AutoLinkPreviewUser;
  updatedAt?: string;
  versionNumber?: number;
};

export type AutoLinkPreviewUser = {
  accountId: string;
  displayName: string;
  pictureUrl?: string;
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

type RequestJsonOptions = {
  body?: BodyInit;
  headers?: Record<string, string>;
  method?: string;
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
let activePreviewAnchor: HTMLAnchorElement | undefined;
let activePreviewElement: HTMLElement | undefined;
let previewHideTimer: number | undefined;
let previewShowTimer: number | undefined;
let previewToken = 0;

const previewCache = new Map<string, Promise<AutoLinkPreview | null>>();
const userPreviewCache = new Map<string, Promise<AutoLinkPreviewUser | null>>();

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

export async function fetchPagePreview(
  item: AutoLinkItem,
  signal?: AbortSignal,
): Promise<AutoLinkPreview | null> {
  if (!isPagePreviewItem(item)) {
    return null;
  }

  const page = await requestJson<Record<string, unknown>>(
    createPagePreviewPath(item.id),
    signal,
  );
  const preview = pageRecordToPreview(page, item);
  const updatedByAccountId = getUpdatedByAccountId(page);
  const updatedBy = updatedByAccountId
    ? await getCachedUserPreview(updatedByAccountId, signal)
    : null;

  return {
    ...preview,
    ...(updatedBy ? { updatedBy } : {}),
  };
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

  const title = document.createElement("h1");
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

  const title = document.createElement("h1");
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

  const content = item.href ? createLinkContent(item) : createPlainContent();

  const icon = createTypeIcon(item.type);
  const title = document.createElement("span");
  title.className = "confluence-autolinks__link-title";
  title.textContent = item.title;

  content.append(icon, title);
  listItem.append(content);
  return listItem;
}

function createLinkContent(item: AutoLinkItem): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "confluence-autolinks__link";
  link.href = item.href ?? "";

  if (isPagePreviewItem(item)) {
    link.addEventListener("pointerenter", () => {
      scheduleLinkPreview(link, item);
    });
    link.addEventListener("pointerleave", schedulePreviewHide);
    link.addEventListener("focus", () => {
      scheduleLinkPreview(link, item);
    });
    link.addEventListener("blur", schedulePreviewHide);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideLinkPreview();
      }
    });
  }

  return link;
}

function createPlainContent(): HTMLSpanElement {
  const label = document.createElement("span");
  label.className = "confluence-autolinks__label";
  return label;
}

function scheduleLinkPreview(
  anchor: HTMLAnchorElement,
  item: AutoLinkItem,
): void {
  if (previewHideTimer !== undefined) {
    window.clearTimeout(previewHideTimer);
    previewHideTimer = undefined;
  }

  if (previewShowTimer !== undefined) {
    window.clearTimeout(previewShowTimer);
  }

  previewShowTimer = window.setTimeout(() => {
    previewShowTimer = undefined;
    void showLinkPreview(anchor, item);
  }, PREVIEW_SHOW_DELAY_MS);
}

function schedulePreviewHide(): void {
  if (previewShowTimer !== undefined) {
    window.clearTimeout(previewShowTimer);
    previewShowTimer = undefined;
  }

  if (previewHideTimer !== undefined) {
    window.clearTimeout(previewHideTimer);
  }

  previewHideTimer = window.setTimeout(() => {
    previewHideTimer = undefined;
    hideLinkPreview();
  }, PREVIEW_HIDE_DELAY_MS);
}

function cancelPreviewHide(): void {
  if (previewHideTimer !== undefined) {
    window.clearTimeout(previewHideTimer);
    previewHideTimer = undefined;
  }
}

async function showLinkPreview(
  anchor: HTMLAnchorElement,
  item: AutoLinkItem,
): Promise<void> {
  const token = previewToken + 1;
  previewToken = token;
  activePreviewAnchor = anchor;

  const preview = createPreviewShell(item);
  replaceActivePreview(preview);
  anchor.setAttribute("aria-describedby", preview.id);
  positionPreview(anchor, preview);

  const data = await getCachedPagePreview(item);

  if (previewToken !== token || activePreviewAnchor !== anchor) {
    return;
  }

  if (!data) {
    hideLinkPreview();
    return;
  }

  preview.replaceChildren(...createPreviewContent(data));
  positionPreview(anchor, preview);
}

function hideLinkPreview(): void {
  previewToken += 1;
  activePreviewAnchor?.removeAttribute("aria-describedby");
  activePreviewAnchor = undefined;
  activePreviewElement?.remove();
  activePreviewElement = undefined;
}

function replaceActivePreview(preview: HTMLElement): void {
  activePreviewElement?.remove();
  activePreviewElement = preview;
  document.body.append(preview);
}

function createPreviewShell(item: AutoLinkItem): HTMLElement {
  const preview = document.createElement("aside");
  preview.id = `confluence-autolinks-preview-${item.id}`;
  preview.className = "confluence-autolinks__preview";
  preview.setAttribute(PREVIEW_ATTR, "true");
  preview.setAttribute("role", "tooltip");

  const loading = document.createElement("p");
  loading.className = "confluence-autolinks__preview-loading";
  loading.textContent = "Loading preview...";
  preview.append(loading);
  preview.addEventListener("pointerenter", cancelPreviewHide);
  preview.addEventListener("pointerleave", schedulePreviewHide);

  return preview;
}

function createPreviewContent(preview: AutoLinkPreview): Node[] {
  const header = document.createElement("div");
  header.className = "confluence-autolinks__preview-header";

  const icon = createTypeIcon(preview.type);
  icon.classList.add("confluence-autolinks__preview-icon");

  const title = document.createElement("span");
  title.className = "confluence-autolinks__preview-title";
  title.textContent = preview.title;

  header.append(icon, title);

  const nodes: Node[] = [header];
  const metaItems = createPreviewMetaItems(preview);

  if (preview.updatedBy) {
    nodes.push(createPreviewByline(preview.updatedBy));
  }

  if (metaItems.length > 0) {
    const meta = document.createElement("div");
    meta.className = "confluence-autolinks__preview-meta";
    meta.textContent = metaItems.join(" · ");
    nodes.push(meta);
  }

  if (preview.excerpt) {
    const excerpt = document.createElement("p");
    excerpt.className = "confluence-autolinks__preview-excerpt";
    excerpt.textContent = preview.excerpt;
    nodes.push(excerpt);
  }

  if (preview.labels.length > 0) {
    const labels = document.createElement("div");
    labels.className = "confluence-autolinks__preview-labels";

    for (const labelText of preview.labels.slice(0, PREVIEW_LABEL_LIMIT)) {
      const label = document.createElement("span");
      label.className = "confluence-autolinks__preview-label";
      label.textContent = labelText;
      labels.append(label);
    }

    nodes.push(labels);
  }

  const footer = document.createElement("div");
  footer.className = "confluence-autolinks__preview-footer";
  footer.textContent = "Confluence";
  nodes.push(footer);

  return nodes;
}

function createPreviewByline(user: AutoLinkPreviewUser): HTMLElement {
  const byline = document.createElement("div");
  byline.className = "confluence-autolinks__preview-byline";

  if (user.pictureUrl) {
    const avatar = document.createElement("img");
    avatar.className = "confluence-autolinks__preview-avatar";
    avatar.src = user.pictureUrl;
    avatar.alt = "";
    byline.append(avatar);
  } else {
    const avatar = document.createElement("span");
    avatar.className =
      "confluence-autolinks__preview-avatar confluence-autolinks__preview-avatar--fallback";
    avatar.textContent = user.displayName.slice(0, 1).toUpperCase();
    byline.append(avatar);
  }

  const text = document.createElement("span");
  text.textContent = `Updated by ${user.displayName}`;
  byline.append(text);

  return byline;
}

function createPreviewMetaItems(preview: AutoLinkPreview): string[] {
  const metaItems: string[] = [];
  const updatedAt = formatPreviewDate(preview.updatedAt);
  const createdAt = formatPreviewDate(preview.createdAt);

  if (updatedAt) {
    metaItems.push(`Updated ${updatedAt}`);
  } else if (createdAt) {
    metaItems.push(`Created ${createdAt}`);
  }

  if (preview.versionNumber !== undefined) {
    metaItems.push(`v${preview.versionNumber}`);
  }

  return metaItems;
}

function positionPreview(
  anchor: HTMLAnchorElement,
  preview: HTMLElement,
): void {
  const anchorRect = anchor.getBoundingClientRect();
  const margin = 8;
  const viewportPadding = 12;
  const width = preview.offsetWidth || 360;
  const height = preview.offsetHeight || 160;
  const maxLeft = window.innerWidth - width - viewportPadding;
  const left = Math.min(
    Math.max(viewportPadding, anchorRect.left),
    Math.max(viewportPadding, maxLeft),
  );
  const bottomTop = anchorRect.bottom + margin;
  const top =
    bottomTop + height + viewportPadding > window.innerHeight
      ? Math.max(viewportPadding, anchorRect.top - height - margin)
      : bottomTop;

  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
}

async function getCachedPagePreview(
  item: AutoLinkItem,
): Promise<AutoLinkPreview | null> {
  const cacheKey = `${normalizeContentType(item.type)}:${item.id}`;
  const cachedPreview = previewCache.get(cacheKey);

  if (cachedPreview) {
    return await cachedPreview;
  }

  const previewPromise = fetchPagePreview(item).catch(() => null);
  previewCache.set(cacheKey, previewPromise);
  return await previewPromise;
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

function createPagePreviewPath(pageId: string): string {
  const params = new URLSearchParams({
    "body-format": "view",
    "include-labels": "true",
    "include-version": "true",
  });

  return `/wiki/api/v2/pages/${pageId}?${params}`;
}

function createUsersBulkPath(): string {
  return "/wiki/api/v2/users-bulk";
}

function pageRecordToPreview(
  page: Record<string, unknown>,
  item: AutoLinkItem,
): AutoLinkPreview {
  const version = readRecord(page.version);
  const title =
    normalizeText(readString(page.title)) ??
    normalizeText(item.title) ??
    "Untitled";
  const viewBody = readRecord(readRecord(page.body)?.view);
  const viewHtml = readString(viewBody?.value);
  const createdAt = normalizeText(readString(page.createdAt));
  const excerpt = viewHtml ? extractPreviewExcerpt(viewHtml, title) : undefined;
  const updatedAt = normalizeText(readString(version?.createdAt));
  const versionNumber = normalizeIntegerValue(version?.number);

  return {
    id: normalizeId(page.id) ?? item.id,
    labels: collectPreviewLabels(page.labels),
    title,
    ...(createdAt ? { createdAt } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(item.href ? { href: item.href } : {}),
    ...(item.type ? { type: item.type } : { type: "page" }),
    ...(updatedAt ? { updatedAt } : {}),
    ...(versionNumber !== undefined ? { versionNumber } : {}),
  };
}

function collectPreviewLabels(labels: unknown): string[] {
  const labelRecord = readRecord(labels);
  const results = Array.isArray(labelRecord?.results)
    ? labelRecord.results
    : [];
  const names: string[] = [];

  for (const result of results) {
    const label = readRecord(result);
    const name =
      normalizeText(readString(label?.name)) ??
      normalizeText(readString(label?.label));

    if (name && !names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

function getUpdatedByAccountId(
  page: Record<string, unknown>,
): string | undefined {
  const version = readRecord(page.version);

  return normalizeText(readString(version?.authorId));
}

async function getCachedUserPreview(
  accountId: string,
  signal?: AbortSignal,
): Promise<AutoLinkPreviewUser | null> {
  const cachedUser = userPreviewCache.get(accountId);

  if (cachedUser) {
    return await cachedUser;
  }

  const userPromise = fetchUserPreview(accountId, signal).catch(() => null);
  userPreviewCache.set(accountId, userPromise);
  return await userPromise;
}

async function fetchUserPreview(
  accountId: string,
  signal?: AbortSignal,
): Promise<AutoLinkPreviewUser | null> {
  const response = await requestJson<{ results?: unknown[] }>(
    createUsersBulkPath(),
    signal,
    {
      body: JSON.stringify({ accountIds: [accountId] }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  const results = Array.isArray(response.results) ? response.results : [];

  for (const result of results) {
    const user = readRecord(result);

    if (normalizeText(readString(user?.accountId)) === accountId) {
      return userRecordToPreviewUser(user);
    }
  }

  return null;
}

function userRecordToPreviewUser(
  user: Record<string, unknown> | undefined,
): AutoLinkPreviewUser | null {
  if (!user) {
    return null;
  }

  const accountId = normalizeText(readString(user.accountId));
  const displayName =
    normalizeText(readString(user.displayName)) ??
    normalizeText(readString(user.publicName));

  if (!accountId || !displayName) {
    return null;
  }

  const picture = readRecord(user.profilePicture);
  const picturePath = normalizeText(readString(picture?.path));

  return {
    accountId,
    displayName,
    ...(picturePath
      ? { pictureUrl: createAbsoluteUrl(window.location.origin, picturePath) }
      : {}),
  };
}

function extractPreviewExcerpt(
  html: string,
  title: string,
): string | undefined {
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const element of document.querySelectorAll(
    "script,style,nav,button,form",
  )) {
    element.remove();
  }

  const blocks = document.body.querySelectorAll(
    "p,li,td,blockquote,h2,h3,h4,h5,h6",
  );
  const parts: string[] = [];

  for (const block of blocks) {
    const text = normalizeText(block.textContent ?? undefined);

    if (!text || text === title || parts.includes(text)) {
      continue;
    }

    parts.push(text);

    if (parts.join(" ").length >= PREVIEW_EXCERPT_LIMIT) {
      break;
    }
  }

  const excerpt =
    normalizeText(parts.join(" ")) ??
    normalizeText(document.body.textContent ?? undefined);

  return excerpt ? truncateText(excerpt, PREVIEW_EXCERPT_LIMIT) : undefined;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function formatPreviewDate(value: string | undefined): string | undefined {
  const timestamp = parseDateTime(value);

  if (timestamp === undefined) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(timestamp);
}

function isPagePreviewItem(item: AutoLinkItem): boolean {
  return Boolean(
    item.href &&
    normalizeId(item.id) &&
    normalizeContentType(item.type) === "page",
  );
}

async function requestJson<T>(
  path: string,
  signal?: AbortSignal,
  options: RequestJsonOptions = {},
): Promise<T> {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetch(path, {
    ...requestOptions,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...headers,
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

  return Boolean(node.closest(`[${ROOT_ATTR}],[${PREVIEW_ATTR}]`));
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
