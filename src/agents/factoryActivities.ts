import type {
  ApproverResult,
  BuildResult,
  ChangeAssessment,
  FactoryActivities,
  FactoryInput,
  GeneratedArtifact,
  PendingHumanGate,
  QualityFinding,
  RepositoryContext,
  ReviewerId,
  ReviewerResult,
} from "../shared/contracts.js";
import type { AgentRequest, SingleAgent } from "./agentTypes.js";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface RepositoryAdapter {
  prepare(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
  }): Promise<RepositoryContext>;
  applyGeneratedFiles(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    files: GeneratedFile[];
  }): Promise<BuildResult>;
  readDiff(input: {
    repository: RepositoryContext;
    build: BuildResult;
  }): Promise<string>;
  mergeToMain(input: {
    request: FactoryInput;
    build: BuildResult;
  }): Promise<void>;
  createPullRequest(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    build: BuildResult;
    assessment: ChangeAssessment;
  }): Promise<{ url: string; number: number }>;
}

export interface HumanGateNotifier {
  notify(input: { requestId: string; gate: PendingHumanGate }): Promise<void>;
}

export interface ChangeSizePolicy {
  maxFilesForSmall: number;
  maxChangedLinesForSmall: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAgentJson(text: string, operation: string): Record<string, unknown> {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(withoutFence);
  } catch {
    throw new Error(`The shared agent returned invalid JSON for ${operation}.`);
  }
  if (!isRecord(value)) {
    throw new Error(`The shared agent returned a non-object response for ${operation}.`);
  }
  return value;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  operation: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`The shared agent omitted "${key}" for ${operation}.`);
  }
  return field;
}

function readArtifact(value: unknown): GeneratedArtifact {
  if (!isRecord(value)) {
    throw new Error("The shared agent returned an invalid artifact.");
  }
  const kind = value.kind;
  if (kind !== "ODD" && kind !== "SDD") {
    throw new Error('The shared agent artifact kind must be "ODD" or "SDD".');
  }
  return {
    kind,
    filename: requiredString(value, "filename", "classification"),
    content: requiredString(value, "content", "classification"),
    rationale: requiredString(value, "rationale", "classification"),
  };
}

function readGeneratedFiles(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("The shared agent must return at least one generated file.");
  }
  return value.map((file, index) => {
    if (!isRecord(file)) {
      throw new Error(`Generated file at index ${index} is invalid.`);
    }
    return {
      path: requiredString(file, "path", "code generation"),
      content: requiredString(file, "content", "code generation"),
    };
  });
}

function readFindings(value: unknown, reviewer: ReviewerId | "APPROVER"): QualityFinding[] {
  if (!Array.isArray(value)) {
    throw new Error("The shared agent findings value must be an array.");
  }
  return value.map((finding, index) => {
    if (!isRecord(finding)) {
      throw new Error(`Finding at index ${index} is invalid.`);
    }
    const severity = finding.severity;
    if (
      severity !== "LOW" &&
      severity !== "MEDIUM" &&
      severity !== "HIGH" &&
      severity !== "CRITICAL"
    ) {
      throw new Error(`Finding at index ${index} has an invalid severity.`);
    }
    const result: QualityFinding = {
      reviewer,
      severity,
      summary: requiredString(finding, "summary", "review"),
    };
    if (typeof finding.file === "string") {
      result.file = finding.file;
    }
    if (typeof finding.line === "number" && Number.isInteger(finding.line)) {
      result.line = finding.line;
    }
    return result;
  });
}

function readPassed(value: Record<string, unknown>, operation: string): boolean {
  if (typeof value.passed !== "boolean") {
    throw new Error(`The shared agent omitted a boolean "passed" for ${operation}.`);
  }
  return value.passed;
}

function jsonRequest(
  task: AgentRequest["task"],
  persona: string,
  context: unknown,
  outputContract: string,
): AgentRequest {
  return { task, persona, context, outputContract };
}

const REVIEW_PERSONAS: Record<ReviewerId, string> = {
  SECURITY_SOL:
    "Sol / security reviewer. Look only for concrete security risks in the generated automation and diff; do not make network requests or execute code.",
  UX_SOL:
    "Sol / UX reviewer. Review whether the generated test scenario reflects the user journey and produces useful failure diagnostics.",
  UI_ASTRA:
    "Astra / UI reviewer. Review selectors, accessibility semantics, synchronization, and UI test stability when applicable.",
  CODE_SONNET:
    "Sonnet / code reviewer. Review correctness, maintainability, typing, and fit with the indexed repository structure.",
};

