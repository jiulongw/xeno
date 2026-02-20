import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "../../src/agent";
import { ChannelRegistry } from "../../src/channel/registry";
import { ChannelSession } from "../../src/channel/session";
import { MAIN_CHANNEL_KEY } from "../../src/channel/types";

export interface TestChannelRegistryOptions {
  home?: string;
  mainChannelId?: string;
}

/**
 * Creates a ChannelRegistry for tests that routes everything to the main session.
 */
export function createTestChannelRegistry(
  agent: AgentRuntime,
  options?: TestChannelRegistryOptions,
): ChannelRegistry {
  const home = options?.home ?? "/tmp/test-home";

  if (options?.mainChannelId) {
    const xenoDir = join(home, ".xeno");
    mkdirSync(xenoDir, { recursive: true });
    writeFileSync(
      join(xenoDir, "channels.json"),
      JSON.stringify({ main_channel_id: options.mainChannelId }),
    );
  }

  const mainSession = new ChannelSession(MAIN_CHANNEL_KEY, agent);
  return new ChannelRegistry({
    home,
    mainSession,
    createTopicSession: async (channelKey, _channelName) => {
      // In tests, topic sessions just reuse the same agent for simplicity
      return new ChannelSession(channelKey, agent);
    },
  });
}
