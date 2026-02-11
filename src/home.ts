import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import agentsTemplate from "../template/CLAUDE.md" with { type: "text" };
import bootstrapTemplate from "../template/BOOTSTRAP.md" with { type: "text" };
import heartbeatTemplate from "../template/HEARTBEAT.md" with { type: "text" };
import identityTemplate from "../template/IDENTITY.md" with { type: "text" };
import memoryTemplate from "../template/MEMORY.md" with { type: "text" };
import soulTemplate from "../template/SOUL.md" with { type: "text" };
import toolsTemplate from "../template/TOOLS.md" with { type: "text" };
import userTemplate from "../template/USER.md" with { type: "text" };
import claudeSettingsTemplate from "../template/claude.settings.json";
import heartbeatSkill from "../template/skills/heartbeat/SKILL.md" with { type: "text" };
import runCronTaskSkill from "../template/skills/run-cron-task/SKILL.md" with { type: "text" };

type TemplateFile = {
  relativePath: string;
  content: string;
};

const TEMPLATE_FILES: TemplateFile[] = [
  { relativePath: "CLAUDE.md", content: agentsTemplate },
  { relativePath: "BOOTSTRAP.md", content: bootstrapTemplate },
  { relativePath: "HEARTBEAT.md", content: heartbeatTemplate },
  { relativePath: "IDENTITY.md", content: identityTemplate },
  { relativePath: "MEMORY.md", content: memoryTemplate },
  { relativePath: "SOUL.md", content: soulTemplate },
  { relativePath: "TOOLS.md", content: toolsTemplate },
  { relativePath: "USER.md", content: userTemplate },
  {
    relativePath: ".claude/settings.local.json",
    content: JSON.stringify(claudeSettingsTemplate, null, 2) + "\n",
  },
  { relativePath: ".claude/skills/heartbeat/SKILL.md", content: heartbeatSkill },
  { relativePath: ".claude/skills/run-cron-task/SKILL.md", content: runCronTaskSkill },
];

export async function createHome(homeDir: string): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await mkdir(join(homeDir, "memory"), { recursive: true });
  await mkdir(join(homeDir, "media", "received"), { recursive: true });

  for (const template of TEMPLATE_FILES) {
    const destination = join(homeDir, template.relativePath);

    if (existsSync(destination)) {
      continue;
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, template.content, "utf-8");
  }
}
