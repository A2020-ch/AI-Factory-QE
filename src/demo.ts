import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ConsoleHumanGateNotifier,
  DemoRepositoryAdapter,
  SingleAgentFactoryActivities,
  bindFactoryActivities,
} from "./agents/factoryActivities.js";
import { createCopilotSingleAgent } from "./agents/singleAgent.js";
import type { HumanDecisionValue } from "./shared/contracts.js";
import {
  factoryWorkflow,
  getFactoryStatus,
  submitHumanDecision,
} from "./workflows/factoryWorkflow.js";

async function askForDecision(): Promise<HumanDecisionValue> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await terminal.question("Decision [approve/reject]: "))
        .trim()
        .toLowerCase();
      if (answer === "approve") {
        return "APPROVE";
      }
      if (answer === "reject") {
        return "REJECT";
      }
      console.info("Enter approve or reject.");
    }
  } finally {
    terminal.close();
  }
}

async function runDemo(): Promise<void> {
  const agent = createCopilotSingleAgent();
  let environment: TestWorkflowEnvironment | undefined;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;

  try {
    await agent.verifyAuthentication();
    environment = await TestWorkflowEnvironment.createLocal();
    const repository = new DemoRepositoryAdapter();
    const activities = new SingleAgentFactoryActivities(
      agent,
      repository,
      new ConsoleHumanGateNotifier(),
    );
    const taskQueue = `factory-demo-${randomUUID()}`;
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: resolve("dist/workflows/index.js"),
      activities: bindFactoryActivities(activities),
    });
    workerRun = worker.run();
    const requestId = randomUUID();
    const handle = await environment.client.workflow.start(factoryWorkflow, {
      args: [
        {
          requestId,
          source: {
            kind: "user-story",
            content:
              "As a visitor, I want the home page to load so that I can begin using the application.",
          },
          repositoryUrl: "https://example.invalid/demo.git",
          projectContext: "Isolated in-memory demonstration; no real repository is accessed.",
        },
      ],
      workflowId: `factory-demo-${requestId}`,
      taskQueue,
    });

    let handledGateId: string | undefined;
    while (true) {
      const status = await handle.query(getFactoryStatus);
      if (status.pendingGate && status.pendingGate.gateId !== handledGateId) {
        handledGateId = status.pendingGate.gateId;
        console.info(`\n${status.pendingGate.description}`);
        if (status.pendingGate.kind === "ARTIFACT" && status.artifact) {
          console.info(`\n--- ${status.artifact.filename} ---\n${status.artifact.content}`);
        }
        await handle.signal(submitHumanDecision, {
          gateId: status.pendingGate.gateId,
          decision: await askForDecision(),
        });
      }

      if (
        status.stage === "COMPLETED" ||
        status.stage === "REJECTED" ||
        status.stage === "NEEDS_HUMAN_INTERVENTION"
      ) {
        const result = await handle.result();
        console.info("\nDemo result:", JSON.stringify(result, null, 2));
        if (result.stage === "NEEDS_HUMAN_INTERVENTION") {
          process.exitCode = 2;
        }
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  } finally {
    if (worker) {
      worker.shutdown();
    }
    if (workerRun) {
      await workerRun;
    }
    await agent.close();
    if (environment) {
      await environment.teardown();
    }
  }
}

runDemo().catch((error: unknown) => {
  console.error("Factory demo failed:", error);
  process.exitCode = 1;
});
