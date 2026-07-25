import {
  EditorialDraftWorkflowService,
} from "../../../packages/application/src/index.ts";
import {
  PostgresEditorialDraftRepository, createDatabasePool, loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";

const pool = createDatabasePool(loadDatabaseConfig());
try {
  const rows = await pool.query<{ verification_id: string; news_id: string; evaluated_at: Date | string; title: string }>(`
    SELECT result.id AS verification_id, result.news_id, result.evaluated_at, news.title
    FROM verification_results result JOIN editorial_news news ON news.id = result.news_id
    WHERE result.status = 'CONFIRMED'
      AND news.state = 'VERIFIED'
      AND (news.source->>'isOfficial')::boolean = true
      AND lower(news.source->>'id') !~ '(fixture|fictional|demo|test)'
      AND lower(news.source->>'name') !~ '(fict[ií]cia|fixture|demo|test)'
      AND lower(news.title) !~ '(fict[ií]ci|fixture|demo|test)'
    ORDER BY result.evaluated_at, result.id LIMIT 2`);
  const service = new EditorialDraftWorkflowService(new PostgresEditorialDraftRepository(pool));
  for (const [index, row] of rows.rows.entries()) {
    const context = await new PostgresEditorialDraftRepository(pool).loadContext(row.news_id, row.verification_id);
    if (context === undefined) continue;
    const occurredAt = row.evaluated_at instanceof Date ? row.evaluated_at.toISOString() : new Date(row.evaluated_at).toISOString();
    const result = await service.createDraft({ newsId: row.news_id, verificationId: row.verification_id, format: index === 0 ? "LINKEDIN_SHORT_POST" : "WEBSITE_NEWS_BRIEF", idempotencyKey: `official-draft:${row.verification_id}:${index}`, commandId: `official-draft:${row.verification_id}:${index}`, approvalRequestId: `official-approval:${row.verification_id}:${index}`, expectedVersion: context.news.auditEvents.length, actor: { type: "SYSTEM", id: "editorial-draft-official" }, occurredAt });
    console.log(`${context.news.source.name} | ${row.title}\nStatus factual: ${context.verification.status}\nClaims permitidas: ${result.draft.sourceCitations.length}\nFormato: ${result.draft.format}\nTítulo: ${result.draft.title}\nValidação: ${result.draft.validationStatus}\nEstado final: ${result.currentState}\nReplay: ${result.replayed}\n`);
  }
  if (rows.rows.length === 0) console.log("Nenhum item CONFIRMED e VERIFIED disponível para rascunho local.");
} finally { await pool.end(); }
