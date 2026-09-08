export type EodStoredPayload={payload:string;payloadCodec?:string|null;payloadBase64?:string|null};
const MAX_DECODED_BYTES=8_000_000;
async function bytes(stream:ReadableStream<Uint8Array>,limit:number):Promise<Uint8Array> {
  const reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    while (true) {const part=await reader.read();if(part.done)break;size+=part.value.length;
      if(size>limit) {await reader.cancel();throw new Error("publication-size-limit");}chunks.push(part.value);}
  } finally {reader.releaseLock();}
  const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;
}
export async function encodeEodPayload(value:unknown):Promise<{payloadCodec:string;payloadBase64:string}> {
  const json=JSON.stringify(value);const raw=new TextEncoder().encode(json);
  if(raw.length>MAX_DECODED_BYTES)throw new Error("publication-size-limit");
  const compressed=await bytes(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),1_100_000);
  let binary="";for(let i=0;i<compressed.length;i+=8192)binary+=String.fromCharCode(...compressed.subarray(i,i+8192));
  return {payloadCodec:"gzip-json-v1",payloadBase64:btoa(binary)};
}
export async function decodeEodPayload(row:EodStoredPayload):Promise<unknown> {
  if(!row.payloadCodec || row.payloadCodec==="json")return JSON.parse(row.payload);
  if(row.payloadCodec!=="gzip-json-v1" || !row.payloadBase64)throw new Error("publication-codec-unsupported");
  const compressed=Uint8Array.from(atob(row.payloadBase64),(character) => character.charCodeAt(0));
  const raw=await bytes(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),MAX_DECODED_BYTES);
  return JSON.parse(new TextDecoder().decode(raw));
}

/** Keep only bounded SQL-visible diagnostics; redundant price arrays and full
 * per-row metadata belong in the compressed immutable publication. */
export function eodPayloadSummary(value:unknown):string {
  const data=value as Record<string,unknown>;
  const keys=["status","asOfDate","generatedAt","universeId","methodologyVersion","membership","metrics",
    "coveragePct","requiredCoveragePct","publishable","sourceMix","freshnessStatus","freshnessCoveragePct","freshnessCurrentCount","freshnessEligibleCount",
    "advancers","decliners","unchanged","pctAbove20MA","pctAbove50MA","pctAbove200MA","new20DHighs","new20DLows",
    "medianReturn1D","medianReturn5D","volumeCollection","dataSource","provenance"];
  return JSON.stringify(Object.fromEntries(keys.filter((key) => data[key]!==undefined).map((key) => [key,data[key]])));
}
