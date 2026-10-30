import { spawn } from "node:child_process";
import { access, constants, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test as base, expect, type Page } from "@playwright/test";

export { expect };

// The webhook response: all nono learns about a decision.
export type Decision = { decision: "granted" | "denied"; reason?: string };

export type Submitted = { id: string; decision: Promise<Decision> };

type RequestFields = { sessionID?: string; reason?: string };

// nono's record of a session, as nono ps --json prints it.
type SessionRecord = {
  name: string;
  command: string[];
  profile: string;
  workdir: string;
  started: string;
  status: string;
};

type Approval = { envelope: { request: { request_id: string } } };

type Server = { url: string; stateDir: string };

type Hitl = {
  // Posts a webhook and returns once the server knows the request, without waiting for the decision.
  submit(args: string[], fields?: RequestFields): Promise<Submitted>;
  pendingIDs(): Promise<string[]>;
  decide(
    id: string,
    decision: Decision["decision"],
    reason: string,
    scope?: "once" | "session",
  ): Promise<void>;
  addSession(id: string, record: SessionRecord): Promise<void>;
};

export type Dashboard = ReturnType<typeof dashboard>;

declare global {
  interface Window {
    reportViolation(message: string): void;
  }
}

const basePort = 18765;

export const dockerAsk = "Is this docker command dangerous or risky?";

export const test = base.extend<{
  decisionTimeout: string;
  server: Server;
  hitl: Hitl;
  ui: Dashboard;
  pageErrors: undefined;
}>({
  decisionTimeout: ["20s", { option: true }],

  server: async ({ decisionTimeout }, use, testInfo) => {
    const binary = process.env.NONO_HITL_BIN ?? "";
    await access(binary, constants.X_OK).catch(() => {
      throw new Error(`NONO_HITL_BIN=${binary} is not an executable; run the suite with just e2e`);
    });
    const stateDir = await mkdtemp(join(tmpdir(), "nono-hitl-e2e-"));
    const ollama = await fakeOllama();
    const config = join(stateDir, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        ollama_url: ollama.url,
        classifiers: [
          { prefix: ["docker"], ask: dockerAsk, model: "d3", max_risk: 0.3, mode: "advise" },
        ],
      }),
    );
    // A server per test keeps queues, history and grants apart. Tests running at the same
    // time have distinct parallel indexes.
    const address = `127.0.0.1:${basePort + testInfo.parallelIndex}`;
    const child = spawn(
      binary,
      [
        "serve",
        "--listen",
        address,
        "--decision-timeout",
        decisionTimeout,
        "--nono-state-dir",
        stateDir,
        "--config",
        config,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let output = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      output += error.message;
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const url = `http://${address}`;

    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready && child.exitCode === null; attempt++) {
      ready = await fetch(`${url}/readyz`).then(
        (response) => response.ok,
        () => false,
      );
      if (!ready) await sleep(100);
    }
    if (!ready) {
      child.kill();
      await ollama.close();
      throw new Error(`nono-hitl did not start on ${address}:\n${output}`);
    }

    await use({ url, stateDir });
    child.kill("SIGTERM");
    await exited;
    await ollama.close();
    await rm(stateDir, { recursive: true, force: true });
  },

  baseURL: async ({ server }, use) => {
    await use(server.url);
  },

  hitl: async ({ request, server }, use) => {
    let sequence = 0;
    const requestIDs = (approvals: Approval[]) =>
      approvals.map((approval) => approval.envelope.request.request_id);
    const snapshot = async (): Promise<{ pending: Approval[]; recent: Approval[] }> =>
      (await request.get("/api/v1/approvals")).json();

    await use({
      async submit(args, fields = {}) {
        sequence++;
        const id = `e2e-${sequence}`;
        const decision = request
          .post("/hooks/nono", { data: webhook(id, args, fields) })
          .then(async (response): Promise<Decision> => {
            expect(response.status()).toBe(200);
            return response.json();
          });
        // Tests await it later. One that fails first leaves it to reject at teardown.
        decision.catch(() => {});
        // Known means waiting, or already released by a session approval.
        await expect
          .poll(async () => {
            const { pending, recent } = await snapshot();
            return [...requestIDs(pending), ...requestIDs(recent)];
          })
          .toContain(id);
        return { id, decision };
      },

      async pendingIDs() {
        return requestIDs((await snapshot()).pending);
      },

      async decide(id, decision, reason, scope = "once") {
        const response = await request.post(`/api/v1/approvals/${id}/decision`, {
          headers: { Origin: server.url },
          data: { decision, reason, scope },
        });
        expect(response.ok()).toBe(true);
      },

      async addSession(id, record) {
        const sessions = join(server.stateDir, "sessions");
        await mkdir(sessions, { recursive: true });
        await writeFile(join(sessions, `${id}.json`), JSON.stringify(record));
      },
    });
  },

  ui: async ({ page }, use) => {
    await use(dashboard(page));
  },

  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.exposeFunction("reportViolation", (message: string) => errors.push(message));
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          window.reportViolation(`CSP ${event.violatedDirective} blocked ${event.blockedURI}`);
        });
      });
      await use(undefined);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

