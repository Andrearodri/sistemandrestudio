import {parseArgs} from "node:util";
import {ANDRESTUDIO_WEBSITE_PROFILE,LocalWebsitePublicationPackageReader,WebsitePublicationPlanningService,type WebsitePublicationMode} from "../../../packages/application/src/index.ts";
import {createDatabasePool,loadDatabaseConfig,PostgresWebsitePublicationPlanRepository} from "../../../packages/database/src/index.ts";

const action=process.argv[2];
const {values}=parseArgs({args:process.argv.slice(3),options:{publication:{type:"string"},target:{type:"string"},plan:{type:"string"},mode:{type:"string"},path:{type:"string"}},strict:true});
const pool=createDatabasePool(loadDatabaseConfig()),service=new WebsitePublicationPlanningService(new PostgresWebsitePublicationPlanRepository(pool),new LocalWebsitePublicationPackageReader("output"));
try{
 if(action==="list-ready"){const rows=await service.listReadyPackages();for(const x of rows)console.log(`${x.pkg.publicationId} | ${x.pkg.title} | ${x.pkg.status}`);if(!rows.length)console.log("Nenhum pacote WEBSITE_EXPORT pronto.")}
 else if(action==="plan"){if(!values.publication)throw new Error("WEBSITE_PUBLICATION_INPUT_INVALID");const mode=(values.mode??"DRY_RUN") as WebsitePublicationMode,targetId=values.target??ANDRESTUDIO_WEBSITE_PROFILE.targetId,key=`website-plan:${values.publication}:${targetId}:${ANDRESTUDIO_WEBSITE_PROFILE.profileVersion}`;console.log(JSON.stringify(await service.createDryRunPlan({publicationId:values.publication,targetId,mode,createdAt:new Date().toISOString(),idempotencyKey:key,commandId:key}),null,2))}
 else if(action==="show"){if(!values.plan)throw new Error("WEBSITE_PUBLICATION_INPUT_INVALID");console.log(JSON.stringify(await service.getPlan(values.plan),null,2))}
 else if(action==="list"){console.log(JSON.stringify(await service.listPlans(),null,2))}
 else if(action==="inspect-local"){if(!values.path)throw new Error("WEBSITE_INSPECTION_PATH_INVALID");console.log(JSON.stringify(await service.inspectLocalWebsite(values.path),null,2))}
 else throw new Error("WEBSITE_PUBLICATION_COMMAND_INVALID");
}finally{await pool.end()}
