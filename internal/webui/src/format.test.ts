import { describe, expect, test } from "bun:test";
import {
  clip,
  configError,
  countdown,
  displayArg,
  displayArgs,
  duration,
  hostPort,
  hostWarning,
  prefixTokens,
  requestTitle,
  riskComparison,
  rulePath,
  safeInline,
  sessionLabel,
  sessionWhere,
  stateLabel,
  truncate,
  verdict,
} from "./format";
import type { Advice, Approval } from "./types";

describe("safeInline", () => {
  test("control characters become spaces", () => {
    expect(safeInline("a\u0007b\u001bc\nd\u007fe", 80)).toBe("a b c d e");
  });

  test("trims and accepts missing values", () => {
    expect(safeInline("\t padded \r\n", 80)).toBe("padded");
    expect(safeInline(undefined, 80)).toBe("");
    expect(safeInline(null, 80)).toBe("");
  });
});

describe("truncate", () => {
  test("counts code points, not UTF-16 units", () => {
    expect(truncate("😀😀😀", 3)).toBe("😀😀😀");
    expect(truncate("😀😀😀", 2)).toBe("😀…");
  });

  test("leaves short text alone", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
  });
});

describe("displayArg", () => {
  test("leaves the safe set bare", () => {
    expect(displayArg("--fill")).toBe("--fill");
    expect(displayArg("user@host:/tmp/a_b.c#x=1+2")).toBe("user@host:/tmp/a_b.c#x=1+2");
  });

  test("quotes anything outside the safe set", () => {
    expect(displayArg("")).toBe('""');
    expect(displayArg("two words")).toBe('"two words"');
    expect(displayArg("$(id)")).toBe('"$(id)"');
    expect(displayArg("<img src=x onerror=alert(1)>")).toBe('"<img src=x onerror=alert(1)>"');
    expect(displayArg("bell\u0007")).toBe('"bell\\u0007"');
    expect(displayArg("é")).toBe('"é"');
  });

  test("joins an argv and tolerates a missing one", () => {
    expect(displayArgs(["git", "commit", "-m", "a b"])).toBe('git commit -m "a b"');
    expect(displayArgs(undefined)).toBe("");
  });
});

describe("clip", () => {
  test("keeps text up to the limit", () => {
    expect(clip("x".repeat(120))).toEqual({ head: "x".repeat(120), hidden: 0 });
  });

  test("says how many code points it left out", () => {
    expect(clip(`${"😀".repeat(5)}abc`, 5)).toEqual({ head: `${"😀".repeat(5)}…`, hidden: 3 });
  });
});

test("duration rounds up to whole seconds", () => {
  expect(duration(0)).toBe("0s");
  expect(duration(1)).toBe("1s");
  expect(duration(59_001)).toBe("1m 0s");
  expect(duration(61_000)).toBe("1m 1s");
  expect(duration(-5)).toBe("0s");
  expect(duration(Number.NaN)).toBe("—");
});

test("countdown drains from created to deadline", () => {
  const created = "2026-10-29T10:00:00Z";
  const deadline = "2026-10-29T10:01:00Z";
  const at = (time: string) => Date.parse(time);
  expect(countdown(created, deadline, at(created))).toEqual({
    remaining: 60_000,
    left: 1,
    urgent: false,
  });
  expect(countdown(created, deadline, at("2026-10-29T10:00:55Z"))).toEqual({
    remaining: 5_000,
    left: 5_000 / 60_000,
    urgent: true,
  });
  expect(countdown(created, deadline, at("2026-10-29T10:02:00Z")).left).toBe(0);
  expect(countdown(created, "garbage", at(created)).left).toBe(0);
});

test("stateLabel falls back for unknown states", () => {
  expect(stateLabel("granted")).toBe("Approved");
  expect(stateLabel("other")).toBe("Resolved");
  expect(stateLabel(undefined)).toBe("Resolved");
});

