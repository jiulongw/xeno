export const MAIN_CHANNEL_KEY = "__main__";

export function buildChannelKey(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

export function parseChannelKey(key: string): { platform: string; channelId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0 || idx === key.length - 1) {
    return null;
  }
  return { platform: key.slice(0, idx), channelId: key.slice(idx + 1) };
}

export function sanitizeChannelKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}
