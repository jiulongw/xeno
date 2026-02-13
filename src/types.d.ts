declare module "*.md" {
  const content: string;
  export default content;
}

declare module "../template/claude.settings.json" {
  const content: string;
  export default content;
}

declare module "../template/skills/xeno-voice/scripts/*" {
  const content: string;
  export default content;
}
