// Payloads of the approval and config APIs, mirroring internal/approval, internal/session,
// internal/classifier and internal/config by hand.

export type ApprovalState = "pending" | "granted" | "denied" | "expired" | "canceled";

export type SessionRecord = {
  name?: string;
  command?: string[];
  profile?: string;
  workdir?: string;
  started?: string;
  status?: string;
};

export type CommandRequest = {
  capability_type: string;
  request_id: string;
  command: string;
  args: string[];
  caller: string;
  intercept_rule: string;
  reason: string | null;
  child_pid: number;
  session_id: string;
};

export type WebhookEnvelope = {
  backend: string;
  request: CommandRequest;
};

export type Resolution = {
  state: ApprovalState;
  scope?: string;
  reason?: string;
  resolved_at: string;
};

// A decision model's answer to a classifier's ask. risk and error are both unset while it
// answers.
export type Advice = {
  model: string;
  ask: string;
  max_risk: number;
  mode: string;
  risk?: number;
  error?: string;
};

export type Approval = {
  envelope: WebhookEnvelope;
  session?: SessionRecord;
  state: ApprovalState;
  created_at: string;
  deadline: string;
  resolution?: Resolution;
  advice?: Advice;
};

export type SessionGrant = {
  id: string;
  session_id: string;
  session?: SessionRecord;
  command: string;
  args: string[];
  caller: string;
  intercept_rule: string;
  created_at: string;
  uses: number;
  last_used_at?: string;
};

export type Snapshot = {
  pending: Approval[];
  recent: Approval[];
  grants: SessionGrant[];
};

export type Classifier = {
  prefix: string[];
  ask: string;
  model: string;
  max_risk: number;
  mode: string;
};

export type ConfigFile = {
  ollama_url: string;
  classifiers: Classifier[] | null;
};
