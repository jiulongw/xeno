import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sanitizeChannelKey } from "./channel/types";

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
import runCronTaskSkill from "../template/skills/run-cron-task/SKILL.md" with { type: "text" };
import applescriptSkill from "../template/skills/applescript/SKILL.md" with { type: "text" };
import applescriptCalendarRef from "../template/skills/applescript/references/calendar.md" with { type: "text" };
import applescriptMailRef from "../template/skills/applescript/references/mail.md" with { type: "text" };
import applescriptNotesRef from "../template/skills/applescript/references/notes.md" with { type: "text" };
import applescriptRemindersRef from "../template/skills/applescript/references/reminders.md" with { type: "text" };
import xenoVoiceSkill from "../template/skills/xeno-voice/SKILL.md" with { type: "text" };
import xenoVoiceScript from "../template/skills/xeno-voice/scripts/xeno-voice" with { type: "text" };

type TemplateFile = {
  relativePath: string;
  content: string;
  mode?: number;
};

const CLAUDE_FILE = "CLAUDE.md";
const BOOTSTRAP_FILE = "BOOTSTRAP.md";
const SKILLS_PREFIX = ".claude/skills/";
const LEGACY_HEARTBEAT_SKILL_DIR = ".claude/skills/heartbeat";
const LEGACY_HEARTBEAT_SKILL_FILE = `${LEGACY_HEARTBEAT_SKILL_DIR}/SKILL.md`;

const TEMPLATE_FILES: TemplateFile[] = [
  { relativePath: CLAUDE_FILE, content: agentsTemplate },
  { relativePath: BOOTSTRAP_FILE, content: bootstrapTemplate },
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
  { relativePath: ".claude/skills/xeno-voice/SKILL.md", content: xenoVoiceSkill },
  {
    relativePath: ".claude/skills/xeno-voice/scripts/xeno-voice",
    content: xenoVoiceScript,
    mode: 0o755,
  },
];

function shouldOverwriteTemplate(relativePath: string): boolean {
  return relativePath === CLAUDE_FILE || relativePath.startsWith(SKILLS_PREFIX);
}

export async function createHome(homeDir: string): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await mkdir(join(homeDir, "memory"), { recursive: true });
  await mkdir(join(homeDir, "media", "received"), { recursive: true });
  await cleanupLegacyHeartbeatSkill(homeDir);
  const claudeAlreadyExists = existsSync(join(homeDir, CLAUDE_FILE));

  for (const template of TEMPLATE_FILES) {
    if (template.relativePath === BOOTSTRAP_FILE && claudeAlreadyExists) {
      continue;
    }

    const destination = join(homeDir, template.relativePath);
    const destinationExists = existsSync(destination);

    if (destinationExists && !shouldOverwriteTemplate(template.relativePath)) {
      continue;
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, template.content, "utf-8");
    if (template.mode !== undefined) {
      await chmod(destination, template.mode);
    }
  }

  await scaffoldConfig(homeDir);
}

async function cleanupLegacyHeartbeatSkill(homeDir: string): Promise<void> {
  await rm(join(homeDir, LEGACY_HEARTBEAT_SKILL_FILE), { force: true });
  const legacyHeartbeatDir = join(homeDir, LEGACY_HEARTBEAT_SKILL_DIR);

  try {
    const entries = await readdir(legacyHeartbeatDir);
    if (entries.length === 0) {
      await rmdir(legacyHeartbeatDir);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

export async function createChannelHome(
  parentHome: string,
  channelKey: string,
  channelName?: string,
): Promise<string> {
  const sanitized = sanitizeChannelKey(channelKey);
  const channelDir = join(parentHome, "channels", sanitized);
  const absoluteParent = resolve(parentHome);

  await mkdir(channelDir, { recursive: true });
  await mkdir(join(channelDir, "memory"), { recursive: true });
  await mkdir(join(channelDir, "media", "received"), { recursive: true });

  const claudeMd = generateChannelClaudeMd(absoluteParent, channelName);
  await writeFile(join(channelDir, "CLAUDE.md"), claudeMd, "utf-8");

  // Scaffold USER.md from template if it doesn't exist
  const userMdPath = join(channelDir, "USER.md");
  if (!existsSync(userMdPath)) {
    await writeFile(userMdPath, userTemplate, "utf-8");
  }

  // Always refresh skills from templates (same pattern as main home)
  const cronSkillPath = join(channelDir, ".claude", "skills", "run-cron-task", "SKILL.md");
  await mkdir(dirname(cronSkillPath), { recursive: true });
  await writeFile(cronSkillPath, runCronTaskSkill, "utf-8");

  const settingsPath = join(channelDir, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) {
    await mkdir(dirname(settingsPath), { recursive: true });
    const settings = { model: "sonnet" };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  return channelDir;
}

function generateChannelClaudeMd(parentHome: string, channelName?: string): string {
  const header = channelName ? `# Topic Channel: ${channelName}` : "# Topic Channel";
  const description = channelName
    ? `This is an isolated topic channel for: **${channelName}**. Your workspace is this directory.`
    : "This is an isolated topic channel. Your workspace is this directory.";
  return `${header}

${description}

## Every Session

Before doing anything else:
1. Read \`${parentHome}/SOUL.md\` — this is who you are
2. Read \`${parentHome}/IDENTITY.md\` — your identity
3. Read \`USER.md\` — who you're helping (local to this channel)
4. Read \`memory/YYYY-MM-DD.md\` (today + yesterday) for recent context

Do NOT read the parent directory's MEMORY.md, USER.md, or HEARTBEAT.md. Your files are local to this channel.

## Memory
- Daily notes: \`memory/YYYY-MM-DD.md\`
- This channel has its own isolated memory context

## Safety

- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- \`trash\` > \`rm\` (recoverable beats gone forever)
- When in doubt, ask.
`;
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
