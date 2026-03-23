import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { OutboundMessageTarget } from "../chat/service";
import { logger } from "../logger";
import type { ChannelSession } from "./session";
import { MAIN_CHANNEL_KEY, buildChannelKey, parseChannelKey } from "./types";

export interface ChannelRegistryConfig {
  home: string;
  mainSession: ChannelSession;
  createTopicSession: (channelKey: string, channelName?: string) => Promise<ChannelSession>;
}

export class ChannelRegistry {
  private readonly home: string;
  private readonly mainSession: ChannelSession;
  private readonly createTopicSession: (
    channelKey: string,
    channelName?: string,
  ) => Promise<ChannelSession>;
  private readonly sessions = new Map<string, ChannelSession>();
  private readonly pendingCreations = new Map<string, Promise<ChannelSession>>();
  private mainChannelId: string | null;

  constructor(config: ChannelRegistryConfig) {
    this.home = config.home;
    this.mainSession = config.mainSession;
    this.createTopicSession = config.createTopicSession;
    this.sessions.set(MAIN_CHANNEL_KEY, this.mainSession);
    this.mainChannelId = this.loadMainChannelId();
  }

  async resolve(
    platform: string,
    channelId: string | undefined,
    chatType?: string,
    channelName?: string,
  ): Promise<ChannelSession> {
    if (platform === "rpc") {
      return this.mainSession;
    }

    if (!channelId) {
      return this.mainSession;
    }

    const key = buildChannelKey(platform, channelId);

    // If no main channel claimed yet and this is a private chat, claim it
    if (this.mainChannelId === null && chatType === "private") {
      this.mainChannelId = key;
      this.persistMainChannelId(key);
      logger.info({ channelKey: key }, "Claimed main channel");
      return this.mainSession;
    }

    // If this is the main channel, return main session
    if (key === this.mainChannelId) {
      return this.mainSession;
    }

    // Look up existing topic session
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    // Check if creation is already in progress
    const pending = this.pendingCreations.get(key);
    if (pending) {
      return pending;
    }

    // Create new topic session
    const creation = this.createTopicSession(key, channelName)
      .then((session) => {
        this.sessions.set(key, session);
        this.pendingCreations.delete(key);
        logger.info({ channelKey: key }, "Created topic channel session");
        return session;
      })
      .catch((error) => {
        this.pendingCreations.delete(key);
        throw error;
      });
    this.pendingCreations.set(key, creation);

    return creation;
  }

  getMainSession(): ChannelSession {
    return this.mainSession;
  }

  findSession(platform: string, channelId: string): ChannelSession | undefined {
    const key = buildChannelKey(platform, channelId);
    if (key === this.mainChannelId) {
      return this.mainSession;
    }
    return this.sessions.get(key);
  }

  getSessionByKey(channelKey: string): ChannelSession | undefined {
    return this.sessions.get(channelKey);
  }

  getMainChannelTarget(): OutboundMessageTarget | null {
    if (!this.mainChannelId) {
      return null;
    }
    const parsed = parseChannelKey(this.mainChannelId);
    if (!parsed) {
      return null;
    }
    return { platform: parsed.platform, channelId: parsed.channelId } as OutboundMessageTarget;
  }

  async shutdown(): Promise<void> {
    // Wait for any in-flight topic session creations to complete (or fail)
    await Promise.allSettled(this.pendingCreations.values());

    const topicShutdowns: Promise<void>[] = [];
    for (const [key, session] of this.sessions) {
      if (key !== MAIN_CHANNEL_KEY) {
        topicShutdowns.push(session.shutdown());
      }
    }
    await Promise.all(topicShutdowns);
    await this.mainSession.shutdown();
  }

  private get channelsFilePath(): string {
    return join(this.home, ".xeno", "channels.json");
  }

  private loadMainChannelId(): string | null {
    try {
      if (!existsSync(this.channelsFilePath)) {
        return null;
      }
      const data = JSON.parse(readFileSync(this.channelsFilePath, "utf-8"));
      if (data && typeof data.main_channel_id === "string" && data.main_channel_id.length > 0) {
        return data.main_channel_id;
      }
      return null;
    } catch {
      return null;
    }
  }

  private persistMainChannelId(channelId: string): void {
    try {
      mkdirSync(dirname(this.channelsFilePath), { recursive: true });
      writeFileSync(this.channelsFilePath, JSON.stringify({ main_channel_id: channelId }, null, 2));
    } catch (error) {
      logger.error({ error }, "Failed to persist main channel ID");
    }
  }
}
