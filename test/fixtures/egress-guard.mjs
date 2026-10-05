import { appendFileSync } from "node:fs";
import net from "node:net";

const log = process.env.EGRESS_LOG;

const targetOf = (args) => {
  for (const arg of args.flat()) {
    if (arg && typeof arg === "object" && ("host" in arg || "path" in arg || "port" in arg)) return String(arg.host ?? arg.path ?? "localhost");
    if (typeof arg === "string") return arg;
  }
  return "unknown";
};

net.Socket.prototype.connect = function (...args) {
  const target = targetOf(args);
  if (log) appendFileSync(log, `${target}\n`);
  process.nextTick(() => this.destroy(Object.assign(new Error(`egress blocked: ${target}`), { code: "ECONNREFUSED" })));
  return this;
};
