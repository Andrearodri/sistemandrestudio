import {
  EditorialOrchestrationService,
  FixtureEditorialOrchestrationPipeline,
  InMemoryEditorialOrchestrationRepository,
  InMemoryHumanDecisionChannel,
  InMemoryHumanEditorialDecisionExecutor,
} from "../../../packages/application/src/index.ts";

const at = "2026-07-29T11:00:00.000Z";
const repository = new InMemoryEditorialOrchestrationRepository();
const channel = new InMemoryHumanDecisionChannel(() => at);
const executor = new InMemoryHumanEditorialDecisionExecutor();
const service = new EditorialOrchestrationService({
  repository,
  pipeline: new FixtureEditorialOrchestrationPipeline(),
  channel,
  decisionExecutor: executor,
  clock: () => at,
});

const trigger = {
  triggerType: "MANUAL" as const,
  triggerKey: "editorial-run:2026-07-29:demo",
  triggeredBy: "demo-local",
};
const started = await service.startScheduledRun(trigger);
const pending = await service.getPendingHumanDecisions();
const request = pending[0];
if (request === undefined) throw new Error("Demo did not create a decision request.");
const decided = await service.registerHumanDecision({
  requestId: request.id,
  reviewerId: "andre-local",
  decision: "APPROVE",
  receivedAt: at,
  idempotencyKey: "demo-human-approval",
});
const completed = await service.resumeRun(started.run.id);
const eventCount = (await repository.listEvents(started.run.id)).length;
const replay = await service.startScheduledRun(trigger);
const eventCountAfterReplay = (await repository.listEvents(started.run.id)).length;

process.stdout.write(`${JSON.stringify({
  demo: "editorial-orchestration",
  startedStatus: started.run.status,
  requestId: request.id,
  decision: decided.decision.decision,
  finalStatus: completed.status,
  replayed: replay.replayed,
  duplicateDomainDecision: executor.executed.length !== 1,
  automaticPublication: false,
  eventCount,
  replayEventDelta: eventCountAfterReplay - eventCount,
}, null, 2)}\n`);
