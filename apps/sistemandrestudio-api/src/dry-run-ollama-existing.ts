import { EditorialDraftWorkflowService } from "../../../packages/application/src/index.ts";
import { OllamaEditorialTextGenerator } from "../../../packages/content-engine/src/index.ts";
import {
  PostgresEditorialDraftRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";

if (process.env.DRY_RUN_ORCHESTRATION !== "true" || process.env.PUBLICATION_ENABLED === "true" || process.env.MAX_ITEMS !== "1") {
  throw new Error("This command requires DRY_RUN_ORCHESTRATION=true, PUBLICATION_ENABLED=false and MAX_ITEMS=1.");
}
if (process.env.HUMAN_DECISION_CHANNEL === "TELEGRAM") throw new Error("Telegram is not permitted for this local dry run.");

const pool = createDatabasePool(loadDatabaseConfig());
try {
  await checkDatabaseConnection(pool);
  const candidate = await pool.query<{ news_id: string; verification_id: string }>(`
    SELECT news.id AS news_id, result.id AS verification_id
    FROM editorial_news news
    JOIN verification_results result ON result.news_id = news.id
    WHERE news.state = 'VERIFIED'
      AND result.status = 'CONFIRMED'
      AND (news.source->>'isOfficial')::boolean = true
      AND lower(news.source->>'id') !~ '(fixture|fictional|demo|test)'
      AND NOT EXISTS (SELECT 1 FROM editorial_drafts draft WHERE draft.news_id = news.id)
    ORDER BY result.evaluated_at DESC, result.id DESC
    LIMIT 1
  `);
  const row = candidate.rows[0];
  if (row === undefined) {
    console.log(JSON.stringify({ type: "OLLAMA_DRY_RUN", result: "NO_ELIGIBLE_EXISTING_OFFICIAL_ITEM", llmCalls: 0, publications: 0, telegramMessages: 0 }));
  } else {
    const repository = new PostgresEditorialDraftRepository(pool);
    const context = await repository.loadContext(row.news_id, row.verification_id);
    if (context === undefined) throw new Error("Eligible editorial context was not available.");
    const service = new EditorialDraftWorkflowService(repository, OllamaEditorialTextGenerator.fromEnvironment());
    const result = await service.createDraft({
      newsId: row.news_id,
      verificationId: row.verification_id,
      format: "WEBSITE_NEWS_BRIEF",
      idempotencyKey: `ollama-local-dry-run:${row.verification_id}`,
      commandId: `ollama-local-dry-run:${row.verification_id}`,
      approvalRequestId: `ollama-local-approval:${row.verification_id}`,
      expectedVersion: context.news.auditEvents.length,
      actor: { type: "SYSTEM", id: "ollama-local-dry-run" },
      occurredAt: context.verification.evaluatedAt,
    });
    console.log(JSON.stringify({ type: "OLLAMA_DRY_RUN", result: result.replayed ? "REPLAY" : "CREATED", validation: result.draft.validationStatus, state: result.currentState, generator: result.draft.generatorId, citations: result.draft.sourceCitations.length, titleLength: result.draft.title.length, bodyLength: result.draft.body.length, llmCalls: 1, publications: 0, telegramMessages: 0 }));
  }
} finally {
  await pool.end();
}