export function bindFactoryActivities(activities: FactoryActivities): FactoryActivities {
  return {
    ...(activities.close ? { close: activities.close.bind(activities) } : {}),
    notifyHumanGate: activities.notifyHumanGate.bind(activities),
    classifyAndDraft: activities.classifyAndDraft.bind(activities),
    prepareRepository: activities.prepareRepository.bind(activities),
    buildAutomation: activities.buildAutomation.bind(activities),
    correctAutomation: activities.correctAutomation.bind(activities),
    reviewCode: activities.reviewCode.bind(activities),
    approveRelease: activities.approveRelease.bind(activities),
    assessChangeSize: activities.assessChangeSize.bind(activities),
    mergeToMain: activities.mergeToMain.bind(activities),
    createPullRequest: activities.createPullRequest.bind(activities),
  };
}

export class SingleAgentFactoryActivities implements FactoryActivities {
  constructor(
    private readonly agent: SingleAgent,
    private readonly repositoryAdapter: RepositoryAdapter,
    private readonly notifier: HumanGateNotifier,
    private readonly sizePolicy: ChangeSizePolicy = {
      maxFilesForSmall: 5,
      maxChangedLinesForSmall: 200,
    },
  ) {
    if (
      !Number.isInteger(sizePolicy.maxFilesForSmall) ||
      sizePolicy.maxFilesForSmall < 1 ||
      !Number.isInteger(sizePolicy.maxChangedLinesForSmall) ||
      sizePolicy.maxChangedLinesForSmall < 1
    ) {
      throw new Error("Change-size thresholds must be positive integers.");
    }
  }

  async close(): Promise<void> {
    await this.agent.close?.();
  }

  notifyHumanGate(input: {
    requestId: string;
    gate: PendingHumanGate;
  }): Promise<void> {
    return this.notifier.notify(input);
  }

  async classifyAndDraft(
    request: FactoryInput,
  ): Promise<{ artifact: GeneratedArtifact }> {
    const response = await this.agent.complete(
      jsonRequest(
        "CLASSIFY",
        "Brain and Orchestrator. Classify a bounded, lightweight change as ODD and produce a Markdown task. Classify a multi-step, cross-cutting, API-contract, or otherwise complex change as SDD and produce a YAML specification. OpenAPI input follows SDD. Describe requirements only; do not generate repository code at this stage.",
        {
          request,
          classificationRules: {
            odd: "A small, well-bounded change with clear acceptance criteria; output .md.",
            sdd: "A complex, multi-step, cross-cutting, or contract-driven change; output .yaml or .yml.",
            openApi: "Always SDD.",
          },
        },
        '{"artifact":{"kind":"ODD"|"SDD","filename":"...md|...yaml","content":"...","rationale":"..."}}',
      ),
    );
    const value = parseAgentJson(response, "classification");
    const artifact = readArtifact(value.artifact);
    const lowerFilename = artifact.filename.toLowerCase();
    const validExtension =
      artifact.kind === "ODD"
        ? lowerFilename.endsWith(".md")
        : lowerFilename.endsWith(".yaml") || lowerFilename.endsWith(".yml");
    if (!validExtension) {
      throw new Error(`The ${artifact.kind} artifact has the wrong file extension.`);
    }
    return { artifact };
  }

