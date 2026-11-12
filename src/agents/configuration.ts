import type { ChangeSizePolicy, HumanGateNotifier, RepositoryAdapter } from "./factoryActivities.js";
import {
  ConsoleHumanGateNotifier,
  DemoRepositoryAdapter,
  DemoSingleAgent,
  SingleAgentFactoryActivities,
} from "./factoryActivities.js";
import { createCopilotSingleAgent } from "./singleAgent.js";
import type { DemoSingleAgent as DemoAgent } from "./factoryActivities.js";

export function createCopilotFactoryActivities(
  repository: RepositoryAdapter,
  notifier: HumanGateNotifier,
  sizePolicy?: ChangeSizePolicy,
): SingleAgentFactoryActivities {
  return new SingleAgentFactoryActivities(
    createCopilotSingleAgent(),
    repository,
    notifier,
    sizePolicy,
  );
}

export function createDemoFactoryActivities(
  sizePolicy?: ChangeSizePolicy,
): {
  activities: SingleAgentFactoryActivities;
  repository: DemoRepositoryAdapter;
  agent: DemoAgent;
} {
  const repository = new DemoRepositoryAdapter();
  const agent = new DemoSingleAgent();
  const activities = new SingleAgentFactoryActivities(
    agent,
    repository,
    new ConsoleHumanGateNotifier(),
    sizePolicy,
  );
  return { activities, repository, agent };
}
