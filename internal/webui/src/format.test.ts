import { describe, expect, test } from "bun:test";
import {
  clip,
  commandTitle,
  countdown,
  displayArg,
  displayArgs,
  duration,
  rulePath,
  safeInline,
  sessionLabel,
  sessionWhere,
  stateLabel,
  truncate,
} from "./format";
import type { Approval } from "./types";

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

test("commandTitle shows the command and two arguments", () => {
  const approval = {
    envelope: { request: { command: "gh", args: ["gh", "pr", "create", "--fill"] } },
  } as Approval;
  expect(commandTitle(approval)).toBe("gh pr create");
  expect(commandTitle(undefined)).toBe("Command request");
});

test("sessions read from the record when there is one", () => {
  const record = { name: "brave-otter", command: ["/usr/local/bin/claude"], workdir: "/src" };
  expect(sessionLabel("id-1", record)).toBe("brave-otter");
  expect(sessionLabel("id-1", undefined)).toBe("id-1");
  expect(sessionLabel("", undefined)).toBe("unknown session");
  expect(sessionWhere(record)).toBe("claude in /src");
  expect(sessionWhere(undefined)).toBe("");
});