test("rulePath expands invocation policy labels", () => {
  const request = { command: "gh", caller: "session" };
  expect(rulePath({ ...request, intercept_rule: "invocation_policy.default" })).toBe(
    "commands.gh.from.session.invocation_policy.default",
  );
  expect(rulePath({ ...request, intercept_rule: "custom.rule" })).toBe("custom.rule");
});

test("requestTitle shows the command and two arguments", () => {
  const approval = {
    envelope: { request: { command: "gh", args: ["gh", "pr", "create", "--fill"] } },
  } as Approval;
  expect(requestTitle(approval)).toBe("gh pr create");
  expect(requestTitle(undefined)).toBe("Command request");
});

test("sessions read from the record when there is one", () => {
  const record = { name: "brave-otter", command: ["/usr/local/bin/claude"], workdir: "/src" };
  expect(sessionLabel("id-1", record)).toBe("brave-otter");
  expect(sessionLabel("id-1", undefined)).toBe("id-1");
  expect(sessionLabel("", undefined)).toBe("unknown session");
  expect(sessionWhere(record)).toBe("claude in /src");
  expect(sessionWhere(undefined)).toBe("");
});

describe("verdict", () => {
  const advice: Advice = { model: "d3", ask: "Is this risky?", max_risk: 0.3, mode: "advise" };

  test("passes at or below max_risk", () => {
    expect(verdict({ ...advice, risk: 0.3 })).toBe("safe");
    expect(verdict({ ...advice, risk: 0.3001 })).toBe("risky");
    expect(riskComparison({ ...advice, risk: 0.3 })).toBe("0.300 ≤ 0.300");
    expect(riskComparison({ ...advice, risk: 0.3004 })).toBe("0.300 > 0.300");
    expect(riskComparison({ ...advice, risk: 0.91 })).toBe("0.910 > 0.300");
  });

  test("waits for an answer and reports failures", () => {
    expect(verdict(advice)).toBe("classifying");
    expect(riskComparison(advice)).toBe("");
    expect(verdict({ ...advice, error: "connection refused" })).toBe("unavailable");
  });
});

test("prefixes split on any run of whitespace", () => {
  expect(prefixTokens("  docker\trun \n --privileged ")).toEqual(["docker", "run", "--privileged"]);
  expect(prefixTokens("   ")).toEqual([]);
});

test("config errors number classifiers like the form", () => {
  expect(configError("classifiers[0]: model is required")).toBe("Classifier 1: model is required");
  expect(configError("at most 64 classifiers are allowed")).toBe(
    "at most 64 classifiers are allowed",
  );
});

describe("network requests", () => {
  const network = (host: string, port = 443) => ({ capability_type: "network", host, port });

  test("hostPort brackets IPv6 literals", () => {
    expect(hostPort(network("api.example.com"))).toBe("api.example.com:443");
    expect(hostPort(network("::1", 8080))).toBe("[::1]:8080");
    expect(hostPort(network("[::1]", 8080))).toBe("[::1]:8080");
  });

  test("requestTitle is host:port", () => {
    const approval = { envelope: { request: network("example.com", 80) } } as unknown as Approval;
    expect(requestTitle(approval)).toBe("example.com:80");
  });

  test("hostWarning flags this machine and private networks", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "app.localhost",
      "127.0.0.1",
      "127.8.9.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "127.1",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "::1",
      "[::1]",
      "::",
      "::ffff:127.0.0.1",
      "fd12:3456::1",
      "fe80::1",
    ]) {
      expect(hostWarning(host), host).not.toBe("");
    }
  });

  test("hostWarning leaves public hosts alone", () => {
    for (const host of [
      "example.com",
      "localhost.example.com",
      "cafe.de",
      "8.8.8.8",
      "172.32.0.1",
      "2001:db8::1",
    ]) {
      expect(hostWarning(host), host).toBe("");
    }
  });
});
