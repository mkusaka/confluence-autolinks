import { defineManifest } from "@crxjs/vite-plugin";
import packageJson from "../package.json";

export default defineManifest({
  manifest_version: 3,
  name: "Confluence Autolinks",
  description:
    "Show backlinks and configurable-depth child item links at the end of Confluence Cloud pages.",
  version: packageJson.version,
  permissions: ["storage"],
  options_page: "options.html",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  content_scripts: [
    {
      matches: ["https://*.atlassian.net/wiki/*"],
      js: ["src/content.ts"],
      run_at: "document_idle",
    },
  ],
});
