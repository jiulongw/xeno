import type { PlatformCapabilities, PlatformContext } from "./service";

export function formatMessage(
  content: string,
  _context: PlatformContext,
  capabilities: PlatformCapabilities,
): string {
  if (capabilities.supportsMarkdownTables) {
    return content;
  }

  // Stub formatter for non-table-capable platforms.
  return content;
}
