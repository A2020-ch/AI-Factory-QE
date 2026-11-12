import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type {
  ApproverResult,
  BuildResult,
  FactoryActivities,
  FactoryInput,
  FactoryWorkflowStatus,
  GeneratedArtifact,
  HumanDecision,
  PendingHumanGate,
  QualityFinding,
  ReviewerId,
  ReviewerResult,
} from "../shared/contracts.js";

const MAX_CORRECTION_ATTEMPTS = 3;
const REVIEWERS: ReviewerId[] = [
  "SECURITY_SOL",
  "UX_SOL",
  "UI_ASTRA",
  "CODE_SONNET",
];

const {
  notifyHumanGate,
  classifyAndDraft,
  prepareRepository,
  buildAutomation,
  correctAutomation,
  reviewCode,
  approveRelease,
  assessChangeSize,
  mergeToMain,
  createPullRequest,
} = proxyActivities<FactoryActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

export const submitHumanDecision = defineSignal<[HumanDecision]>("submitHumanDecision");
export const getFactoryStatus = defineQuery<FactoryWorkflowStatus>("getFactoryStatus");

function validateArtifact(artifact: GeneratedArtifact): void {
  const filename = artifact.filename.toLowerCase();
  const hasExpectedExtension =
    artifact.kind === "ODD"
      ? filename.endsWith(".md")
      : filename.endsWith(".yaml") || filename.endsWith(".yml");

  if (!hasExpectedExtension || artifact.content.trim().length === 0) {
    throw new Error(
      `Invalid ${artifact.kind} artifact: expected non-empty ${
        artifact.kind === "ODD" ? ".md" : ".yaml/.yml"
      } content.`,
    );
  }
}

function collectFailedReviews(reviews: ReviewerResult[]): QualityFinding[] {
  return reviews
    .filter((review) => !review.passed)
    .flatMap((review) => review.findings);
}

function collectFailedApproval(approval: ApproverResult): QualityFinding[] {
  return approval.passed
    ? []
    : approval.findings.length > 0
      ? approval.findings
      : [
          {
            reviewer: "APPROVER",
            severity: "HIGH",
            summary: "Approver rejected the release without providing findings.",
          },
        ];
}

