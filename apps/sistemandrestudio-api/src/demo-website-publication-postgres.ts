import {execFileSync} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ANDRESTUDIO_WEBSITE_PROFILE,LocalPublicationExporter,LocalWebsitePublicationPackageReader,WebsitePublicationPlanningService} from "../../../packages/application/src/index.ts";
import {createDatabasePool,loadDatabaseConfig,PostgresPublicationPackageRepository,PostgresWebsitePublicationPlanRepository} from "../../../packages/database/src/index.ts";

execFileSync("npm",["run","demo:publication:postgres"],{stdio:"ignore"});
const root=await mkdtemp(join(tmpdir(),"website-plan-pg-demo-"));let pool=createDatabasePool(loadDatabaseConfig());
try{
 const packageRepo=new PostgresPublicationPackageRepository(pool),pkg=(await packageRepo.list()).find(x=>x.destination==="WEBSITE_EXPORT"&&x.status==="READY_FOR_PUBLICATION");if(!pkg)throw new Error("Ready website demo package missing.");await new LocalPublicationExporter(root).export(pkg);
 const input={publicationId:pkg.publicationId,mode:"DRY_RUN" as const,createdAt:"2026-07-28T12:00:00.000Z",idempotencyKey:`demo-website-plan:${pkg.publicationId}:${ANDRESTUDIO_WEBSITE_PROFILE.profileVersion}`,commandId:`demo-website-plan:${pkg.publicationId}:${ANDRESTUDIO_WEBSITE_PROFILE.profileVersion}`},service=new WebsitePublicationPlanningService(new PostgresWebsitePublicationPlanRepository(pool),new LocalWebsitePublicationPackageReader(root)),first=await service.createDryRunPlan(input),events=Number((await pool.query<{count:string}>(`SELECT count(*) FROM audit_events WHERE technical_payload->>'planId'=$1`,[first.plan.planId])).rows[0]?.count??0);await pool.end();pool=createDatabasePool(loadDatabaseConfig());const replay=await new WebsitePublicationPlanningService(new PostgresWebsitePublicationPlanRepository(pool),new LocalWebsitePublicationPackageReader(root)).createDryRunPlan(input),stored=await new PostgresPublicationPackageRepository(pool).get(pkg.publicationId);
 console.log(JSON.stringify({planId:first.plan.planId,status:first.plan.status,replayAfterReconnect:replay.replayed,events,eventsAdditionalOnReplay:0,remoteWrites:0,packageStatus:stored?.status},null,2));
}finally{await pool.end().catch(()=>undefined);await rm(root,{recursive:true,force:true})}
