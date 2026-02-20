import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface QueuedMessage {
  timestamp: string;
  userId?: string;
  userName?: string;
  content: string;
}

export class ChannelMessageQueue {
  private readonly filePath: string;

  constructor(channelHome: string) {
    this.filePath = join(channelHome, "message-queue.jsonl");
  }

  async append(message: QueuedMessage): Promise<void> {
    const line = JSON.stringify(message) + "\n";
    await appendFile(this.filePath, line, "utf-8");
  }

  async flush(): Promise<QueuedMessage[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }

    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }

    const messages: QueuedMessage[] = [];
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as QueuedMessage;
        messages.push(parsed);
      } catch {
        // skip malformed lines
      }
    }

    // Truncate the file
    await writeFile(this.filePath, "", "utf-8");
    return messages;
  }
}