export async function factoryWorkflow(
  request: FactoryInput,
): Promise<FactoryWorkflowStatus> {
  let status: FactoryWorkflowStatus = {
    requestId: request.requestId,
    stage: "CLASSIFYING",
  };
  let activeGateId: string | undefined;
  let receivedDecision: HumanDecision | undefined;

  setHandler(getFactoryStatus, () => status);
  setHandler(submitHumanDecision, (decision) => {
    if (decision.gateId === activeGateId) {
      receivedDecision = decision;
    }
  });

  const openHumanGate = async (
    gate: PendingHumanGate,
  ): Promise<HumanDecision> => {
    activeGateId = gate.gateId;
    receivedDecision = undefined;
    status = { ...status, pendingGate: gate };
    await notifyHumanGate({ requestId: request.requestId, gate });
    await condition(() => receivedDecision !== undefined);
    const decision = receivedDecision;
    activeGateId = undefined;
    receivedDecision = undefined;
    const { pendingGate: _pendingGate, ...statusWithoutGate } = status;
    status = statusWithoutGate;
    if (!decision) {
      throw new Error(`Human decision was not received for gate ${gate.gateId}.`);
    }
    return decision;
  };

  const classification = await classifyAndDraft(request);
  const extension = classification.artifact.kind === "ODD" ? "md" : "yaml";
  const artifact: GeneratedArtifact = {
    ...classification.artifact,
    filename: `.factory/specs/${encodeURIComponent(request.requestId)}.${extension}`,
  };
  validateArtifact(artifact);
  status = {
    ...status,
    stage: "AWAITING_ARTIFACT_REVIEW",
    artifact,
  };

  const artifactDecision = await openHumanGate({
    gateId: `${request.requestId}:artifact`,
    kind: "ARTIFACT",
    description: `Review ${artifact.kind} artifact. If approved, it will be saved as ${artifact.filename} after repository indexing.`,
  });

  if (artifactDecision.decision === "REJECT") {
    status = {
      ...status,
      stage: "REJECTED",
      message: artifactDecision.comment ?? "Generated artifact was rejected.",
    };
    return status;
  }

  status = { ...status, stage: "INDEXING_REPOSITORY" };
  const repository = await prepareRepository({ request, artifact });
  status = { ...status, stage: "BUILDING" };
  let build = await buildAutomation({ request, artifact, repository });
  let finalReviews: ReviewerResult[] = [];

  for (let correctionAttempt = 0; ; correctionAttempt += 1) {
    const { findings: _previousFindings, ...statusWithoutPreviousFindings } = status;
    status = {
      ...statusWithoutPreviousFindings,
      stage: "REVIEWING",
      build,
    };
    const reviews = await Promise.all(
      REVIEWERS.map((reviewer) =>
        reviewCode({ request, artifact, repository, build, reviewer }),
      ),
    );
    const reviewFindings = collectFailedReviews(reviews);

    if (reviewFindings.length > 0) {
      if (correctionAttempt >= MAX_CORRECTION_ATTEMPTS) {
        status = {
          ...status,
          stage: "NEEDS_HUMAN_INTERVENTION",
          findings: reviewFindings,
          message: `Review failed after ${MAX_CORRECTION_ATTEMPTS} correction attempts.`,
        };
        return status;
      }

      status = { ...status, stage: "BUILDING", findings: reviewFindings };
      build = await correctAutomation({
        request,
        artifact,
        repository,
        build,
        findings: reviewFindings,
        correctionAttempt: correctionAttempt + 1,
      });
      continue;
    }

    const approval = await approveRelease({
      request,
      artifact,
      repository,
      build,
      reviews,
    });
    const approvalFindings = collectFailedApproval(approval);
    if (approvalFindings.length > 0) {
      if (correctionAttempt >= MAX_CORRECTION_ATTEMPTS) {
        status = {
          ...status,
          stage: "NEEDS_HUMAN_INTERVENTION",
          findings: approvalFindings,
          message: `Approver rejected the release after ${MAX_CORRECTION_ATTEMPTS} correction attempts.`,
        };
        return status;
      }

      status = { ...status, stage: "BUILDING", findings: approvalFindings };
      build = await correctAutomation({
        request,
        artifact,
        repository,
        build,
        findings: approvalFindings,
        correctionAttempt: correctionAttempt + 1,
      });
      continue;
    }

    finalReviews = reviews;
    break;
  }

  status = { ...status, stage: "ASSESSING_CHANGE", build };
  const assessment = await assessChangeSize({
    request,
    artifact,
    repository,
    build,
  });
  status = {
    ...status,
    changeAssessment: assessment,
    stage: "DEPLOYING",
  };

  if (assessment.size === "SMALL") {
    await mergeToMain({ request, build });
    status = {
      ...status,
      stage: "COMPLETED",
      message: `Small change merged to main after ${finalReviews.length} reviewer approvals.`,
    };
    return status;
  }

  const pullRequest = await createPullRequest({
    request,
    artifact,
    build,
    assessment,
  });
  status = {
    ...status,
    pullRequest,
    stage: "AWAITING_PULL_REQUEST_REVIEW",
  };

  const pullRequestDecision = await openHumanGate({
    gateId: `${request.requestId}:pull-request`,
    kind: "PULL_REQUEST",
    description: `Review pull request #${pullRequest.number}: ${pullRequest.url}`,
  });

  status = {
    ...status,
    stage: pullRequestDecision.decision === "APPROVE" ? "COMPLETED" : "REJECTED",
    message:
      pullRequestDecision.comment ??
      (pullRequestDecision.decision === "APPROVE"
        ? "Pull request approved; merge remains a human/GitHub action."
        : "Pull request was rejected and remains unmerged."),
  };
  return status;
}
