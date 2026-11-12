import assert from "node:assert/strict";
import test from "node:test";
import { CopilotSingleAgent } from "../dist/agents/singleAgent.js";

test("Copilot adapter sends a prompt-only task and cleans up its session", async () => {
  const observed = { startCount: 0, config: undefined, prompt: undefined, deleted: [] };
  const agent = new CopilotSingleAgent(
    {
      async start() {
        observed.startCount += 1;
      },
      async getAuthStatus() {
        return { isAuthenticated: true };
      },
      async createSession(config) {
        observed.config = config;
        return {
          sessionId: "test-session",
          async sendAndWait(prompt) {
            observed.prompt = prompt;
            return { data: { content: '{"passed":true}' } };
          },
        };
      },
      async deleteSession(sessionId) {
        observed.deleted.push(sessionId);
      },
      async stop() {
        return [];
      },
    },
    "temp-copilot-home",
    "test-model",
  );

  const response = await agent.complete({
    task: "REVIEW",
    persona: "Code reviewer",
    context: { diff: "test diff" },
    outputContract: '{"passed":boolean}',
  });

  assert.equal(response, '{"passed":true}');
  assert.equal(observed.startCount, 1);
  assert.equal(observed.config.model, "test-model");
  assert.deepEqual(observed.config.availableTools, []);
  assert.match(observed.config.systemMessage.content, /Code reviewer/);
  assert.equal(JSON.parse(observed.prompt).task, "REVIEW");
  assert.deepEqual(observed.deleted, ["test-session"]);
  await agent.close();
});

test("Copilot adapter reports an empty response and deletes the session", async () => {
  const deleted = [];
  const agent = new CopilotSingleAgent(
    {
      async start() {},
      async getAuthStatus() {
        return { isAuthenticated: true };
      },
      async createSession() {
        return {
          sessionId: "empty-session",
          async sendAndWait() {
            return undefined;
          },
        };
      },
      async deleteSession(sessionId) {
        deleted.push(sessionId);
      },
      async stop() {
        return [];
      },
    },
    "temp-copilot-home",
  );

  await assert.rejects(
    agent.complete({
      task: "CLASSIFY",
      persona: "Orchestrator",
      context: {},
      outputContract: "{}",
    }),
    /Copilot returned no text/,
  );
  assert.deepEqual(deleted, ["empty-session"]);
});
