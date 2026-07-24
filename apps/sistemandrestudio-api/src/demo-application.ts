import {
  EditorialWorkflowService,
  createApprovedWorkflowFixture,
} from "../../../packages/application/src/index.ts";
import { InMemoryEditorialNewsRepository } from "../../../packages/content-engine/src/index.ts";

const fixture = createApprovedWorkflowFixture("application-demo");
const repository = new InMemoryEditorialNewsRepository();
const service = new EditorialWorkflowService(repository);

console.log("sistemandrestudio — serviço de aplicação em memória");

const received = await service.execute(fixture.receive);
console.log(
  `${received.previousState ?? "NEW"} -> ${received.newState} | ` +
    `${fixture.receive.command.type}`,
);

for (const envelope of fixture.commands) {
  const result = await service.execute(envelope);
  console.log(
    `${result.previousState ?? "NEW"} -> ${result.newState} | ` +
      `${envelope.command.type} | v${result.currentVersion}`,
  );
}

const completed = await repository.getById(fixture.receive.newsId);
console.log("\nResultado:");
console.log(`Estado final: ${completed.state}`);
console.log(`Eventos: ${completed.auditEvents.length}`);
console.log(`Versão atual: ${completed.currentDraftVersionId ?? "nenhuma"}`);
