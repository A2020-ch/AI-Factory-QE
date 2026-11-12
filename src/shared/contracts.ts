export type FactoryInput =
  | {
      requestId: string;
      source: { kind: "user-story"; content: string };
      repositoryUrl: string;
      projectContext?: string;
      baseBranch?: string;
    }
  | {
      requestId: string;
      source: { kind: "openapi"; content: string };
      repositoryUrl: string;
      projectContext?: string;
      baseBranch?: string;
    };

export type SpecificationKind = "ODD" | "SDD";
export type ChangeSize = "SMALL" | "LARGE";
export type HumanDecisionValue = "APPROVE" | "REJECT";
export type ReviewerId = "SECURITY_SOL" | "UX_SOL" | "UI_ASTRA" | "CODE_SONNET";
export type QualityReviewer = ReviewerId | "APPROVER";

export interface GeneratedArtifact {
  kind: SpecificationKind;
  filename: string;
  content: string;
  rationale: string;
}

export interface ClassificationResult {
  artifact: GeneratedArtifact;
}

export interface BuildResult {
  workspaceId: string;
  branchName: string;
  changedFiles: string[];
  changedLines: number;
  diffSummary: string;
}

export interface RepositoryContext {
  workspaceId: string;
  structureSummary: string;
}

export interface QualityFinding {
  reviewer: QualityReviewer;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  summary: string;
  file?: string;
  line?: number;
}

export interface ReviewerResult {
  reviewer: ReviewerId;
  passed: boolean;
  findings: QualityFinding[];
}

export interface ApproverResult {
  passed: boolean;
  findings: QualityFinding[];
}

export interface ChangeAssessment {
  size: ChangeSize;
  rationale: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
}

export type WorkflowStage =
  | "CLASSIFYING"
  | "AWAITING_ARTIFACT_REVIEW"
  | "INDEXING_REPOSITORY"
  | "BUILDING"
  | "REVIEWING"
  | "ASSESSING_CHANGE"
  | "DEPLOYING"
  | "AWAITING_PULL_REQUEST_REVIEW"
  | "COMPLETED"
  | "REJECTED"
  | "NEEDS_HUMAN_INTERVENTION";

export interface PendingHumanGate {
  gateId: string;
  kind: "ARTIFACT" | "PULL_REQUEST";
  description: string;
}

export interface FactoryWorkflowStatus {
  requestId: string;
  stage: WorkflowStage;
  artifact?: GeneratedArtifact;
  build?: BuildResult;
  changeAssessment?: ChangeAssessment;
  pullRequest?: PullRequestResult;
  pendingGate?: PendingHumanGate;
  findings?: QualityFinding[];
  message?: string;
}

export interface HumanDecision {
  gateId: string;
  decision: HumanDecisionValue;
  comment?: string;
}

export interface FactoryActivities {
  close?(): Promise<void>;
  notifyHumanGate(input: {
    requestId: string;
    gate: PendingHumanGate;
  }): Promise<void>;
  classifyAndDraft(input: FactoryInput): Promise<ClassificationResult>;
  prepareRepository(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
  }): Promise<RepositoryContext>;
  buildAutomation(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
  }): Promise<BuildResult>;
  correctAutomation(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
    findings: QualityFinding[];
    correctionAttempt: number;
  }): Promise<BuildResult>;
  reviewCode(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
    reviewer: ReviewerId;
  }): Promise<ReviewerResult>;
  approveRelease(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
    reviews: ReviewerResult[];
  }): Promise<ApproverResult>;
  assessChangeSize(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    repository: RepositoryContext;
    build: BuildResult;
  }): Promise<ChangeAssessment>;
  mergeToMain(input: {
    request: FactoryInput;
    build: BuildResult;
  }): Promise<void>;
  createPullRequest(input: {
    request: FactoryInput;
    artifact: GeneratedArtifact;
    build: BuildResult;
    assessment: ChangeAssessment;
  }): Promise<PullRequestResult>;
}
