import {createHash} from "node:crypto";
import {lstat,readFile,readdir,realpath} from "node:fs/promises";
import {basename,relative,resolve} from "node:path";
import type {PublicationFile,PublicationPackage} from "./publication-package-service.ts";
import {validatePublicationPackage} from "./publication-package-service.ts";

export const WEBSITE_PUBLICATION_POLICY={id:"andre-studio-website-publication",version:"andre-studio-website-publication-v1"} as const;
export const WEBSITE_PUBLICATION_AUDIT_ACTIONS=["WEBSITE_PUBLICATION_PLAN_CREATED","WEBSITE_PUBLICATION_PLAN_VALIDATED","WEBSITE_PUBLICATION_DRY_RUN_COMPLETED","WEBSITE_PUBLICATION_PLAN_REPLAYED","WEBSITE_PUBLICATION_PLAN_BLOCKED"] as const;
export interface WebsiteTargetProfile {targetId:string;profileVersion:string;brand:string;publicBaseUrl:string;legacyTechnicalBaseUrl?:"https://andrestudiodev.duckdns.org";publicationMode:"STATIC_MARKDOWN"|"STATIC_JSON"|"REPOSITORY_CONTENT"|"UNKNOWN";contentDirectory:string|"UNKNOWN";assetDirectory:string|"UNKNOWN";routePattern:string|"UNKNOWN";requiresBuild:boolean|"UNKNOWN";requiresRestart:boolean|"UNKNOWN";policyId:string;policyVersion:string}
export const ANDRESTUDIO_WEBSITE_PROFILE:WebsiteTargetProfile={targetId:"andrestudio-website",profileVersion:"andre-studio-website-target-v2",brand:"AndréStudio.dev",publicBaseUrl:"https://andrestudio.dev.br",legacyTechnicalBaseUrl:"https://andrestudiodev.duckdns.org",publicationMode:"UNKNOWN",contentDirectory:"UNKNOWN",assetDirectory:"UNKNOWN",routePattern:"UNKNOWN",requiresBuild:"UNKNOWN",requiresRestart:"UNKNOWN",policyId:WEBSITE_PUBLICATION_POLICY.id,policyVersion:WEBSITE_PUBLICATION_POLICY.version};
export type WebsitePublicationMode="DRY_RUN"|"LIVE";
export type WebsitePlanStatus="CREATED"|"VALIDATED"|"DRY_RUN_COMPLETED"|"FAILED";
export type WebsiteOperationStatus="PLANNED"|"PROVISIONAL"|"REQUIRES_TARGET_INSPECTION"|"REQUIRES_CONFIRMATION"|"BLOCKED_IN_DRY_RUN";
export interface PlannedSourceFile {role:string;relativePath:string;contentHash:string;sizeBytes:number}
export interface PlannedDestinationFile {role:string;destinationPath:string;status:"PROVISIONAL"}
export interface WebsitePublicationOperation {position:number;code:string;description:string;sourcePath?:string;destinationPath?:string;condition:string;required:boolean;localExecution:boolean;remote:boolean;status:WebsiteOperationStatus}
export interface WebsitePublicationPrerequisite {code:string;description:string;required:true;status:"CONFIRMED"|"PENDING"|"UNKNOWN"}
export interface WebsitePublicationPlan {planId:string;publicationId:string;newsId:string;draftId:string;draftVersion:number;mode:"DRY_RUN";targetProfileId:string;profileVersion:string;publicBaseUrl:string;legacyTechnicalBaseUrl?:string;policyId:string;policyVersion:string;sourceFiles:readonly PlannedSourceFile[];destinationFiles:readonly PlannedDestinationFile[];slug:string;packageContentHash:string;functionalFingerprint:string;status:WebsitePlanStatus;validationStatus:"VALID"|"VALID_WITH_WARNINGS"|"BLOCKED";provisionalPublicUrl:string;detectedPlatform:"UNKNOWN";publicationStrategy:"STATIC_MARKDOWN"|"STATIC_JSON"|"REPOSITORY_CONTENT"|"UNKNOWN";contentDirectory:string|"UNKNOWN";routePattern:string|"UNKNOWN";requiresBuild:boolean|"UNKNOWN";requiresRestart:boolean|"UNKNOWN";operations:readonly WebsitePublicationOperation[];prerequisites:readonly WebsitePublicationPrerequisite[];warnings:readonly string[];createdAt:string}
export interface ReadyWebsitePackage {pkg:PublicationPackage;files:readonly Omit<PublicationFile,"content">[]}
export interface WebsitePublicationPlanRepository {
 listReadyPackages():Promise<ReadyWebsitePackage[]>;
 loadReadyPackage(publicationId:string):Promise<ReadyWebsitePackage|undefined>;
 findByIdempotency(key:string):Promise<WebsitePublicationPlan|undefined>;
 save(input:{plan:WebsitePublicationPlan;idempotencyKey:string;commandId:string}):Promise<{plan:WebsitePublicationPlan;replayed:boolean}>;
 get(planId:string):Promise<WebsitePublicationPlan|undefined>;
 list():Promise<WebsitePublicationPlan[]>;
}
export class WebsitePublicationPlanningError extends Error {readonly code:string;constructor(code:string,message:string){super(message);this.name="WebsitePublicationPlanningError";this.code=code}}
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;if(value&&typeof value==="object")return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;return JSON.stringify(value)}
function safeRelative(path:string){return !!path&&!path.startsWith("/")&&!path.includes("..")&&!path.includes("\\")&&!path.startsWith(".")&&path.length<=300}

