// Pure text helpers. Every value from a request is untrusted and only ever rendered as text.
import type { Advice, Approval, Request, SessionGrant, SessionRecord } from "./types";

export const clipLength = 120;

export function timestamp(value: unknown): number {
  return Date.parse(String(value ?? ""));
}

// Counts code points, so a cut never splits a surrogate pair.
export function truncate(value: string, maximum: number): string {
  const characters = Array.from(value);
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

export function safeInline(value: unknown, maximum: number): string {
  const sanitized = Array.from(String(value ?? ""), (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
  }).join("");
  return truncate(sanitized.trim(), maximum);
}

// Display only: these tokens are reported argv, never executable shell text.
export function displayArg(arg: string): string {
  return /^[a-zA-Z0-9_./:@#=+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function displayArgs(args: unknown): string {
  return (Array.isArray(args) ? args : []).map(displayArg).join(" ");
}

// Long arguments are clipped, never hidden: hidden says how much is left out.
export function clip(text: string, length = clipLength): { head: string; hidden: number } {
  const characters = Array.from(text);
  if (characters.length <= length) return { head: text, hidden: 0 };
  return { head: `${characters.slice(0, length).join("")}…`, hidden: characters.length - length };
}

export function duration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

// The bar drains with left, the clock counts down remaining, and the last ten seconds are urgent.
export function countdown(created: unknown, deadline: unknown, now: number) {
  const end = timestamp(deadline);
  const remaining = Math.max(0, end - now);
  const total = end - timestamp(created);
  const left = total > 0 ? Math.min(1, remaining / total) : 0;
  return { remaining, left, urgent: remaining <= 10000 };
}

export function shortTime(value: unknown): string {
  const parsed = timestamp(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
}

export function fullTime(value: unknown): string {
  const parsed = timestamp(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "—";
}

const stateLabels: Record<string, string> = {
  pending: "Waiting",
  granted: "Approved",
  denied: "Denied",
  expired: "Expired",
  canceled: "Canceled",
};

export function stateLabel(state: string | undefined): string {
  return stateLabels[state ?? ""] ?? "Resolved";
}

export function requestID(approval: Approval | undefined): string {
  return String(approval?.envelope?.request?.request_id ?? "");
}

export function requestOf(approval: Approval | undefined): Partial<Request> {
  return approval?.envelope?.request ?? {};
}

export function isNetwork(request: Partial<Request>): boolean {
  return request.capability_type === "network";
}

export function kindLabel(request: Partial<Request>): string {
  return isNetwork(request) ? "net" : "cmd";
}

// IPv6 literals get brackets, so the port can't be read as part of the address.
export function hostPort(request: Partial<Request>): string {
  const host = String(request.host ?? "");
  const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return safeInline(`${shown}:${request.port ?? ""}`, 270);
}

export function requestTitle(approval: Approval | undefined): string {
  const request = requestOf(approval);
  if (isNetwork(request)) return hostPort(request);
  const args = Array.isArray(request.args) ? request.args : [];
  return safeInline([request.command, ...args.slice(1, 3)].join(" "), 100) || "Command request";
}

// The one line a list row shows: argv for commands, host:port for connections.
export function requestSummary(request: Partial<Request>): string {
  return isNetwork(request) ? hostPort(request) : displayArgs(request.args);
}

const localNames = /^(localhost|.*\.localhost)$/;
// Each number in decimal, octal or hex, as the resolver reads them.
const numericHost = /^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}$/;

// Says why approving a connection to host reaches this machine or a private network, or "" when
// nothing in the name says so. A name that resolves to such an address still looks fine here:
// nono doesn't report the addresses it resolved.
export function hostWarning(value: unknown): string {
  const host = String(value ?? "")
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (localNames.test(host)) return "This is a name for this machine.";
  if (numericHost.test(host)) return ipv4Warning(host);
  if (host.includes(":")) return ipv6Warning(host);
  return "";
}

function ipv4Warning(host: string): string {
  const parts = host.split(".");
  // 127.1, 0x7f.0.0.1 and 2130706433 all reach 127.0.0.1.
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))) {
    return "This is an unusual way to write an IP address. It may point at this machine.";
  }
  const [a, b] = parts.map(Number);
  if (a === 127) return "This address is this machine.";
  if (a === 0) return "This address can reach this machine.";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "This address is on a private network.";
  }
  if (a === 169 && b === 254) return "This address is link-local.";
  return "";
}

function ipv6Warning(host: string): string {
  if (host === "::1" || host === "::") return "This address is this machine.";
  const mapped = host.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return ipv4Warning(mapped[1]);
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return "This address is on a private network.";
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return "This address is link-local.";
  return "";
}

// record is nono's session record, when the service could read it.
export function sessionLabel(sessionID: unknown, record: SessionRecord | undefined): string {
  return safeInline(record?.name, 40) || safeInline(sessionID, 40) || "unknown session";
}

export function sessionWhere(record: SessionRecord | undefined): string {
  const program = Array.isArray(record?.command) ? String(record.command[0] ?? "") : "";
  const agent = safeInline(program.split("/").pop(), 40);
  const workdir = safeInline(record?.workdir, 200);
  return agent && workdir ? `${agent} in ${workdir}` : agent || workdir;
}

// nono reports invocation policy labels relative to the caller's profile entry.
export function rulePath(request: Partial<Request>): string {
  const rule = String(request.intercept_rule ?? "");
  if (!rule.startsWith("invocation_policy.")) return rule;
  return `commands.${request.command}.from.${request.caller}.${rule}`;
}

export function grantID(grant: SessionGrant): string {
  return String(grant.id ?? "");
}

export function grantUsage(grant: SessionGrant): string {
  const uses = Number(grant.uses) || 0;
  if (uses === 0) return "unused";
  const times = uses === 1 ? "once" : `${uses} times`;
  return `used ${times}, last ${shortTime(grant.last_used_at)}`;
}

export type Verdict = "classifying" | "safe" | "risky" | "unavailable";

export const verdictLabels: Record<Verdict, string> = {
  classifying: "Classifying…",
  safe: "Looks safe",
  risky: "Looks risky",
  unavailable: "Unavailable",
};

// A request passes when the model gives the ask a risk of at most max_risk.
export function verdict(advice: Advice): Verdict {
  if (advice.error) return "unavailable";
  if (typeof advice.risk !== "number") return "classifying";
  return advice.risk <= advice.max_risk ? "safe" : "risky";
}

// The relation compares exact values, so a risk of 0.3004 reads 0.300 > 0.300.
export function riskComparison(advice: Advice): string {
  if (typeof advice.risk !== "number") return "";
  const relation = advice.risk <= advice.max_risk ? "≤" : ">";
  return `${advice.risk.toFixed(3)} ${relation} ${Number(advice.max_risk).toFixed(3)}`;
}

// The server refuses prefix tokens holding spaces, so splitting on them never changes a saved
// entry.
export function prefixTokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// The server counts classifiers from zero, the form from one.
export function configError(message: string): string {
  return message.replace(/classifiers\[(\d+)\]/, (_, index) => `Classifier ${Number(index) + 1}`);
}
