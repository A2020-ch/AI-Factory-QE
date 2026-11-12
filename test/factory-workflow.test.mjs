import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bindFactoryActivities } from "../dist/agents/factoryActivities.js";
import { createDemoFactoryActivities } from "../dist/agents/configuration.js";
import {
  factoryWorkflow,
  getFactoryStatus,
  submitHumanDecision,
} from "../dist/workflows/factoryWorkflow.js";

async function waitForGate(handle, kind, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await handle.query(getFactoryStatus);
    if (status.pendingGate?.kind === kind) {
      return { status, gate: status.pendingGate };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for the ${kind} human gate.`);
}

async function startTestWorker(environment, taskQueue, activities) {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: resolve("dist/workflows/index.js"),
    activities: bindFactoryActivities(activities),
  });
  const runPromise = worker.run();
  return {
    worker,
    async stop() {
      worker.shutdown();
      await runPromise;
    },
  };
}

test("ODD path pauses before repository access, then reviews and merges SMALL in demo", async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const { activities, repository, agent } = createDemoFactoryActivities();
  const complete = agent.complete.bind(agent);
  let injectedFinding = false;
  agent.complete = async (request) => {
    if (
      request.task === "REVIEW" &&
      request.persona.startsWith("Sol / security") &&
      !injectedFinding
    ) {
      injectedFinding = true;
      agent.calls.push(request);
      return JSON.stringify({
        passed: false,
        findings: [{ severity: "MEDIUM", summary: "Demo finding for correction-loop test." }],
      });
    }
    return complete(request);
  };
  const taskQueue = "factory-odd-e2e";
  const worker = await startTestWorker(environment, taskQueue, activities);

  try {
    const request = {
      requestId: "odd-demo",
      source: { kind: "user-story", content: "As a user, I can see the home page." },
      repositoryUrl: "https://example.invalid/demo.git",
    };
    const handle = await environment.client.workflow.start(factoryWorkflow, {
      args: [request],
      workflowId: "factory-odd-demo",
      taskQueue,
    });

    const artifactGate = await waitForGate(handle, "ARTIFACT");
    assert.equal(artifactGate.status.artifact.kind, "ODD");
    assert.match(artifactGate.status.artifact.filename, /\.md$/);
    assert.equal(repository.wasPrepared("demo-odd-demo"), false);

    await handle.signal(submitHumanDecision, {
      gateId: artifactGate.gate.gateId,
      decision: "APPROVE",
    });
    const result = await handle.result();

    assert.equal(result.stage, "COMPLETED");
    assert.equal(result.changeAssessment.size, "SMALL");
    assert.ok(
      result.build.changedFiles.includes(".factory/specs/odd-demo.md"),
      "approved ODD artifact should be committed alongside generated automation",
    );
    assert.match(
      await repository.readDiff({
        repository: { workspaceId: "demo-odd-demo", structureSummary: "" },
        build: result.build,
      }),
      /# Generated task/,
    );
    assert.equal(repository.wasPrepared("demo-odd-demo"), true);
    assert.equal(repository.wasMerged("demo-odd-demo"), true);
    assert.equal(agent.calls.filter((call) => call.task === "REVIEW").length, 8);
    assert.equal(agent.calls.filter((call) => call.task === "CORRECT").length, 1);
    assert.equal(agent.calls.filter((call) => call.task === "CLASSIFY").length, 1);
    assert.equal(agent.calls.filter((call) => call.task === "BUILD").length, 1);
    assert.equal(agent.calls.filter((call) => call.task === "APPROVE").length, 1);
    assert.equal(injectedFinding, true);
    assert.deepEqual(
      agent.calls
        .filter((call) => call.task === "REVIEW")
        .map((call) => call.persona)
        .filter((persona) => persona.startsWith("Sol / security")).length,
      2,
    );
    assert.deepEqual(
      new Set(
        agent.calls
          .filter((call) => call.task === "REVIEW")
          .map((call) => call.persona.split(".")[0]),
      ).size,
      4,
    );
  } finally {
    await worker.stop();
    await environment.teardown();
  }
});

test("SDD LARGE path pauses for artifact and PR approvals without merging the PR", async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const { activities, repository, agent } = createDemoFactoryActivities({
    maxFilesForSmall: 1,
    maxChangedLinesForSmall: 1,
  });
  const taskQueue = "factory-sdd-e2e";
  const worker = await startTestWorker(environment, taskQueue, activities);

  try {
    const request = {
      requestId: "sdd-demo",
      source: { kind: "openapi", content: "openapi: 3.0.0\npaths: {}" },
      repositoryUrl: "https://example.invalid/demo.git",
      projectContext: "Demo API",
    };
    const handle = await environment.client.workflow.start(factoryWorkflow, {
      args: [request],
      workflowId: "factory-sdd-demo",
      taskQueue,
    });

    const artifactGate = await waitForGate(handle, "ARTIFACT");
    assert.equal(artifactGate.status.artifact.kind, "SDD");
    assert.match(artifactGate.status.artifact.filename, /\.ya?ml$/);
    await handle.signal(submitHumanDecision, {
      gateId: artifactGate.gate.gateId,
      decision: "APPROVE",
    });

    const pullRequestGate = await waitForGate(handle, "PULL_REQUEST");
    assert.equal(repository.wasMerged("demo-sdd-demo"), false);
    await handle.signal(submitHumanDecision, {
      gateId: pullRequestGate.gate.gateId,
      decision: "APPROVE",
    });

    const result = await handle.result();
    assert.equal(result.stage, "COMPLETED");
    assert.equal(result.changeAssessment.size, "LARGE");
    assert.ok(
      result.build.changedFiles.includes(".factory/specs/sdd-demo.yaml"),
      "approved SDD artifact should be committed alongside generated automation",
    );
    assert.match(
      await repository.readDiff({
        repository: { workspaceId: "demo-sdd-demo", structureSummary: "" },
        build: result.build,
      }),
      /kind: api-test/,
    );
    assert.equal(result.pullRequest.number, 1);
    assert.equal(repository.wasMerged("demo-sdd-demo"), false);
    assert.equal(agent.calls.filter((call) => call.task === "REVIEW").length, 4);
  } finally {
    await worker.stop();
    await environment.teardown();
  }
});
