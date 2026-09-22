import pino from "pino";
import type { AppConfig } from "./types.js";

export function createLogger(config: AppConfig) {
  const level = (process.env.LOG_LEVEL ?? config.logging.level) as pino.Level;

  if (config.logging.pretty && process.env.NODE_ENV !== "production") {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
  }

  return pino({ level });
}

export type Logger = ReturnType<typeof createLogger>;

