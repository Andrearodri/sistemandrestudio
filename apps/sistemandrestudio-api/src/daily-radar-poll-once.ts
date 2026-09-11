import { createHash } from "node:crypto";

import { EditorialDraftWorkflowService, HumanEditorialReviewService } from "../../../packages/application/src/index.ts";
import { OllamaEditorialTextGenerator } from "../../../packages/content-engine/src/index.ts";
import {
  PostgresEditorialDraftRepository, PostgresEditorialOrchestrationRepository, PostgresHumanEditorialReviewRepository,
  checkDatabaseConnection, createDatabasePool, loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";
import { parseDailyRadarCallback, resolveDailyRadarSelection, signDailyRadarCallback, type DailyRadarCandidate } from "./daily-radar-domain.ts";

guardEnvironment();
const pool = createDatabasePool(loadDatabaseConfig());
try {
  await checkDatabaseConnection(pool);
  const timeout = Math.max(0, Math.min(50, Number(process.argv[2] ?? "0")));
  let updates = await telegram("getUpdates", { allowed_updates: ["callback_query"], timeout: 0 });
  let found = latestPrivateDailyCallback(updates.result);
  if (!found && timeout > 0) {
    const offset = largestUpdateId(updates.result) + 1;
    updates = await telegram("getUpdates", { allowed_updates: ["callback_query"], offset, timeout });
    found = latestPrivateDailyCallback(updates.result);
  }
  if (!found) {
    console.log(JSON.stringify({ ok:true,processed:false,reason:"NO_DAILY_RADAR_CALLBACK",publicationEnabled:false }));
  } else {
    const chatId = String(found.callback.message.chat.id);
    if (chatId !== required("TELEGRAM_APPROVER_CHAT_ID")) throw new Error("DAILY_RADAR_UNAUTHORIZED_CHAT");
    const parsed = parseDailyRadarCallback(required("TELEGRAM_WEBHOOK_SECRET"), found.callback.data);
    let callbackAcknowledged = true;
    try { await telegram("answerCallbackQuery", { callback_query_id:found.callback.id,text:"Recebido. Registrando a ação local.",show_alert:false }); } catch { callbackAcknowledged=false; }
    const result = parsed.action === "end" || parsed.action.startsWith("select-")
      ? await processSelection(parsed.runId, parsed.action, String(found.callback.from.id), found.callback.message)
      : await processReview(parsed.runId, parsed.action, String(found.callback.from.id), found.callback.message);
    await telegram("getUpdates", { offset:found.updateId+1,allowed_updates:["callback_query"],timeout:0 });
    console.log(JSON.stringify({ ok:true,processed:true,...result,callbackAcknowledged,publicationEnabled:false }));
  }
} finally { await pool.end(); }

async function processSelection(runId:string, action:string, reviewerId:string, message:Callback["message"]) {
  const repository = new PostgresEditorialOrchestrationRepository(pool);
  const run = await repository.getRun(runId);
  if (!run) throw new Error("DAILY_RADAR_RUN_NOT_FOUND");
  const decisionStep = run.steps.find((step)=>step.stepType==="HUMAN_DECISION")!;
  if (decisionStep.status === "COMPLETED") {
    const prior = decisionStep.outputReference as { action?:string;draftId?:string } | undefined;
    resolveDailyRadarSelection(prior?.action, action);
    return { kind:"SELECTION",action,replayed:true,draftId:prior?.draftId ?? null,messageUpdated:false,llmCalls:0 };
  }
  if (action === "end") {
    const now=new Date().toISOString();
    await repository.completeStep({runId,stepType:"HUMAN_DECISION",outputReference:{action,reviewerId,automaticPublication:false},occurredAt:now});
    await repository.updateRunStatus({runId,status:"COMPLETED_WITH_WARNINGS",occurredAt:now,completedAt:now});
    const messageUpdated=await updateMessage(message,"Pauta encerrada sem gerar rascunho.");
    return {kind:"SELECTION",action,replayed:false,draftId:null,messageUpdated,llmCalls:0};
  }
  const index=Number(action.replace("select-",""))-1;
  const generation=run.steps.find((step)=>step.stepType==="DRAFT_GENERATION")?.outputReference as {items?:readonly (DailyRadarCandidate & {summary:string})[]} | undefined;
  const item=generation?.items?.[index];if(!item)throw new Error("DAILY_RADAR_SELECTION_INVALID");
  const service=new EditorialDraftWorkflowService(new PostgresEditorialDraftRepository(pool),OllamaEditorialTextGenerator.fromEnvironment());
  const created=await service.createDraft({newsId:item.newsId,verificationId:item.verificationId,format:"WEBSITE_NEWS_BRIEF",idempotencyKey:`daily-radar-draft:${runId}:${item.newsId}`,commandId:`daily-radar-draft:${runId}:${item.newsId}`,approvalRequestId:`daily-radar-approval:${runId}:${item.newsId}`,expectedVersion:item.newsVersion,actor:{type:"SYSTEM",id:"daily-radar-manual"},occurredAt:new Date().toISOString()});
  const reviewService=new HumanEditorialReviewService(new PostgresHumanEditorialReviewRepository(pool));
  const review=await reviewService.getReviewPackage(created.draft.draftId);if(!review||!review.news)throw new Error("DAILY_RADAR_DRAFT_REVIEW_CONTEXT_MISSING");
  const newsVersion=Number(review.news.version);const draftVersion=review.versionHistory.at(-1)!.version;
  const now=new Date().toISOString();
  await repository.completeStep({runId,stepType:"HUMAN_DECISION",outputReference:{action,reviewerId,selectedNewsId:item.newsId,draftId:created.draft.draftId,draftVersion,newsVersion,automaticPublication:false},occurredAt:now});
  const citation=created.draft.sourceCitations[0];
  await telegram("sendMessage",{chat_id:required("TELEGRAM_APPROVER_CHAT_ID"),text:["Rascunho selecionado — aprovação editorial local",`\n${created.draft.title}`,created.draft.subtitle??"",created.draft.body,`\nFonte oficial: ${citation?.canonicalUrl??item.officialLink}`].filter(Boolean).join("\n"),reply_markup:{inline_keyboard:[[{text:"Aprovar",callback_data:signDailyRadarCallback(required("TELEGRAM_WEBHOOK_SECRET"),runId,"approve")},{text:"Rejeitar",callback_data:signDailyRadarCallback(required("TELEGRAM_WEBHOOK_SECRET"),runId,"reject")}],[{text:"Pedir revisão",callback_data:signDailyRadarCallback(required("TELEGRAM_WEBHOOK_SECRET"),runId,"changes")}]]}});
  const messageUpdated=await updateMessage(message,`Item #${index+1} selecionado. Um único rascunho foi gerado.`);
  return {kind:"SELECTION",action,replayed:created.replayed,draftId:created.draft.draftId,messageUpdated,llmCalls:created.replayed?0:1};
}

async function processReview(runId:string, action:string, reviewerId:string, message:Callback["message"]) {
  const repository=new PostgresEditorialOrchestrationRepository(pool);const run=await repository.getRun(runId);if(!run)throw new Error("DAILY_RADAR_RUN_NOT_FOUND");
  const output=run.steps.find((step)=>step.stepType==="HUMAN_DECISION")?.outputReference as {draftId?:string;draftVersion?:number;newsVersion?:number}|undefined;
  if(!output?.draftId||output.draftVersion===undefined||output.newsVersion===undefined)throw new Error("DAILY_RADAR_DRAFT_NOT_SELECTED");
  const service=new HumanEditorialReviewService(new PostgresHumanEditorialReviewRepository(pool));const reviewedAt=new Date().toISOString();
  const common={reviewId:`daily-radar-review-${digest(`${runId}:${action}`).slice(0,20)}`,draftId:output.draftId,expectedDraftVersion:output.draftVersion,expectedNewsVersion:output.newsVersion,reviewerId,reviewedAt,idempotencyKey:`daily-radar-review:${runId}:${action}`};
  const reviewed=action==="approve"?await service.approve(common):action==="reject"?await service.reject({...common,reason:"Rejeitado via Radar Diário no Telegram."}):await service.requestRevision({...common,reason:"Revisão solicitada via Radar Diário no Telegram.",revisionInstructions:["Aprimorar o rascunho conforme revisão editorial humana."]});
  const now=new Date().toISOString();await repository.updateRunStatus({runId,status:reviewed.state==="APPROVED"?"COMPLETED":"COMPLETED_WITH_WARNINGS",occurredAt:now,completedAt:now});
  const messageUpdated=await updateMessage(message,`Decisão editorial local: ${reviewed.state}. Nenhuma publicação foi executada.`);
  return {kind:"REVIEW",action,state:reviewed.state,replayed:reviewed.replayed,draftId:output.draftId,messageUpdated,llmCalls:0};
}

type Callback={id:string;data:string;from:{id:number};message:{message_id:number;text?:string;chat:{id:number;type:string}}};
function latestPrivateDailyCallback(value:unknown):{updateId:number;callback:Callback}|undefined{if(!Array.isArray(value))return undefined;return value.flatMap((update:any)=>{const callback=update?.callback_query;if(!Number.isSafeInteger(update?.update_id)||typeof callback?.id!=="string"||typeof callback?.data!=="string"||callback?.message?.chat?.type!=="private")return[];try{parseDailyRadarCallback(required("TELEGRAM_WEBHOOK_SECRET"),callback.data);return[{updateId:update.update_id,callback}] }catch{return[]}}).at(-1);}
function largestUpdateId(value:unknown){return Array.isArray(value)?Math.max(-1,...value.map((update:any)=>Number.isSafeInteger(update?.update_id)?update.update_id:-1)):-1;}
async function updateMessage(message:Callback["message"],status:string){try{await telegram("editMessageText",{chat_id:message.chat.id,message_id:message.message_id,text:`${(message.text??"").slice(0,3500)}\n\n${status}`,reply_markup:{inline_keyboard:[]}});return true}catch{return false}}
async function telegram(method:string,body:Record<string,unknown>){const response=await fetch(`https://api.telegram.org/bot${required("TELEGRAM_BOT_TOKEN")}/${method}`,{method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(method==="getUpdates"?58_000:8_000)});const payload=await response.json() as {ok?:boolean;result?:unknown};if(!response.ok||payload.ok!==true)throw new Error(`Telegram ${method} failed.`);return payload;}
function required(name:string){const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required.`);return value;}
function digest(value:string){return createHash("sha256").update(value).digest("hex");}
function guardEnvironment(){if(process.env.DRY_RUN_ORCHESTRATION!=="true"||process.env.PUBLICATION_ENABLED!=="false"||process.env.HUMAN_DECISION_CHANNEL!=="TELEGRAM")throw new Error("Daily radar polling requires dry run, blocked publication and Telegram.");}
