import {
  APPROVED_SCENARIO,
  InMemoryEditorialNewsRepository,
  transition,
} from "../../../packages/content-engine/src/index.ts";

const repository = new InMemoryEditorialNewsRepository();
repository.save(APPROVED_SCENARIO.initialNews);

console.log("sistemandrestudio — demonstração local da máquina editorial");
console.log(`Notícia: ${APPROVED_SCENARIO.initialNews.id}`);

for (const step of APPROVED_SCENARIO.steps) {
  const current = repository.getById(APPROVED_SCENARIO.initialNews.id);
  const result = transition(current, step.command, step.context);
  repository.save(result.entity);

  console.log(
    `${result.event?.occurredAt ?? step.context.occurredAt} | ` +
      `${current.state} -> ${result.entity.state} | ${step.command.type}`,
  );
}

const completed = repository.getById(APPROVED_SCENARIO.initialNews.id);
const approvedVersion = completed.draftVersions.find(
  (version) => version.id === completed.currentDraftVersionId,
);

console.log("\nHistórico de auditoria:");
for (const event of repository.listAuditEvents(completed.id)) {
  console.log(
    `- ${event.id}: ${event.previousState} -> ${event.newState} ` +
      `por ${event.actor.type}/${event.actor.id}`,
  );
}

console.log("\nResultado:");
console.log(`Estado final: ${completed.state}`);
console.log(
  `Versão aprovada: ${approvedVersion?.id ?? "não encontrada"} ` +
    `(v${approvedVersion?.version ?? "?"})`,
);
console.log(`Conteúdo: ${approvedVersion?.body ?? "não encontrado"}`);