  prepareRepository(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
  }): Promise<RepositoryContext> {
    return this.repositoryAdapter.prepare(input);
  }

  async buildAutomation(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
  }): Promise<BuildResult> {
    const response = await this.agent.complete(
      jsonRequest(
        "BUILD",
        "Builder. Generate API automation in Karate DSL for OpenAPI input, or Web automation in Playwright TypeScript for user-story input. Follow the indexed repository conventions and return complete repository-relative file contents; do not execute tests or other generated code.",
        {
          request: input.request,
          artifact: input.artifact,
          repositoryStructure: input.repository.structureSummary,
        },
        '{"files":[{"path":"repository-relative/path","content":"complete file content"}]}',
      ),
    );
    const generated = readGeneratedFiles(
      parseAgentJson(response, "code generation").files,
    );
    return this.applyFilesWithApprovedArtifact(input, generated);
  }

  async correctAutomation(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
    findings: QualityFinding[];
    correctionAttempt: number;
  }): Promise<BuildResult> {
    const currentDiff = await this.repositoryAdapter.readDiff({
      repository: input.repository,
      build: input.build,
    });
    const response = await this.agent.complete(
      jsonRequest(
        "CORRECT",
        "Builder. Correct the existing Karate DSL or Playwright TypeScript files using the review findings. Preserve repository conventions and return complete repository-relative file contents; do not execute generated code.",
        {
          request: input.request,
          artifact: input.artifact,
          repositoryStructure: input.repository.structureSummary,
          currentDiff,
          findings: input.findings,
          correctionAttempt: input.correctionAttempt,
        },
        '{"files":[{"path":"repository-relative/path","content":"complete corrected file content"}]}',
      ),
    );
    const generated = readGeneratedFiles(
      parseAgentJson(response, "correction").files,
    );
    return this.applyFilesWithApprovedArtifact(input, generated);
  }

  private applyFilesWithApprovedArtifact(
    input: {
      request: FactoryInput;
      artifact: GeneratedArtifact;
      repository: RepositoryContext;
    },
    generatedFiles: GeneratedFile[],
  ): Promise<BuildResult> {
    const specificationPath = input.artifact.filename.replaceAll("\\", "/");
    if (
      specificationPath.startsWith("/") ||
      /^[A-Za-z]:/.test(specificationPath) ||
      specificationPath.split("/").includes("..")
    ) {
      throw new Error("The approved specification path must be repository-relative.");
    }
    if (
      generatedFiles.some(
        (file) => file.path.replaceAll("\\", "/") === specificationPath,
      )
    ) {
      throw new Error("Generated automation must not overwrite the approved specification.");
    }
    return this.repositoryAdapter.applyGeneratedFiles({
      ...input,
      files: [
        { path: specificationPath, content: input.artifact.content },
        ...generatedFiles,
      ],
    });
  }

  async reviewCode(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
    reviewer: ReviewerId;
  }): Promise<ReviewerResult> {
    const diff = await this.repositoryAdapter.readDiff({
      repository: input.repository,
      build: input.build,
    });
    const response = await this.agent.complete(
      jsonRequest(
        "REVIEW",
        REVIEW_PERSONAS[input.reviewer],
        {
          request: input.request,
          artifact: input.artifact,
          repositoryStructure: input.repository.structureSummary,
          diff,
        },
        '{"passed":boolean,"findings":[{"severity":"LOW|MEDIUM|HIGH|CRITICAL","summary":"...","file":"optional","line":1}]}',
      ),
    );
    const value = parseAgentJson(response, `${input.reviewer} review`);
    const findings = readFindings(value.findings, input.reviewer);
    const passed = readPassed(value, `${input.reviewer} review`);
    if (passed && findings.length > 0) {
      throw new Error(`${input.reviewer} cannot pass while reporting findings.`);
    }
    if (!passed && findings.length === 0) {
      throw new Error(`${input.reviewer} failed without actionable findings.`);
    }
    return { reviewer: input.reviewer, passed, findings };
  }

  async approveRelease(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
    reviews: ReviewerResult[];
  }): Promise<ApproverResult> {
    const diff = await this.repositoryAdapter.readDiff({
      repository: input.repository,
      build: input.build,
    });
    const response = await this.agent.complete(
      jsonRequest(
        "APPROVE",
        "Approver",
        {
          request: input.request,
          artifact: input.artifact,
          repositoryStructure: input.repository.structureSummary,
          diff,
          reviews: input.reviews,
        },
        '{"passed":boolean,"findings":[{"severity":"LOW|MEDIUM|HIGH|CRITICAL","summary":"...","file":"optional","line":1}]}',
      ),
    );
    const value = parseAgentJson(response, "release approval");
    const findings = readFindings(value.findings, "APPROVER");
    const passed = readPassed(value, "release approval");
    if (passed && findings.length > 0) {
      throw new Error("Approver cannot pass while reporting findings.");
    }
    return { passed, findings };
  }

  assessChangeSize(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
  }): Promise<ChangeAssessment> {
    if (
      !Number.isInteger(input.build.changedLines) ||
      input.build.changedLines < 0 ||
      input.build.changedFiles.length === 0
    ) {
      throw new Error("Cannot assess change size from invalid build metrics.");
    }
    const isSmall =
      input.build.changedFiles.length <= this.sizePolicy.maxFilesForSmall &&
      input.build.changedLines <= this.sizePolicy.maxChangedLinesForSmall;
    return Promise.resolve({
      size: isSmall ? "SMALL" : "LARGE",
      rationale: `Deterministic policy: ${input.build.changedFiles.length} file(s), ${input.build.changedLines} changed line(s); SMALL thresholds are at most ${this.sizePolicy.maxFilesForSmall} files and ${this.sizePolicy.maxChangedLinesForSmall} changed lines.`,
    });
  }

  mergeToMain(input: {
    request: FactoryInput;
    build: BuildResult;
  }): Promise<void> {
    return this.repositoryAdapter.mergeToMain(input);
  }

  createPullRequest(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    build: BuildResult;
    assessment: ChangeAssessment;
  }): Promise<{ url: string; number: number }> {
    return this.repositoryAdapter.createPullRequest(input);
  }
}

export class DemoSingleAgent implements SingleAgent {
  readonly calls: AgentRequest[] = [];

