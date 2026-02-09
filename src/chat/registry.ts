import { logger } from "../logger";
import type { ChatService, PlatformType } from "./service";

export class ChatServiceRegistry {
  private readonly services = new Map<PlatformType, ChatService>();
  private readonly startTasks = new Map<PlatformType, Promise<void>>();

  register(service: ChatService): void {
    if (this.services.has(service.type)) {
      throw new Error(`Service already registered: ${service.type}`);
    }
    this.services.set(service.type, service);
  }

  get(type: PlatformType): ChatService | undefined {
    return this.services.get(type);
  }

  list(): ChatService[] {
    return Array.from(this.services.values());
  }

  startAll(): void {
    for (const service of this.services.values()) {
      if (this.startTasks.has(service.type)) {
        continue;
      }

      const task = service.start().catch((error) => {
        logger.error({ error, service: service.type }, "Chat service exited with error");
      });
      this.startTasks.set(service.type, task);
    }
  }

  async stopAll(): Promise<void> {
    const stopResults = await Promise.allSettled(
      Array.from(this.services.values()).map(async (service) => {
        await service.stop();
      }),
    );

    for (const result of stopResults) {
      if (result.status === "rejected") {
        logger.error({ error: result.reason }, "Failed to stop chat service");
      }
    }
  }

  async waitForAnyStop(): Promise<void> {
    if (this.startTasks.size === 0) {
      return;
    }

    await Promise.race(
      Array.from(this.startTasks.values()).map((task) =>
        task.then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
  }
}
