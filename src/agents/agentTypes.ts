export type AgentTask = "CLASSIFY" | "BUILD" | "CORRECT" | "REVIEW" | "APPROVE";

export interface AgentRequest {
  task: AgentTask;
  persona: string;
  context: unknown;
  outputContract: string;
}

export interface SingleAgent {
  complete(request: AgentRequest): Promise<string>;
  close?(): Promise<void>;
}
