# confluence-autolinks

Chrome extension that appends Confluence Cloud backlinks and child item links
to the end of rendered pages.

## Requirements

- Node.js
- pnpm 11
- Chrome

## Install

```sh
pnpm install
```

## Build

```sh
pnpm build
```

Build output is written to `dist/`. The extension manifest is generated from
`src/manifest.ts`, and content styles are imported from `src/content.ts` so Vite
emits the CSS used by the content script.

The JavaScript bundle is emitted as ASCII-only output so Chrome can load it
reliably.

## Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository's `dist/` directory.
5. Open or reload a Confluence Cloud page under
   `https://*.atlassian.net/wiki/*`.

## Test on Confluence

Open a Confluence Cloud page that has incoming links or child items. The
extension detects the rendered page body, reads the current page ID from the URL
or Confluence metadata, and appends a `Related links` section at the end of the
page body.

The extension reads:

- Backlinks through Confluence's relation API:
  `/wiki/rest/api/relation/link/to/content/{pageId}/from/content`
- If the relation API returns no backlinks or cannot be read, backlinks fall
  back to Confluence's Page Information view:
  `/wiki/pages/viewinfo.action?pageId={pageId}`
- Child items through Confluence REST API v2 descendants:
  `/wiki/api/v2/pages/{pageId}/descendants`
- Created-date sorting enriches child items through the relevant REST API v2
  by-id endpoint for pages, databases, Smart Links, folders, and whiteboards.

Both requests are same-origin requests from the Confluence page and use the
current browser session. The extension does not store Confluence API responses.

## Options

Open Chrome's extension details for Confluence Autolinks and choose Extension
options. The options page stores rendering preferences in `chrome.storage.sync`.

Available options:

- Show or hide backlinks
- Show or hide child items
- Child item depth
- Child item sort order
- Maximum backlinks
- Maximum child items

## Development

```sh
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm icons:generate
pnpm build
pnpm package
pnpm check
```

`pnpm test` runs the Vitest/jsdom tests for option normalization, page context
extraction, Confluence API response mapping, and DOM rendering.

`pnpm check` runs formatting check, lint, TypeScript type checking, tests, and
then builds the extension.

`pnpm package` builds the extension and writes a Chrome extension package to
`package.zip`.

Icon PNGs are generated from `assets/icon.svg` into `public/icons/`.
Regenerating them requires ImageMagick's `magick` command.

GitHub Actions workflow checks:

```sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
go run github.com/suzuki-shunsuke/ghalint/cmd/ghalint@v1.5.6 run
go run github.com/suzuki-shunsuke/pinact/v3/cmd/pinact@v3.10.0 run --check
uvx zizmor==1.25.0 --format=plain --collect=workflows .
```

## Security

- The extension does not inject CDN scripts.
- The manifest only requests the `storage` permission for rendering options.
- The only content script match target is `https://*.atlassian.net/wiki/*`.
- The extension only reads Confluence Cloud REST APIs from the same page origin.
- The extension only mutates the local browser DOM and does not update
  Confluence content.

## Limitations

- Related links are visible only to users who have this extension installed.
- Related links do not change Confluence page content.
- Related links do not affect Confluence PDF export or what other users see.
- Confluence Cloud DOM and REST response shapes may change; selectors and
  response mapping may need updates if Atlassian changes rendered page markup
  or API payloads.
