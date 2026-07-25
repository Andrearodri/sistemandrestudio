import { parseArgs } from "node:util";
import { createDatabasePool,loadDatabaseConfig,PostgresHumanEditorialReviewRepository } from "../../../packages/database/src/index.ts";
const {values}=parseArgs({options:{draft:{type:"string"}},strict:true});if(!values.draft)throw new Error("EDITORIAL_REVIEW_INPUT_INVALID: --draft is required");
const pool=createDatabasePool(loadDatabaseConfig());try{const p=await new PostgresHumanEditorialReviewRepository(pool).get(values.draft);if(!p)throw new Error("EDITORIAL_REVIEW_DRAFT_NOT_FOUND");
const bounded=(v:string,n=1200)=>v.length>n?`${v.slice(0,n)}…`:v;
console.log(JSON.stringify({news:p.news,draft:{id:p.draft.draftId,format:p.draft.format,title:p.draft.title,subtitle:p.draft.subtitle,body:bounded(p.draft.body),validation:p.draft.validationStatus},brief:{id:p.brief.briefId,subject:p.brief.subject,policyId:p.brief.policyId,policyVersion:p.brief.policyVersion,confirmedClaims:p.brief.confirmedClaims,restrictedClaims:p.brief.restrictedClaims,prohibitedClaims:p.brief.prohibitedClaims,disclosures:p.brief.requiredDisclosures},allowedFacts:p.allowedFacts,evidence:p.evidenceReferences,citations:p.citations,warnings:p.warnings,blockingReasons:p.validation.blockingReasons,versionHistory:p.versionHistory,reviewHistory:p.reviewHistory,revisionRequests:p.revisionRequestHistory},null,2));
}finally{await pool.end()}
