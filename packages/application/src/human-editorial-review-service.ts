import { createHash } from "node:crypto";
import { validateEditorialDraft, type EditorialBrief, type EditorialCitation, type EditorialDraft, type EditorialWarning, type AllowedEditorialFact } from "../../content-engine/src/editorial-drafting.ts";
import { isAllowedLocalizedFactEquivalent, type LocalizedFactRejectionCode } from "../../content-engine/src/editorial-fact-localization.ts";

export type HumanReviewDecision = "APPROVE" | "REQUEST_REVISION" | "REJECT";
export type HumanReviewState = "PENDING_APPROVAL" | "APPROVED" | "REVISION_REQUESTED" | "REJECTED";
export interface HumanReviewInput { reviewId:string; draftId:string; expectedDraftVersion:number; expectedNewsVersion:number; reviewerId:string; decision:HumanReviewDecision; reason?:string; revisionInstructions?:string[]; reviewedAt:string; idempotencyKey:string }
export interface ManualDraftRevision { title:string; subtitle?:string; body:string; acknowledgedInstructions:string[] }
export interface FactPreservationValidation {
 readonly factPreservationMethod:"VERBATIM"|"LOCALIZED_EQUIVALENT";
 readonly allowedFactId:string;
 readonly equivalenceId?:string;
 readonly sourceLanguage?:string;
 readonly targetLanguage?:string;
}
export interface ManualRevisionRepositoryInput { draftId:string; reviewerId:string; revision:ManualDraftRevision; reviewedAt:string; idempotencyKey:string; validation:FactPreservationValidation }
export interface ReviewDecision { reviewId:string; draftId:string; draftVersion:number; newsVersion:number; reviewerId:string; decision:HumanReviewDecision; reason?:string; revisionInstructions?:string[]; reviewedAt:string; idempotencyKey:string }
export interface EditorialReviewPackage { news?:Readonly<Record<string,unknown>>; draft:EditorialDraft; brief:EditorialBrief; allowedFacts:readonly AllowedEditorialFact[]; prohibitedStatements:readonly string[]; evidenceReferences:readonly EditorialCitation[]; citations:readonly EditorialCitation[]; warnings:readonly EditorialWarning[]; validation:ReturnType<typeof validateEditorialDraft>; versionHistory:readonly {version:number; draftId:string; createdAt:string}[]; reviewHistory:readonly ReviewDecision[]; revisionRequestHistory?:readonly Readonly<Record<string,unknown>>[] }
export interface HumanReviewRepository { listPending():Promise<EditorialReviewPackage[]>; get(id:string):Promise<EditorialReviewPackage|undefined>; decide(input:HumanReviewInput):Promise<{decision:ReviewDecision; state:HumanReviewState; replayed:boolean}>; revise(input:ManualRevisionRepositoryInput):Promise<{draft:EditorialDraft; state:HumanReviewState; replayed:boolean}> }
export class HumanEditorialReviewError extends Error { readonly code:string; constructor(code:string,message:string){super(message);this.name="HumanEditorialReviewError";this.code=code} }
const reviewer=/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
function checkReviewer(id:string){if(!id||!reviewer.test(id)||/[<>\u0000-\u001f]/.test(id))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_INVALID_REVIEWER","Invalid reviewer identifier.")}
function clean(value:string, required=false){if((required&&!value.trim())||value.length>6000||/<[^>]+>|(?:javascript|data|file):|on[a-z]+\s*=/i.test(value)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_UNSAFE_CONTENT","Unsafe or empty review input.");return value.trim()}
function validateManualContent(r:ManualDraftRevision,p:EditorialReviewPackage):FactPreservationValidation{
 const text=`${r.title}\n${r.subtitle??""}\n${r.body}`, baseline=[...p.allowedFacts.map(f=>f.statement),...p.citations.map(c=>`${c.title} ${c.canonicalUrl} ${c.publishedAt??""}`),JSON.stringify(p.brief.subject)].join(" ");
 if(/https?:\/\/\S+/gi.test(text)){for(const url of text.match(/https?:\/\/\S+/gi)??[])if(!p.citations.some(c=>c.canonicalUrl===url.replace(/[),.;]+$/,"")))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_UNAUTHORIZED_URL","Only persisted citation URLs are allowed.")}
 if(/\b(bit\.ly|t\.co|tinyurl\.com)\b/i.test(text))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_UNAUTHORIZED_URL","Shortened URLs are forbidden.");
 if(/\b(revolucion[áa]rio|vai mudar tudo|melhor do mundo|imperd[ií]vel|garantido|sem d[uú]vida)\b/i.test(text))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_CERTAINTY_ESCALATION","Sensationalism or certainty escalation is forbidden.");
 if(/\b(preview|beta)\b/i.test(baseline)&&/\b(dispon[ií]vel para todos|disponibilidade geral|general availability|ga)\b/i.test(text))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_CERTAINTY_ESCALATION","Preview cannot be presented as generally available.");
 if(/\b(pre[çc]o|receita|lucro|roi|mais r[aá]pido|superior a|compat[ií]vel com)\b/i.test(text)&&!/\b(pre[çc]o|receita|lucro|roi|mais r[aá]pido|superior a|compat[ií]vel com)\b/i.test(baseline))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_PROHIBITED_FACT","Unsupported commercial, performance or compatibility claim.");
 for(const token of text.match(/(?<![\p{L}\p{N}_])(?:v?\d+(?:\.\d+)+|\d{4}-\d{2}-\d{2}|\d+(?:[.,]\d+)?%)(?![\p{L}\p{N}_])/gu)??[])if(!baseline.includes(token))throw new HumanEditorialReviewError(token.includes("-")?"EDITORIAL_REVIEW_UNSUPPORTED_DATE":"EDITORIAL_REVIEW_UNSUPPORTED_VERSION","A numeric, date or version token is not supported by the brief.");
 if(p.citations.length===0)throw new HumanEditorialReviewError("EDITORIAL_REVIEW_CITATION_MISSING","Persisted citations are required.");
 const verbatim=p.allowedFacts.find(f=>containsVerbatimFact(text,f.statement));
 if(verbatim)return {factPreservationMethod:"VERBATIM",allowedFactId:verbatim.factId};
 const localized=p.allowedFacts.map(f=>({fact:f,match:isAllowedLocalizedFactEquivalent({allowedFact:f.statement,revisedText:text,sourceLanguage:"en",targetLanguage:"pt-BR"})}));
 const accepted=localized.find(x=>x.match.matched);
 if(accepted){
  if(!accepted.match.targetStatement||!isLocalizedRevisionOnly(r,p,accepted.fact.statement,accepted.match.targetStatement))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_PROHIBITED_FACT","Localized revision contains changes outside the registered factual equivalence.");
  return {factPreservationMethod:"LOCALIZED_EQUIVALENT",allowedFactId:accepted.fact.factId,equivalenceId:accepted.match.equivalenceId!,sourceLanguage:accepted.match.sourceLanguage!,targetLanguage:accepted.match.targetLanguage!};
 }
 const rejection=localized.map(x=>x.match.rejectionCode).find((code):code is LocalizedFactRejectionCode=>code==="EDITORIAL_REVIEW_LOCALIZED_ENTITY_MISMATCH")
  ??localized.map(x=>x.match.rejectionCode).find((code):code is LocalizedFactRejectionCode=>code==="EDITORIAL_REVIEW_LOCALIZED_PREDICATE_UNSUPPORTED")
  ??"EDITORIAL_REVIEW_LOCALIZED_FACT_NOT_EQUIVALENT";
 throw new HumanEditorialReviewError(rejection,"Revision does not preserve a confirmed fact verbatim or through an exact registered localized equivalent.");
}
function containsVerbatimFact(text:string,statement:string){const normalized=(value:string)=>value.replace(/\s+/gu," ").trim().replace(/[.!?]+\s*$/u,"").toLocaleLowerCase("pt-BR");return normalized(text).includes(normalized(statement))}
function isLocalizedRevisionOnly(r:ManualDraftRevision,p:EditorialReviewPackage,sourceStatement:string,targetStatement:string){
 const expectedTitle=replaceStatement(p.draft.title,sourceStatement,targetStatement),expectedSubtitle=p.draft.subtitle===undefined?undefined:replaceStatement(p.draft.subtitle,sourceStatement,targetStatement),expectedBody=replaceStatement(p.draft.body,sourceStatement,targetStatement);
 const same=(a:string|undefined,b:string|undefined)=>a===undefined||b===undefined?a===b:a.replace(/\s+/gu," ").trim()===b.replace(/\s+/gu," ").trim();
 return same(r.title,expectedTitle)&&same(r.subtitle,expectedSubtitle)&&same(r.body,expectedBody);
}
function replaceStatement(text:string,sourceStatement:string,targetStatement:string){const core=sourceStatement.replace(/[.!?]+\s*$/u,"").trim(),pattern=core.split(/\s+/u).map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("\\s+");return text.replace(new RegExp(`${pattern}[.!?]?`,"giu"),targetStatement)}
export class HumanEditorialReviewService {
 private readonly repo:HumanReviewRepository; constructor(repo:HumanReviewRepository){this.repo=repo}
 listPending(){return this.repo.listPending()}
 getReviewPackage(id:string){return this.repo.get(id)}
 async approve(input:Omit<HumanReviewInput,"decision">){return this.decide({...input,decision:"APPROVE"})}
 async requestRevision(input:Omit<HumanReviewInput,"decision">){checkReviewer(input.reviewerId);clean(input.reason??"",true);if(!input.revisionInstructions?.length)throw new HumanEditorialReviewError("EDITORIAL_REVIEW_INSTRUCTIONS_REQUIRED","At least one instruction is required.");input.revisionInstructions.forEach(i=>clean(i,true));return this.decide({...input,decision:"REQUEST_REVISION"})}
 async reject(input:Omit<HumanReviewInput,"decision">){checkReviewer(input.reviewerId);clean(input.reason??"",true);return this.decide({...input,decision:"REJECT"})}
 private async decide(input:HumanReviewInput){checkReviewer(input.reviewerId);if(!Number.isSafeInteger(input.expectedDraftVersion)||!Number.isSafeInteger(input.expectedNewsVersion))throw new HumanEditorialReviewError("EDITORIAL_REVIEW_VERSION_CONFLICT","Expected versions are required.");if(input.decision!=="APPROVE"&&input.decision!=="REQUEST_REVISION"&&input.decision!=="REJECT")throw new HumanEditorialReviewError("EDITORIAL_REVIEW_INVALID_DECISION","Unsupported decision.");if(input.decision!=="APPROVE")clean(input.reason??"",true);const pkg=await this.repo.get(input.draftId);if(!pkg)throw new HumanEditorialReviewError("EDITORIAL_REVIEW_DRAFT_NOT_FOUND","Draft not found.");if(pkg.validation.status==="BLOCKED")throw new HumanEditorialReviewError("EDITORIAL_REVIEW_DRAFT_BLOCKED","Blocked drafts cannot be reviewed.");if(input.decision==="APPROVE"&&pkg.draft.validationStatus!=="VALID"&&pkg.draft.validationStatus!=="VALID_WITH_WARNINGS")throw new HumanEditorialReviewError("EDITORIAL_REVIEW_DRAFT_BLOCKED","Draft validation does not permit approval.");return this.repo.decide(input)}
 async submitRevision(input:{draftId:string;reviewerId:string;revision:ManualDraftRevision;reviewedAt:string;idempotencyKey:string}){checkReviewer(input.reviewerId);const pkg=await this.repo.get(input.draftId);if(!pkg)throw new HumanEditorialReviewError("EDITORIAL_REVIEW_DRAFT_NOT_FOUND","Draft not found.");if(pkg.reviewHistory.at(-1)?.decision!=="REQUEST_REVISION")throw new HumanEditorialReviewError("EDITORIAL_REVIEW_REVISION_NOT_REQUESTED","Revision was not requested.");const r=input.revision;clean(r.title,true);clean(r.subtitle??"");clean(r.body,true);if(!Array.isArray(r.acknowledgedInstructions)||r.acknowledgedInstructions.length===0)throw new HumanEditorialReviewError("EDITORIAL_REVIEW_INSTRUCTIONS_REQUIRED","Acknowledged instructions are required.");const factValidation=validateManualContent(r,pkg);const draftBase={...pkg.draft,draftId:`${pkg.draft.draftId}-v${pkg.versionHistory.length+1}`,title:r.title,body:r.body,createdAt:input.reviewedAt,validationStatus:"BLOCKED" as const};const draft=r.subtitle===undefined?draftBase:{...draftBase,subtitle:r.subtitle};const validation=validateEditorialDraft(draft,pkg.brief);if(validation.status==="BLOCKED")throw new HumanEditorialReviewError("EDITORIAL_REVIEW_REVISION_INVALID",validation.blockingReasons.map(x=>x.code).join(","));const result=await this.repo.revise({...input,validation:factValidation});return {...result,validation:factValidation}}
}
export class InMemoryHumanReviewRepository implements HumanReviewRepository {
 private packages=new Map<string,EditorialReviewPackage>(); private decisions=new Map<string,ReviewDecision>(); private states=new Map<string,HumanReviewState>();
 constructor(packages:EditorialReviewPackage[]=[]){for(const p of packages){this.packages.set(p.draft.draftId,p);this.states.set(p.draft.draftId,"PENDING_APPROVAL")}}
 async listPending(){return [...this.packages.values()].filter(p=>this.states.get(p.draft.draftId)==="PENDING_APPROVAL")}
 async get(id:string){return this.packages.get(id)}
 async decide(input:HumanReviewInput):Promise<{decision:ReviewDecision;state:HumanReviewState;replayed:boolean}>{const state=this.states.get(input.draftId);if(state===undefined)throw new HumanEditorialReviewError("EDITORIAL_REVIEW_DRAFT_NOT_FOUND","Draft not found.");const prior=this.decisions.get(input.idempotencyKey);if(prior){return {decision:prior,state:this.states.get(input.draftId)!,replayed:true}}
 if(state!=="PENDING_APPROVAL")throw new HumanEditorialReviewError("EDITORIAL_REVIEW_ALREADY_DECIDED","Draft already decided.");const dBase={reviewId:input.reviewId,draftId:input.draftId,draftVersion:input.expectedDraftVersion,newsVersion:input.expectedNewsVersion,reviewerId:input.reviewerId,decision:input.decision,reviewedAt:input.reviewedAt,idempotencyKey:input.idempotencyKey};const d:ReviewDecision=input.reason===undefined?dBase:input.revisionInstructions===undefined?{...dBase,reason:input.reason}:{...dBase,reason:input.reason,revisionInstructions:input.revisionInstructions};this.decisions.set(input.idempotencyKey,d);const next:HumanReviewState=input.decision==="APPROVE"?"APPROVED":input.decision==="REJECT"?"REJECTED":"REVISION_REQUESTED";this.states.set(input.draftId,next);const p=this.packages.get(input.draftId)!;this.packages.set(input.draftId,{...p,reviewHistory:[...p.reviewHistory,d]});return {decision:d,state:next,replayed:false}
 }
 async revise(input:ManualRevisionRepositoryInput){const p=this.packages.get(input.draftId)!;const base={...p.draft,draftId:`${p.draft.draftId}-v${p.versionHistory.length+1}`,title:input.revision.title,body:input.revision.body,createdAt:input.reviewedAt};const draft=input.revision.subtitle===undefined?base:{...base,subtitle:input.revision.subtitle};this.packages.set(draft.draftId,{...p,draft,versionHistory:[...p.versionHistory,{version:p.versionHistory.length+1,draftId:draft.draftId,createdAt:input.reviewedAt}],reviewHistory:p.reviewHistory});this.states.set(draft.draftId,"PENDING_APPROVAL");return {draft,state:"PENDING_APPROVAL" as const,replayed:false}}
}