// Ollama's /v1/systemone, answering by the docker subcommand: ps looks safe, run looks risky,
// pull fails, and build never answers.
async function fakeOllama() {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const subcommand = JSON.parse(body).state.args[1];
      if (subcommand === "build") return;
      response.setHeader("Content-Type", "application/json");
      if (subcommand === "pull") {
        response.writeHead(404).end(JSON.stringify({ error: "model 'd3' not found" }));
        return;
      }
      const noul = subcommand === "run" ? 0.91 : 0.02;
      response.end(JSON.stringify({ model: "d3", answers: { risk: { type: "noul", noul } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function webhook(id: string, args: string[], fields: RequestFields) {
  return {
    backend: "nono-hitl",
    request: {
      capability_type: "command",
      request_id: id,
      command: args[0],
      args,
      caller: "session",
      intercept_rule: "invocation_policy.default",
      reason: fields.reason ?? null,
      child_pid: 4242,
      session_id: fields.sessionID ?? "e2e-session",
    },
  };
}

// Selectors live here so markup changes touch one file.
function dashboard(page: Page) {
  // Ends with Deny, so "Deny with note" stays out.
  const deny = page.getByRole("button", { name: /Deny$/ });
  const selected = (id: string) =>
    page.locator(`.queue-item[aria-pressed="true"][data-request-id="${id}"]`);

  // The card shows the request and its decision buttons are enabled.
  async function shown(id: string) {
    await expect(selected(id)).toBeVisible();
    await expect(deny).toBeEnabled();
  }

  return {
    card: page.locator("#sheet"),
    chips: page.locator("#command code"),
    approve: page.getByRole("button", { name: "Approve once" }),
    approveSession: page.getByRole("button", { name: "Approve for session" }),
    deny,
    denyWithNote: page.getByRole("button", { name: /Deny with note$/ }),
    note: page.getByRole("textbox", { name: "Note for the agent" }),
    toast: page.locator("#toast"),
    advice: page.locator("#advice"),
    offline: page.locator("#offline-banner"),
    filter: page.getByRole("searchbox"),
    help: page.getByRole("dialog", { name: "Help" }),
    queue: page.locator(".queue-item"),
    grants: page.locator(".grant-row"),
    history: page.locator(".history-row"),
    classifier: (number: number) =>
      page.getByRole("group", { name: `Classifier ${number}`, exact: true }),
    addClassifier: page.getByRole("button", { name: "Add classifier" }),
    saveConfig: page.getByRole("button", { name: "Save" }),
    configStatus: page.locator("#config-status"),

    async open() {
      await page.goto("/");
      await expect(page.locator("#connection")).toHaveAttribute("data-state", "online");
    },

    shown,

    // As shown, and the approve buttons are done arming.
    async armed(id: string) {
      await shown(id);
      await expect(page.locator(".actions.arming")).toHaveCount(0);
    },
  };
}
