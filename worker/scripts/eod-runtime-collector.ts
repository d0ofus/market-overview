import { writeFile } from "node:fs/promises";
import { collectRuntimeEvidence } from "../src/eod-runtime-evidence";

const required=(key:string):string=>{const value=process.env[key]?.trim();if(!value)throw new Error(`Missing ${key}`);return value;};
try {
  const artifact=await collectRuntimeEvidence({accountId:required("CLOUDFLARE_ACCOUNT_ID"),token:required("CLOUDFLARE_API_TOKEN"),
    identity:{probeId:required("EOD_RUNTIME_PROBE_ID"),workerName:required("EOD_RUNTIME_WORKER_NAME"),workerVersion:required("EOD_RUNTIME_WORKER_VERSION"),
      codeRevision:required("EOD_CODE_REVISION"),targetDatabaseId:required("EOD_RUNTIME_TARGET_DATABASE_ID"),
      historyDatabaseId:required("EOD_RUNTIME_HISTORY_DATABASE_ID"),opsDatabaseId:required("EOD_RUNTIME_OPS_DATABASE_ID"),
      coreDatabaseId:required("EOD_RUNTIME_CORE_DATABASE_ID")},
    from:Date.parse(required("EOD_RUNTIME_FROM")),to:Date.parse(required("EOD_RUNTIME_TO"))});
  await writeFile(required("EOD_RUNTIME_EVIDENCE_PATH"),JSON.stringify(artifact,null,2)+"\n",{encoding:"utf8",flag:"wx"});
  console.log(JSON.stringify({complete:artifact.complete,evidenceHash:artifact.evidenceHash,samples:artifact.samples.length,
    measurements:artifact.measurements,unavailableReasons:artifact.unavailableReasons}));
  if(!artifact.complete)process.exitCode=2;
} catch(error) {
  console.error(error instanceof Error?error.message:"Runtime evidence collection failed.");process.exitCode=1;
}
