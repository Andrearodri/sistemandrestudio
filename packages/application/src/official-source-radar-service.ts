import { ANDRE_STUDIO_RELEVANCE_POLICY_V1 } from "../../content-engine/src/index.ts";
import type { RelevanceInput } from "../../content-engine/src/index.ts";
import { hash, normalizeCollectedItem, titleSimilarity } from "../../sources/src/index.ts";
import type { RadarLimits, SourceAdapter, SourceDefinition, SourceExecutionMode } from "../../sources/src/index.ts";
import { DEFAULT_RADAR_LIMITS } from "../../sources/src/index.ts";
import type { EditorialWorkflowService } from "./editorial-workflow-service.ts";
import { executeRelevanceWorkflow } from "./relevance-workflow.ts";

export interface RadarRunContext { readonly mode: SourceExecutionMode; readonly collectedAt: string; readonly actorId?: string; }
export interface RadarRunReport { readonly sourceId: string; readonly runId: string; readonly status: "SUCCEEDED" | "FAILED" | "SKIPPED"; readonly found: number; readonly normalized: number; readonly fresh: number; readonly duplicates: number; readonly similar: number; readonly classified: number; readonly errorCode?: string; }
interface SourceRadarRepository { upsertSourceDefinition(source:SourceDefinition):Promise<void>; startRun(id:string,sourceId:string,mode:SourceExecutionMode,startedAt:string):Promise<void>; finishRun(id:string,status:"SUCCEEDED"|"FAILED"|"SKIPPED",finishedAt:string,counts:{found:number;fresh:number;duplicate:number},error?:{code:string;message:string}):Promise<void>; findExact(item:ReturnType<typeof normalizeCollectedItem>):Promise<{item:{id:string};kind:"CANONICAL_URL"|"EXTERNAL_ID"|"CONTENT_HASH"}|undefined>; recordDuplicate(item:ReturnType<typeof normalizeCollectedItem>,match:{item:{id:string};kind:"CANONICAL_URL"|"EXTERNAL_ID"|"CONTENT_HASH"},detectedAt:string):Promise<void>; listBySource(sourceId:string):Promise<readonly {normalizedTitle:string}[]>; saveItem(item:ReturnType<typeof normalizeCollectedItem>,collectedAt:string,editorialNewsId:string,similarityScore:number):Promise<unknown>; }

export class OfficialSourceRadarService {
  readonly repository: SourceRadarRepository; readonly workflow: EditorialWorkflowService; readonly adapter: SourceAdapter; readonly limits: RadarLimits;
  constructor(repository: SourceRadarRepository, workflow: EditorialWorkflowService, adapter: SourceAdapter, limits: RadarLimits = DEFAULT_RADAR_LIMITS) { this.repository=repository; this.workflow=workflow; this.adapter=adapter; this.limits=limits; }
  async runAll(sources: readonly SourceDefinition[], context: RadarRunContext): Promise<readonly RadarRunReport[]> {
    const reports: RadarRunReport[] = [];
    for (const source of sources.slice(0, this.limits.maxSources)) {
      reports.push(await this.run(source, context));
    }
    return reports;
  }

  async run(source: SourceDefinition, context: RadarRunContext): Promise<RadarRunReport> {
    const runId = `source-run-${hash([source.id, context.collectedAt]).slice(0, 24)}`;
    if (!source.enabled) return {sourceId:source.id,runId,status:"SKIPPED",found:0,normalized:0,fresh:0,duplicates:0,similar:0,classified:0};
    await this.repository.upsertSourceDefinition(source); await this.repository.startRun(runId,source.id,context.mode,context.collectedAt);
    let found=0, normalized=0, fresh=0, duplicates=0, similar=0, classified=0;
    try {
      const items = await this.adapter.collect(source,this.limits); found=items.length;
      for (const raw of items) {
        const item=normalizeCollectedItem(raw,this.limits); normalized+=1; const exact=await this.repository.findExact(item);
        if(exact){duplicates+=1; await this.repository.recordDuplicate(item,exact,context.collectedAt); continue;}
        const previous=await this.repository.listBySource(source.id); const similarity=Math.max(0,...previous.map((candidate)=>titleSimilarity(item.normalizedTitle,candidate.normalizedTitle)));
        if(similarity>0) similar+=1;
        const newsId=`news-radar-${hash([source.id,item.contentHash]).slice(0,24)}`; const actor={type:"SYSTEM" as const,id:context.actorId ?? "official-source-radar"}; const occurredAt=item.publishedAt ?? context.collectedAt; const evaluatedAt=item.updatedAt ?? occurredAt;
        await this.workflow.execute({commandId:`receive-${hash([newsId]).slice(0,20)}`,idempotencyKey:`radar:receive:${item.contentHash}`,newsId,actor,occurredAt,expectedVersion:0,command:{type:"ReceiveNews",source:{id:source.id,name:source.name,url:source.feedUrl,isOfficial:true},title:item.normalizedTitle,originalUrl:item.canonicalUrl,publishedAt:occurredAt,eventAt:occurredAt,receivedAt:occurredAt}});
        await this.workflow.execute({commandId:`normalize-${hash([newsId]).slice(0,20)}`,idempotencyKey:`radar:normalize:${item.contentHash}`,newsId,actor,occurredAt,expectedVersion:0,command:{type:"NormalizeNews",normalizedTitle:item.normalizedTitle,canonicalUrl:item.canonicalUrl}});
        await executeRelevanceWorkflow(this.workflow,{newsId,input:toRelevanceInput(source,item,similarity,evaluatedAt),policy:ANDRE_STUDIO_RELEVANCE_POLICY_V1,scoring:{commandId:`score-${hash([newsId]).slice(0,20)}`,idempotencyKey:`radar:score:${item.contentHash}`,actor,occurredAt,expectedVersion:1},routing:{commandId:`route-${hash([newsId]).slice(0,20)}`,idempotencyKey:`radar:route:${item.contentHash}`,actor,occurredAt}});
        await this.repository.saveItem(item,context.collectedAt,newsId,similarity); fresh+=1; classified+=1;
      }
      await this.repository.finishRun(runId,"SUCCEEDED",context.collectedAt,{found,fresh,duplicate:duplicates}); return {sourceId:source.id,runId,status:"SUCCEEDED",found,normalized,fresh,duplicates,similar,classified};
    } catch(error) { const code=error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "RADAR_RUN_FAILED"; await this.repository.finishRun(runId,"FAILED",context.collectedAt,{found,fresh,duplicate:duplicates},{code,message:"Source run failed; see local structured logs."}); return {sourceId:source.id,runId,status:"FAILED",found,normalized,fresh,duplicates,similar,classified,errorCode:code}; }
  }
}
function toRelevanceInput(source:SourceDefinition,item:{normalizedTitle:string;normalizedSummary?:string|undefined;publishedAt?:string|undefined},similarity:number,evaluatedAt:string):RelevanceInput { return {title:item.normalizedTitle,summary:item.normalizedSummary ?? item.normalizedTitle,informedTopics:source.topics,sourceType:"OFFICIAL",publishedAt:item.publishedAt ?? evaluatedAt,eventAt:item.publishedAt ?? null,evaluatedAt,noveltyType:"MAJOR_UPDATE",isRumor:false,isPromotional:false,isSensationalist:false,similarityToExisting:similarity,contentFormats:["POST","ARTICLE"],commercialRelations:["AUTOMATION_SERVICE","CUSTOM_SYSTEM","APPLIED_AI"]}; }
