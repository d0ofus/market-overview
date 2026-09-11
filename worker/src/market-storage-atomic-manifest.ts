/** D1 limits each string/BLOB to2 MB and each statement to100 parameters.
 * Keep all comparisons in one atomic guard while paging the unchanged feature
 * payloads. The full transaction still has its independent8 MB envelope. */
export function storageFeatureCheckpointComparison(features: readonly unknown[], runId: string): {sql:string;params:unknown[]} {
  const pages:string[]=[],limit=1_000_000;
  let page:unknown[]=[];
  for(const feature of features) {
    if(new TextEncoder().encode(JSON.stringify([feature])).length>limit)throw new Error("storage-feature-manifest-row-too-large");
    const candidate=[...page,feature];
    if(page.length===25||new TextEncoder().encode(JSON.stringify(candidate)).length>limit){pages.push(JSON.stringify(page));page=[];}
    page.push(feature);
  }
  if(page.length)pages.push(JSON.stringify(page));
  if(pages.length>32)throw new Error("storage-feature-manifest-page-bound");
  return {sql:pages.map(()=>`AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN eod_checkpoints actual ON actual.run_id=? AND actual.chunk_key=json_extract(expected.value,'$.chunk_key')
    WHERE actual.chunk_key IS NULL OR actual.input_hash<>json_extract(expected.value,'$.input_hash') OR actual.payload_json<>json_extract(expected.value,'$.payload_json') OR actual.updated_at<>json_extract(expected.value,'$.updated_at'))`).join("\n"),params:pages.flatMap(page=>[page,runId])};
}
export function assertStorageAtomicParameters(queries:readonly {sql:string;params:readonly unknown[]}[]):void {
  for(const query of queries)if(query.params.length>100||new TextEncoder().encode(query.sql).length>100_000
    ||query.params.some(value=>typeof value==="string"&&new TextEncoder().encode(value).length>2_000_000))throw new Error("storage-atomic-parameter-bound-exceeded");
}