export class LocalWebsitePublicationPackageReader {
 private readonly root:string;
 constructor(root="output"){this.root=resolve(root)}
 async validate(source:ReadyWebsitePackage):Promise<void>{
  const {pkg,files}=source;
  if(pkg.destination!=="WEBSITE_EXPORT"||pkg.status!=="READY_FOR_PUBLICATION"||!pkg.slug||validatePublicationPackage(pkg)==="BLOCKED")this.invalid();
  if(files.length!==3||new Set(files.map(x=>x.role)).size!==3)this.invalid();
  const contents=new Map<string,string>();
  for(const file of files){if(!safeRelative(file.relativePath)||file.sizeBytes<1||file.sizeBytes>1_000_000)this.invalid();const target=resolve(this.root,file.relativePath);if(relative(this.root,target).startsWith(".."))this.invalid();const stat=await lstat(target).catch(()=>undefined);if(!stat?.isFile()||stat.isSymbolicLink()||stat.size!==file.sizeBytes)this.invalid();const content=await readFile(target,"utf8");if(hash(content)!==file.contentHash||/<script\b|javascript:|data:text\/html/i.test(content))this.invalid();contents.set(file.role,content)}
  const markdown=contents.get("CONTENT_MARKDOWN")??"",jsonText=contents.get("CONTENT_JSON")??"",manifestText=contents.get("MANIFEST")??"";
  let json:Record<string,unknown>,manifest:Record<string,unknown>;try{json=JSON.parse(jsonText);manifest=JSON.parse(manifestText)}catch{this.invalid()}
  const expectedPath=`website/${pkg.slug}`;
  const fileMap=new Map(files.map(x=>[x.role,x]));
  if(fileMap.get("CONTENT_MARKDOWN")?.relativePath!==`${expectedPath}.md`||fileMap.get("CONTENT_JSON")?.relativePath!==`${expectedPath}.json`||fileMap.get("MANIFEST")?.relativePath!==`manifests/${pkg.publicationId}.json`)this.invalid();
  if(json!.publicationId!==pkg.publicationId||json!.contentHash!==pkg.contentHash||json!.status!=="READY_FOR_PUBLICATION"||manifest!.publicationId!==pkg.publicationId||manifest!.contentHash!==pkg.contentHash||manifest!.status!=="READY_FOR_PUBLICATION")this.invalid();
  for(const document of [json!,manifest!])if(document.draftId!==pkg.draftId||document.draftVersion!==pkg.draftVersion||document.approvalDecisionId!==pkg.approvalDecisionId||document.reviewerId!==pkg.reviewerId)this.invalid();
  if(!markdown.includes(`publicationId: ${JSON.stringify(pkg.publicationId)}`)||!markdown.includes('brand: "AndréStudio.dev"')||!markdown.includes('author: "André Rodrigues"'))this.invalid();
  const authorizedUrls=new Set(pkg.citations.map(x=>x.canonicalUrl));for(const url of `${markdown}\n${jsonText}\n${manifestText}`.match(/https:\/\/[^\s"'<>\\]+/g)??[])if(!authorizedUrls.has(url.replace(/[),.;]+$/,"")))this.invalid();
  const manifestFiles=manifest!.files;if(!Array.isArray(manifestFiles)||manifestFiles.length!==2)this.invalid();
  for(const item of manifestFiles as Record<string,unknown>[]){const stored=files.find(x=>x.role===item.role);if(!stored||stored.relativePath!==item.relativePath||stored.contentHash!==item.contentHash||stored.sizeBytes!==item.sizeBytes)this.invalid()}
 }
 private invalid():never{throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_PACKAGE_INVALID","The local website publication package is invalid.")}
}

export function buildWebsitePublicationPlan(source:ReadyWebsitePackage,input:{mode:WebsitePublicationMode;createdAt:string},profile:WebsiteTargetProfile=ANDRESTUDIO_WEBSITE_PROFILE):WebsitePublicationPlan {
 if(input.mode==="LIVE")throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_LIVE_MODE_DISABLED","Live website publication is disabled.");
 const fingerprint=hash(canonical({publicationId:source.pkg.publicationId,targetId:profile.targetId,publicBaseUrl:profile.publicBaseUrl,profileVersion:profile.profileVersion,policyId:WEBSITE_PUBLICATION_POLICY.id,policyVersion:WEBSITE_PUBLICATION_POLICY.version,contentHash:source.pkg.contentHash}));
 const slug=source.pkg.slug??"unknown";
 const markdown=source.files.find(x=>x.role==="CONTENT_MARKDOWN")!,json=source.files.find(x=>x.role==="CONTENT_JSON")!;
 const destinationFiles:PlannedDestinationFile[]=[{role:"CONTENT_MARKDOWN",destinationPath:"UNKNOWN",status:"PROVISIONAL"},{role:"CONTENT_JSON",destinationPath:"UNKNOWN",status:"PROVISIONAL"}];
 const suggestedUrl=`${profile.publicBaseUrl}/noticias/${slug}`;
 const operationRows=[
  ["COPY_MARKDOWN","Plan copy of the approved Markdown.",markdown.relativePath,destinationFiles[0]!.destinationPath,false,true],
  ["COPY_JSON","Plan copy of the approved JSON.",json.relativePath,destinationFiles[1]!.destinationPath,false,true],
  ["CREATE_ROUTE","Suggest a route only after target inspection.",undefined,suggestedUrl,false,true],
  ["UPDATE_INDEX","Confirm whether a content index must be updated.",undefined,undefined,false,true],
  ["RUN_BUILD","Run the website build only after explicit authorization.",undefined,undefined,false,true],
  ["VALIDATE_BUILD","Validate a future local build.",undefined,undefined,false,true],
  ["UPLOAD_FILES","Transfer generated site files.",undefined,undefined,true,false],
  ["RESTART_SERVICE","Restart the website service.",undefined,undefined,true,false],
  ["INVALIDATE_CACHE","Invalidate any remote cache.",undefined,undefined,true,false],
  ["VERIFY_PUBLIC_URL","Check the public URL after a future authorized deployment.",undefined,suggestedUrl,true,false],
 ] as const;
 const operations:WebsitePublicationOperation[]=operationRows.map(([code,description,sourcePath,destinationPath,remote,localExecution],position)=>({position,code,description,...(sourcePath?{sourcePath}:{}),...(destinationPath?{destinationPath}:{}),condition:remote?"DRY_RUN_REMOTE_BLOCK":"TARGET_INSPECTION_REQUIRED",required:remote,localExecution,remote,status:remote?"BLOCKED_IN_DRY_RUN":"REQUIRES_TARGET_INSPECTION"}));
 const prerequisiteRows=[
  ["DOMAIN_DNS_CONFIGURATION_PENDING","Registro.br DNS zone configuration is pending."],
  ["DOMAIN_PROPAGATION_PENDING","DNS propagation has not been verified."],
  ["HTTPS_NOT_YET_VERIFIED","HTTPS for the canonical domain has not been verified."],
  ["CANONICAL_DOMAIN_NOT_YET_ACTIVE","The canonical domain is configured for planning only."],
  ["WEBSITE_SOURCE_PATH_UNKNOWN","Website source path is unknown."],
  ["WEBSITE_FRAMEWORK_UNKNOWN","Website framework is unknown."],
  ["CONTENT_STRATEGY_UNKNOWN","Website content strategy is unknown."],
  ["CONTENT_DIRECTORY_UNKNOWN","Website content directory is unknown."],
  ["ROUTE_PATTERN_UNKNOWN","Website route pattern is unknown."],
  ["BUILD_COMMAND_UNKNOWN","Website build command is unknown."],
  ["DEPLOY_METHOD_UNKNOWN","Deployment method is unknown."],
  ["REMOTE_TARGET_UNKNOWN","Remote target is unknown; no credential is requested."],
  ["BACKUP_STRATEGY_UNKNOWN","Backup strategy is unknown."],
  ["ROLLBACK_STRATEGY_UNKNOWN","Rollback strategy is unknown."],
  ["LEGACY_DOMAIN_REDIRECT_UNPLANNED","Canonical redirect from the legacy technical domain is not planned."],
 ] as const;
 const prerequisites:WebsitePublicationPrerequisite[]=prerequisiteRows.map(([code,description])=>({code,description,required:true,status:"PENDING"}));
 return {planId:`website-plan-${fingerprint.slice(0,24)}`,publicationId:source.pkg.publicationId,newsId:source.pkg.newsId,draftId:source.pkg.draftId,draftVersion:source.pkg.draftVersion,mode:"DRY_RUN",targetProfileId:profile.targetId,profileVersion:profile.profileVersion,publicBaseUrl:profile.publicBaseUrl,...(profile.legacyTechnicalBaseUrl?{legacyTechnicalBaseUrl:profile.legacyTechnicalBaseUrl}:{}),policyId:WEBSITE_PUBLICATION_POLICY.id,policyVersion:WEBSITE_PUBLICATION_POLICY.version,sourceFiles:source.files.map(x=>({...x})),destinationFiles,slug,packageContentHash:source.pkg.contentHash,functionalFingerprint:fingerprint,status:"DRY_RUN_COMPLETED",validationStatus:"VALID_WITH_WARNINGS",provisionalPublicUrl:suggestedUrl,detectedPlatform:"UNKNOWN",publicationStrategy:profile.publicationMode,contentDirectory:profile.contentDirectory,routePattern:profile.routePattern,requiresBuild:profile.requiresBuild,requiresRestart:profile.requiresRestart,operations,prerequisites,warnings:["PROVISIONAL_PUBLIC_URL","ROUTE_PATTERN_UNCONFIRMED","WEBSITE_PLATFORM_UNKNOWN","CONTENT_STRATEGY_UNKNOWN","DNS_CONFIGURATION_PENDING","HTTPS_NOT_YET_VERIFIED","NO_REMOTE_ACTION_EXECUTED"],createdAt:input.createdAt};
}

export class WebsitePublicationPlanningService {
 private readonly repo:WebsitePublicationPlanRepository;private readonly reader:LocalWebsitePublicationPackageReader;private readonly profile:WebsiteTargetProfile;
 constructor(repo:WebsitePublicationPlanRepository,reader:LocalWebsitePublicationPackageReader,profile:WebsiteTargetProfile=ANDRESTUDIO_WEBSITE_PROFILE){this.repo=repo;this.reader=reader;this.profile=profile}
 listReadyPackages(){return this.repo.listReadyPackages()}
 getPlan(id:string){return this.repo.get(id)}
 listPlans(){return this.repo.list()}
 async createDryRunPlan(input:{publicationId:string;targetId?:string;mode:WebsitePublicationMode;createdAt:string;idempotencyKey:string;commandId:string}){
  if(input.mode==="LIVE")throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_LIVE_MODE_DISABLED","Live website publication is disabled.");
  if(input.targetId&&input.targetId!==this.profile.targetId)throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_TARGET_NOT_SUPPORTED","Website target is not registered.");
  const prior=await this.repo.findByIdempotency(input.idempotencyKey);if(prior){if(prior.publicationId!==input.publicationId||prior.mode!==input.mode||prior.targetProfileId!==this.profile.targetId||prior.profileVersion!==this.profile.profileVersion||prior.publicBaseUrl!==this.profile.publicBaseUrl)throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_IDEMPOTENCY_CONFLICT","Idempotency key conflict.");return {plan:prior,replayed:true}}
  const source=await this.repo.loadReadyPackage(input.publicationId);if(!source)throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_PACKAGE_NOT_READY","Ready website package not found.");
  await this.reader.validate(source);return this.repo.save({plan:buildWebsitePublicationPlan(source,input,this.profile),idempotencyKey:input.idempotencyKey,commandId:input.commandId});
 }
 async inspectLocalWebsite(root:string):Promise<{root:string;detectedPlatform:"UNKNOWN";files:number;hasPackageJson:boolean;warnings:string[]}>{
  if(!root||root.split(/[\\/]/).includes(".."))throw new WebsitePublicationPlanningError("WEBSITE_INSPECTION_PATH_INVALID","Explicit traversal-free local path required.");const requested=resolve(root),stat=await lstat(requested).catch(()=>undefined);if(!stat?.isDirectory()||stat.isSymbolicLink())throw new WebsitePublicationPlanningError("WEBSITE_INSPECTION_PATH_INVALID","Directory must exist and cannot be a symlink.");const actual=await realpath(requested);if(actual===resolve(".")||actual==="/")throw new WebsitePublicationPlanningError("WEBSITE_INSPECTION_PATH_INVALID","Broad project paths are forbidden.");
  let files=0,hasPackageJson=false;const walk=async(dir:string,depth:number):Promise<void>=>{if(depth>4)return;for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name.startsWith(".")||["node_modules","dist"].includes(entry.name))continue;const path=resolve(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await walk(path,depth+1);else if(entry.isFile()){files++;if(files>500)throw new WebsitePublicationPlanningError("WEBSITE_INSPECTION_LIMIT_EXCEEDED","Inspection file limit exceeded.");if(basename(path)==="package.json"){hasPackageJson=true;const size=(await lstat(path)).size;if(size>100_000)throw new WebsitePublicationPlanningError("WEBSITE_INSPECTION_LIMIT_EXCEEDED","package.json is too large.");JSON.parse(await readFile(path,"utf8"))}}};};await walk(actual,0);return {root:actual,detectedPlatform:"UNKNOWN",files,hasPackageJson,warnings:["READ_ONLY_INSPECTION","NO_COMMAND_EXECUTED"]};
 }
}

export class InMemoryWebsitePublicationPlanRepository implements WebsitePublicationPlanRepository {
 private plans=new Map<string,WebsitePublicationPlan>();private keys=new Map<string,string>();
 private readonly packages:ReadyWebsitePackage[];constructor(packages:ReadyWebsitePackage[]){this.packages=packages}
 async listReadyPackages(){return this.packages.filter(x=>x.pkg.destination==="WEBSITE_EXPORT"&&x.pkg.status==="READY_FOR_PUBLICATION")}
 async loadReadyPackage(id:string){return (await this.listReadyPackages()).find(x=>x.pkg.publicationId===id)}
 async findByIdempotency(key:string){const id=this.keys.get(key);return id?this.plans.get(id):undefined}
 async save(input:{plan:WebsitePublicationPlan;idempotencyKey:string;commandId:string}){const prior=await this.findByIdempotency(input.idempotencyKey);if(prior){if(prior.functionalFingerprint!==input.plan.functionalFingerprint)throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_IDEMPOTENCY_CONFLICT","Idempotency key conflict.");return {plan:prior,replayed:true}}const conflict=this.plans.get(input.plan.planId);if(conflict&&conflict.functionalFingerprint!==input.plan.functionalFingerprint)throw new WebsitePublicationPlanningError("WEBSITE_PUBLICATION_PLAN_CONFLICT","Plan conflict.");this.plans.set(input.plan.planId,input.plan);this.keys.set(input.idempotencyKey,input.plan.planId);return {plan:input.plan,replayed:false}}
 async get(id:string){return this.plans.get(id)}
 async list(){return [...this.plans.values()]}
}
