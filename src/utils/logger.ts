// 轻量分级日志：环形缓冲 + 控制台镜像，支持按级别导出（前端日志可与 Rust 日志合并导出）。
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: number; // epoch ms
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const MAX_ENTRIES = 500;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function safeStringify(v: unknown) {
  if (typeof v === "string") return v;
  return JSON.stringify(
    v,
    (_k, val) =>
      val instanceof Error
        ? { name: val.name, message: val.message, stack: val.stack }
        : val,
    2
  );
}

class Logger {
  private buffer: LogEntry[] = [];
  private level: LogLevel = "info";

  setLevel(level: LogLevel) {
    this.level = level;
  }
  getLevel(): LogLevel {
    return this.level;
  }

  private log(level: LogLevel, message: string, source = "app", data?: unknown) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const entry: LogEntry = {
      t: Date.now(),
      level,
      source,
      message,
      ...(data !== undefined ? { data } : {}),
    };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_ENTRIES) {
      this.buffer.splice(0, this.buffer.length - MAX_ENTRIES);
    }
    this.mirror(entry);
  }

  debug(message: string, source?: string, data?: unknown) {
    this.log("debug", message, source, data);
  }
  info(message: string, source?: string, data?: unknown) {
    this.log("info", message, source, data);
  }
  warn(message: string, source?: string, data?: unknown) {
    this.log("warn", message, source, data);
  }
  error(message: string, source?: string, data?: unknown) {
    this.log("error", message, source, data);
  }

  entries(minLevel?: LogLevel): LogEntry[] {
    if (!minLevel) return [...this.buffer];
    const w = LEVEL_WEIGHT[minLevel];
    return this.buffer.filter((e) => LEVEL_WEIGHT[e.level] >= w);
  }

  clear() {
    this.buffer = [];
  }

  toJSON(minLevel?: LogLevel) {
    return JSON.stringify(
      {
        app: "TickGold",
        generatedAt: new Date().toISOString(),
        logs: this.entries(minLevel),
      },
      null,
      2
    );
  }

  toText(minLevel?: LogLevel) {
    const lines = this.entries(minLevel).map((e) => {
      const d = new Date(e.t);
      const ts = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
        d.getSeconds()
      )}.${String(d.getMilliseconds()).padStart(3, "0")}`;
      let line = `[${ts}] [${e.level.toUpperCase().padEnd(5)}] [${e.source}] ${e.message}`;
      if (e.data !== undefined) {
        try {
          line += "\n    " + safeStringify(e.data);
        } catch {
          /* ignore */
        }
      }
      return line;
    });
    return `# TickGold 前端日志\n# 导出时间: ${new Date().toISOString()}\n\n${lines.join(
      "\n"
    )}\n`;
  }

  private mirror(e: LogEntry) {
    const style = {
      debug: "color:#8b94a6",
      info: "color:#5db8ff",
      warn: "color:#f0a23a;font-weight:bold",
      error: "color:#ff5d6b;font-weight:bold",
    }[e.level];
    const fn = {
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
    }[e.level];
    if (e.data !== undefined) fn(`%c[${e.source}]`, style, e.message, e.data);
    else fn(`%c[${e.source}]`, style, e.message);
  }
}

export const logger = new Logger();
