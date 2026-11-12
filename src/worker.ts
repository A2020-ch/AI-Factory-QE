import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import type { FactoryActivities } from "./shared/contracts.js";
import { bindFactoryActivities } from "./agents/factoryActivities.js";

export async function runFactoryWorker(
  activities: FactoryActivities,
  options: {
    address?: string;
    namespace?: string;
    taskQueue?: string;
  } = {},
): Promise<void> {
  const connection = await NativeConnection.connect({
    address: options.address ?? "localhost:7233",
  });

  try {
    const worker = await Worker.create({
      connection,
      namespace: options.namespace ?? "default",
      taskQueue: options.taskQueue ?? "hybrid-ai-factory",
      workflowsPath: fileURLToPath(new URL("./workflows/index.js", import.meta.url)),
      activities: bindFactoryActivities(activities),
    });
    await worker.run();
  } finally {
    try {
      await activities.close?.();
    } finally {
      await connection.close();
    }
  }
}
