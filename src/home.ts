import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import configTemplate from "../template/config.json";
import heartbeatSkill from "../template/skills/heartbeat/SKILL.md" with { type: "text" };
import runCronTaskSkill from "../template/skills/run-cron-task/SKILL.md" with { type: "text" };
import applescriptSkill from "../template/skills/applescript/SKILL.md" with { type: "text" };
import applescriptCalendarRef from "../template/skills/applescript/references/calendar.md" with { type: "text" };
import applescriptMailRef from "../template/skills/applescript/references/mail.md" with { type: "text" };
import applescriptNotesRef from "../template/skills/applescript/references/notes.md" with { type: "text" };
import applescriptRemindersRef from "../template/skills/applescript/references/reminders.md" with { type: "text" };

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
  { relativePath: ".claude/skills/applescript/SKILL.md", content: applescriptSkill },
  {
    relativePath: ".claude/skills/applescript/references/calendar.md",
    content: applescriptCalendarRef,
  },
  { relativePath: ".claude/skills/applescript/references/mail.md", content: applescriptMailRef },
  { relativePath: ".claude/skills/applescript/references/notes.md", content: applescriptNotesRef },
  {
    relativePath: ".claude/skills/applescript/references/reminders.md",
    content: applescriptRemindersRef,
  },
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

  await scaffoldConfig(homeDir);
}

async function scaffoldConfig(homeDir: string): Promise<void> {
  const configPath = join(homedir(), ".config", "xeno", "config.json");

  if (existsSync(configPath)) {
    return;
  }

  const config = { ...configTemplate, default_home: homeDir };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
