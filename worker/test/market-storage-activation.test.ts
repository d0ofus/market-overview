import { describe,expect,it,vi } from "vitest";
import { verifyStoragePublicBindings } from "../src/market-storage-activation";
const identity={id:"market-storage:test",sourceDatabaseId:"10000000-0000-4000-8000-000000000001",
  targetDatabaseId:"10000000-0000-4000-8000-000000000002",historyDatabaseId:"10000000-0000-4000-8000-000000000003",sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
const ops="10000000-0000-4000-8000-000000000004";
const deploymentId="10000000-0000-4000-8000-000000000005",servingVersionId="10000000-0000-4000-8000-000000000006";
const otherVersionId="10000000-0000-4000-8000-000000000007";
const bindings=()=>[
  {name:"MARKET_DATA_DB",type:"d1",id:identity.targetDatabaseId},{name:"MARKET_HISTORY_DB",type:"d1",database_id:identity.historyDatabaseId},
  {name:"OPS_DB",type:"d1",id:ops},...Object.entries({EOD_RUNNER_MODE:"active",EOD_READ_ENABLED:"true",EOD_CODE_REVISION:identity.codeRevision,EOD_STORAGE_MIGRATION_ID:identity.id})
    .map(([name,text])=>({name,type:"plain_text",text})),
];
const args=()=>({accountId:"b".repeat(32),token:"test-token",workerName:"market-command-worker",identity,opsDatabaseId:ops,
  githubMarketDatabaseId:identity.targetDatabaseId,githubRunnerMode:"active"});
const deployment=()=>({id:deploymentId,created_on:"2026-09-09T14:04:00.541962Z",strategy:"percentage",
  versions:[{version_id:servingVersionId,percentage:100}]});
const envelope=(result:unknown)=>Response.json({success:true,errors:[],result});
function fetcherFor(input:{bindings?:unknown;deployments?:unknown;versionId?:string}={}) {
  return vi.fn<typeof fetch>().mockImplementation(async(url)=>{
    if(String(url).endsWith("/deployments")) return envelope({deployments:input.deployments??[deployment()]});
    if(String(url).endsWith(`/versions/${servingVersionId}`)) return envelope({id:input.versionId??servingVersionId,
      resources:{bindings:input.bindings??bindings()}});
    throw new Error("Unexpected API path");
  });
}
describe("actual public binding verification",()=>{
  it("accepts matching deployed and GitHub bindings, including documented D1 id variants",async()=>{
    const fetcher=fetcherFor();
    const result=await verifyStoragePublicBindings({...args(),fetcher});
    expect(result.marketDatabaseId).toBe(identity.targetDatabaseId);expect(JSON.stringify(result)).not.toContain("test-token");
    expect(result).toMatchObject({versionId:servingVersionId,deploymentId});
    expect(fetcher.mock.calls.map(([url])=>String(url).split("/market-command-worker/")[1]))
      .toEqual(["deployments",`versions/${servingVersionId}`,"deployments"]);
  });
  it("rejects stale GitHub before fetching production settings",async()=>{
    const fetcher=vi.fn<typeof fetch>();await expect(verifyStoragePublicBindings({...args(),githubMarketDatabaseId:identity.sourceDatabaseId,fetcher})).rejects.toThrow("github-bindings-mismatch");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies actual enabled pruning for canonical production configuration",async()=>{
    const enabled=[...bindings(),{name:"EOD_ARCHIVE_PRUNE_ENABLED",type:"plain_text",text:"true"}];
    expect(await verifyStoragePublicBindings({...args(),expectedArchivePruneEnabled:true,fetcher:fetcherFor({bindings:enabled})}))
      .toMatchObject({archivePruneEnabled:true});
    await expect(verifyStoragePublicBindings({...args(),expectedArchivePruneEnabled:true,
      fetcher:fetcherFor({bindings:enabled.map(row=>row.name==="EOD_ARCHIVE_PRUNE_ENABLED"?{...row,text:"false"}:row)})}))
      .rejects.toThrow("public-prune-mismatch");
    await expect(verifyStoragePublicBindings({...args(),expectedArchivePruneEnabled:true,fetcher:fetcherFor()}))
      .rejects.toThrow("binding-missing-or-ambiguous");
  });
  it("rejects stale source, disabled public reads, and ambiguous bindings",async()=>{
    for(const wrong of [bindings().map(row=>row.name==="MARKET_DATA_DB"?{...row,id:identity.sourceDatabaseId}:row),
      bindings().map(row=>row.name==="EOD_READ_ENABLED"?{...row,text:"false"}:row),[...bindings(),bindings()[0]]]) {
      await expect(verifyStoragePublicBindings({...args(),fetcher:fetcherFor({bindings:wrong})})).rejects.toThrow("storage-activation-");
    }
  });
  it("cannot certify a staged upload through /settings while the serving version still uses the source",async()=>{
    const stale=bindings().map(row=>row.name==="MARKET_DATA_DB"?{...row,id:identity.sourceDatabaseId}:row);
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async(url)=>{
      if(String(url).endsWith("/settings")) return envelope({bindings:bindings()});
      if(String(url).endsWith("/deployments")) return envelope({deployments:[deployment()]});
      if(String(url).endsWith(`/versions/${servingVersionId}`)) return envelope({id:servingVersionId,resources:{bindings:stale}});
      return envelope({id:otherVersionId,resources:{bindings:bindings()}});
    });
    await expect(verifyStoragePublicBindings({...args(),fetcher})).rejects.toThrow("public-bindings-mismatch");
    expect(fetcher.mock.calls.some(([url])=>String(url).endsWith("/settings"))).toBe(false);
  });
  it.each([1,50,99.99,100])("rejects mixed or zero-traffic companion deployment with first percentage %s",async(percentage)=>{
    const active={...deployment(),versions:[{version_id:servingVersionId,percentage},{version_id:otherVersionId,percentage:100-percentage}]};
    const fetcher=fetcherFor({deployments:[active]});
    await expect(verifyStoragePublicBindings({...args(),fetcher})).rejects.toThrow("deployment-not-exclusive");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not search older deployments for a matching 100% version",async()=>{
    const active={...deployment(),versions:[{version_id:otherVersionId,percentage:50}]};
    await expect(verifyStoragePublicBindings({...args(),fetcher:fetcherFor({deployments:[active,deployment()]})})).rejects.toThrow("deployment-not-exclusive");
  });
  it.each(["MARKET_DATA_DB","MARKET_HISTORY_DB","OPS_DB","EOD_RUNNER_MODE","EOD_READ_ENABLED","EOD_CODE_REVISION","EOD_STORAGE_MIGRATION_ID"])(
    "rejects wrong serving-version %s",async(name)=>{
      const wrong=bindings().map(row=>row.name!==name?row:row.type==="d1"
        ?{...row,id:identity.sourceDatabaseId,database_id:identity.sourceDatabaseId}:{...row,text:"wrong"});
      await expect(verifyStoragePublicBindings({...args(),fetcher:fetcherFor({bindings:wrong})})).rejects.toThrow("public-bindings-mismatch");
    });
  it("rejects missing or conflicting database bindings",async()=>{
    for(const wrong of [bindings().slice(1),bindings().map(row=>row.name==="MARKET_DATA_DB"?{...row,database_id:identity.sourceDatabaseId}:row)]) {
      await expect(verifyStoragePublicBindings({...args(),fetcher:fetcherFor({bindings:wrong})})).rejects.toThrow("storage-activation-binding-");
    }
  });
  it("rejects a changed active deployment between version verification and final confirmation",async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(envelope({deployments:[deployment()]}))
      .mockResolvedValueOnce(envelope({id:servingVersionId,resources:{bindings:bindings()}}))
      .mockResolvedValueOnce(envelope({deployments:[{...deployment(),id:"10000000-0000-4000-8000-000000000008"}]}));
    await expect(verifyStoragePublicBindings({...args(),fetcher})).rejects.toThrow("deployment-changed-during-verification");
  });
  it.each([401,403,429,503])("fails closed on deployment API HTTP %s without leaking the body",async(status)=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response("private response and test-token",{status}));
    await expect(verifyStoragePublicBindings({...args(),fetcher})).rejects.toThrow("storage-activation-worker-deployments-unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("fails closed when version authentication or deployment recheck fails",async()=>{
    for(const failedAt of ["version","recheck"]) {
      const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(envelope({deployments:[deployment()]}));
      if(failedAt==="recheck") fetcher.mockResolvedValueOnce(envelope({id:servingVersionId,resources:{bindings:bindings()}}));
      fetcher.mockResolvedValueOnce(new Response("private",{status:403}));
      await expect(verifyStoragePublicBindings({...args(),fetcher})).rejects.toThrow(`worker-${failedAt==="version"?"version":"deployments"}-unavailable`);
    }
  });
  it("sanitizes network/JSON failures and rejects malformed success envelopes",async()=>{
    const failed=vi.fn<typeof fetch>().mockRejectedValue(new Error("network included test-token"));
    await expect(verifyStoragePublicBindings({...args(),fetcher:failed})).rejects.toThrow("worker-deployments-unavailable");
    for(const response of [new Response("not JSON"),Response.json({success:"true",result:{deployments:[deployment()]}}),
      Response.json({success:true,errors:[{message:"partial private error"}],result:{deployments:[deployment()]}})]) {
      await expect(verifyStoragePublicBindings({...args(),fetcher:vi.fn<typeof fetch>().mockResolvedValue(response)})).rejects.toThrow("worker-deployments-invalid");
    }
  });
  it("rejects a mismatching version response and non-array or invalid bindings",async()=>{
    await expect(verifyStoragePublicBindings({...args(),fetcher:fetcherFor({versionId:otherVersionId})})).rejects.toThrow("deployed-version-invalid");
    for(const wrong of [{bindings:bindings()},[null],"invalid"]) {
      await expect(verifyStoragePublicBindings({...args(),fetcher:fetcherFor({bindings:wrong})})).rejects.toThrow("deployed-version-invalid");
    }
  });
  it("rejects malformed active deployment identity before constructing a version path",async()=>{
    for(const current of [{...deployment(),id:"invalid"},{...deployment(),created_on:"not-date"},
      {...deployment(),versions:[{version_id:"../../settings",percentage:100}]}]) {
      const fetcher=fetcherFor({deployments:[current]});
      await expect(verifyStoragePublicBindings({...args(),fetcher})).rejects.toThrow("storage-activation-");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
