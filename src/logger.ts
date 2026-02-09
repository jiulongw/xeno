import pino from "pino";

export const logger = pino({
  name: "xeno",
  level: process.env.LOG_LEVEL ?? "info",
});
