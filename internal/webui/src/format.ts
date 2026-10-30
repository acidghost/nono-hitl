// Pure text helpers. Every value from a request is untrusted and only ever rendered as text.
import type { Advice, Approval, CommandRequest, SessionGrant, SessionRecord } from "./types";

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

export function commandRequest(approval: Approval | undefined): Partial<CommandRequest> {
  return approval?.envelope?.request ?? {};
}

export function commandTitle(approval: Approval | undefined): string {
  const request = commandRequest(approval);
  const args = Array.isArray(request.args) ? request.args : [];
  return safeInline([request.command, ...args.slice(1, 3)].join(" "), 100) || "Command request";
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
export function rulePath(request: Partial<CommandRequest>): string {
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
