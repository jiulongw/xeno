declare module "*.md" {
  const content: string;
  export default content;
}

declare module "../template/.claude/settings.local.json" {
  const content: string;
  export default content;
}