  async complete(request: AgentRequest): Promise<string> {
    this.calls.push(request);
    switch (request.task) {
      case "CLASSIFY": {
        const isApi = sourceKindFromContext(request.context) === "openapi";
        const artifact: GeneratedArtifact = isApi
          ? {
              kind: "SDD",
              filename: "specs/generated-api.yaml",
              content: "kind: api-test\nsource: openapi\nscenarios:\n  - name: generated smoke scenario\n",
              rationale: "OpenAPI input follows the structured SDD path.",
            }
          : {
              kind: "ODD",
              filename: "specs/generated-task.md",
              content: "# Generated task\n\n- Add a focused Playwright acceptance test.\n",
              rationale: "A lightweight user-story input follows the ODD path.",
            };
        return JSON.stringify({ artifact });
      }
      case "BUILD":
      case "CORRECT": {
        const isApi = sourceKindFromContext(request.context) === "openapi";
        return JSON.stringify({
          files: [
            {
              path: isApi
                ? "src/test/resources/features/generated/factory-smoke.feature"
                : "tests/generated/factory-smoke.spec.ts",
              content: isApi
                ? "Feature: Generated API smoke test\n\n  Scenario: API responds to a smoke request\n    Given url baseUrl\n    And path 'health'\n    When method get\n    Then status 200\n"
                : "import { test, expect } from '@playwright/test';\n\ntest('factory generated smoke scenario', async ({ page }) => {\n  await page.goto('/');\n  await expect(page).toHaveURL(/.*/);\n});\n",
            },
          ],
        });
      }
      case "REVIEW":
      case "APPROVE":
        return JSON.stringify({ passed: true, findings: [] });
    }
  }
}

function sourceKindFromContext(
  context: unknown,
): FactoryInput["source"]["kind"] | undefined {
  if (!isRecord(context)) {
    return undefined;
  }
  const request = isRecord(context.request) ? context.request : context;
  if (!isRecord(request) || !isRecord(request.source)) {
    return undefined;
  }
  return request.source.kind === "openapi" || request.source.kind === "user-story"
    ? request.source.kind
    : undefined;
}

export class DemoRepositoryAdapter implements RepositoryAdapter {
  private readonly diffs = new Map<string, string>();
  private readonly preparedWorkspaces = new Set<string>();
  private readonly mergedWorkspaces = new Set<string>();
  private nextPullRequestNumber = 1;

  async prepare(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
  }): Promise<RepositoryContext> {
    const workspaceId = `demo-${input.request.requestId}`;
    this.preparedWorkspaces.add(workspaceId);
    return {
      workspaceId,
      structureSummary:
        "Demo-only in-memory repository. Existing test root: tests/. No repository was cloned or modified.",
    };
  }

  async applyGeneratedFiles(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    files: GeneratedFile[];
  }): Promise<BuildResult> {
    const safeFiles = input.files.map((file) => {
      const normalizedPath = file.path.replaceAll("\\", "/");
      if (
        normalizedPath.startsWith("/") ||
        /^[A-Za-z]:/.test(normalizedPath) ||
        normalizedPath.split("/").includes("..")
      ) {
        throw new Error(`Generated path escapes the repository: ${file.path}`);
      }
      return { path: normalizedPath, content: file.content };
    });
    const diff = safeFiles
      .map((file) => `--- a/${file.path}\n+++ b/${file.path}\n${file.content}`)
      .join("\n");
    this.diffs.set(input.repository.workspaceId, diff);
    return {
      workspaceId: input.repository.workspaceId,
      branchName: `factory/${input.request.requestId}`,
      changedFiles: safeFiles.map((file) => file.path),
      changedLines: safeFiles.reduce(
        (total, file) => total + file.content.split(/\r?\n/).length,
        0,
      ),
      diffSummary: `Demo generated ${safeFiles.length} file(s) in an in-memory repository.`,
    };
  }

  async readDiff(input: {
    repository: RepositoryContext;
    build: BuildResult;
  }): Promise<string> {
    const diff = this.diffs.get(input.repository.workspaceId);
    if (!diff) {
      throw new Error(`No demo diff exists for ${input.repository.workspaceId}.`);
    }
    return diff;
  }

  async mergeToMain(input: {
    request: FactoryInput;
    build: BuildResult;
  }): Promise<void> {
    this.mergedWorkspaces.add(input.build.workspaceId);
  }

  async createPullRequest(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    build: BuildResult;
    assessment: ChangeAssessment;
  }): Promise<{ url: string; number: number }> {
    const number = this.nextPullRequestNumber++;
    return {
      url: `https://example.invalid/demo/pull/${number}`,
      number,
    };
  }

  wasMerged(workspaceId: string): boolean {
    return this.mergedWorkspaces.has(workspaceId);
  }

  wasPrepared(workspaceId: string): boolean {
    return this.preparedWorkspaces.has(workspaceId);
  }
}

export class ConsoleHumanGateNotifier implements HumanGateNotifier {
  async notify(input: {
    requestId: string;
    gate: PendingHumanGate;
  }): Promise<void> {
    console.info(
      `[human-gate] ${input.requestId} ${input.gate.gateId}: ${input.gate.description}`,
    );
  }
}
