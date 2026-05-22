import "./options.css";
import {
  CHILD_DEPTHS,
  CHILD_SORT_OPTIONS,
  DEFAULT_RENDER_OPTIONS,
  LINK_LIMITS,
  normalizeRenderOptions,
  type ChildSortOption,
  type RenderOptions,
} from "./settings";
import { readRenderOptions, writeRenderOptions } from "./storage";

const form = getRequiredElement<HTMLFormElement>("autolinks-options-form");
const showBacklinksInput =
  getRequiredElement<HTMLInputElement>("show-backlinks");
const showChildPagesInput =
  getRequiredElement<HTMLInputElement>("show-child-pages");
const childDepthSelect = getRequiredElement<HTMLSelectElement>("child-depth");
const childSortSelect = getRequiredElement<HTMLSelectElement>("child-sort");
const maxBacklinksSelect =
  getRequiredElement<HTMLSelectElement>("max-backlinks");
const maxChildPagesSelect =
  getRequiredElement<HTMLSelectElement>("max-child-pages");
const resetButton = getRequiredElement<HTMLButtonElement>("reset");
const statusOutput = getRequiredElement<HTMLOutputElement>("status");

let statusTimer: number | undefined;

populateNumberSelect(childDepthSelect, CHILD_DEPTHS);
populateNumberSelect(maxBacklinksSelect, LINK_LIMITS);
populateNumberSelect(maxChildPagesSelect, LINK_LIMITS);
populateChildSortSelect(childSortSelect, CHILD_SORT_OPTIONS);

readRenderOptions()
  .then((options) => {
    applyOptionsToForm(options);
  })
  .catch((error: unknown) => {
    applyOptionsToForm(DEFAULT_RENDER_OPTIONS);
    showStatus(error instanceof Error ? error.message : "Failed to load");
  });

form.addEventListener("change", () => {
  void saveCurrentFormOptions();
});

resetButton.addEventListener("click", () => {
  applyOptionsToForm(DEFAULT_RENDER_OPTIONS);
  void saveCurrentFormOptions("Defaults restored");
});

function populateNumberSelect(
  select: HTMLSelectElement,
  values: readonly number[],
): void {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(value);
    select.append(option);
  }
}

function populateChildSortSelect(
  select: HTMLSelectElement,
  values: readonly { label: string; value: ChildSortOption }[],
): void {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value.value;
    option.textContent = value.label;
    select.append(option);
  }
}

async function saveCurrentFormOptions(message = "Saved"): Promise<void> {
  const options = getOptionsFromForm();
  applyOptionsToForm(options);

  try {
    await writeRenderOptions(options);
    showStatus(message);
  } catch (error: unknown) {
    showStatus(error instanceof Error ? error.message : "Failed to save");
  }
}

function applyOptionsToForm(options: RenderOptions): void {
  showBacklinksInput.checked = options.showBacklinks;
  showChildPagesInput.checked = options.showChildPages;
  childDepthSelect.value = String(options.childDepth);
  childSortSelect.value = options.childSort;
  maxBacklinksSelect.value = String(options.maxBacklinks);
  maxChildPagesSelect.value = String(options.maxChildPages);
}

function getOptionsFromForm(): RenderOptions {
  const formData = new FormData(form);

  return normalizeRenderOptions({
    childDepth: formData.get("childDepth"),
    childSort: formData.get("childSort"),
    maxBacklinks: formData.get("maxBacklinks"),
    maxChildPages: formData.get("maxChildPages"),
    showBacklinks: showBacklinksInput.checked,
    showChildPages: showChildPagesInput.checked,
  });
}

function showStatus(message: string): void {
  window.clearTimeout(statusTimer);
  statusOutput.value = message;
  statusTimer = window.setTimeout(() => {
    statusOutput.value = "";
  }, 1500);
}

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }

  return element as T;
}
