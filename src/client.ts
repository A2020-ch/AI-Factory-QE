import { Client } from "@temporalio/client";
import type {
  FactoryInput,
  FactoryWorkflowStatus,
  HumanDecision,
} from "./shared/contracts.js";
import {
  factoryWorkflow,
  getFactoryStatus,
  submitHumanDecision,
} from "./workflows/factoryWorkflow.js";

export async function startFactoryRun(
  client: Client,
  request: FactoryInput,
  taskQueue = "hybrid-ai-factory",
): Promise<void> {
  await client.workflow.start(factoryWorkflow, {
    args: [request],
    workflowId: `factory-${request.requestId}`,
    taskQueue,
  });
}

export async function submitDecision(
  client: Client,
  requestId: string,
  decision: HumanDecision,
): Promise<void> {
  const handle = client.workflow.getHandle(`factory-${requestId}`);
  await handle.signal(submitHumanDecision, decision);
}

export async function readFactoryStatus(
  client: Client,
  requestId: string,
): Promise<FactoryWorkflowStatus> {
  const handle = client.workflow.getHandle(`factory-${requestId}`);
  return handle.query(getFactoryStatus);
}
