import {
  createDatabasePool,
  withTransaction,
} from "../../../packages/database/src/index.ts";

export async function removePreviousEditorialDemo(
  pool: ReturnType<typeof createDatabasePool>,
  newsId: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      "UPDATE editorial_news SET current_draft_version_id = NULL, current_approval_request_id = NULL WHERE id = $1",
      [newsId],
    );
    await client.query(
      `DELETE FROM editorial_draft_validations
       WHERE draft_id IN (SELECT id FROM editorial_drafts WHERE news_id = $1)`,
      [newsId],
    );
    await client.query(
      `DELETE FROM editorial_draft_citations
       WHERE draft_id IN (SELECT id FROM editorial_drafts WHERE news_id = $1)`,
      [newsId],
    );
    await client.query("DELETE FROM editorial_drafts WHERE news_id = $1", [newsId]);
    await client.query(
      `DELETE FROM editorial_brief_facts
       WHERE brief_id IN (SELECT id FROM editorial_briefs WHERE news_id = $1)`,
      [newsId],
    );
    await client.query(
      `DELETE FROM editorial_brief_claims
       WHERE brief_id IN (SELECT id FROM editorial_briefs WHERE news_id = $1)`,
      [newsId],
    );
    await client.query("DELETE FROM editorial_briefs WHERE news_id = $1", [newsId]);
    await client.query(
      `DELETE FROM verification_claim_results
       WHERE result_id IN (
         SELECT id FROM verification_results WHERE news_id = $1
       )`,
      [newsId],
    );
    await client.query(
      `DELETE FROM verification_results WHERE news_id = $1`,
      [newsId],
    );
    await client.query(
      `DELETE FROM verification_evidence
       WHERE claim_id IN (
         SELECT id FROM verification_claims WHERE news_id = $1
       )`,
      [newsId],
    );
    await client.query(
      `DELETE FROM verification_claims WHERE news_id = $1`,
      [newsId],
    );
    await client.query(
      `DELETE FROM verification_runs WHERE news_id = $1`,
      [newsId],
    );
    await client.query("UPDATE editorial_news SET state = 'RECEIVED' WHERE id = $1", [newsId]);
    await client.query("DELETE FROM approval_actions WHERE news_id = $1", [
      newsId,
    ]);
    await client.query("DELETE FROM processed_commands WHERE news_id = $1", [
      newsId,
    ]);
    await client.query("DELETE FROM audit_events WHERE news_id = $1", [newsId]);
    await client.query(
      "DELETE FROM editorial_relevance_results WHERE news_id = $1",
      [newsId],
    );
    await client.query("DELETE FROM approval_requests WHERE news_id = $1", [
      newsId,
    ]);
    await client.query("DELETE FROM draft_versions WHERE news_id = $1", [
      newsId,
    ]);
    await client.query("DELETE FROM editorial_news WHERE id = $1", [newsId]);
  });
}
