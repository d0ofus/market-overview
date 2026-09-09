/** Local JSON-lines bridge for offline capacity analysis. No provider or D1 calls. */
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { decodeMarketHistoryBlock, encodeMarketHistoryBlock, type MarketHistoryBar, type MarketHistoryBlock } from "../src/market-history";

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    const request = JSON.parse(line) as { bars?: MarketHistoryBar[]; block?: MarketHistoryBlock };
    if (request.block) {
      process.stdout.write(`${JSON.stringify({ bars: await decodeMarketHistoryBlock(request.block) })}\n`);
    } else if (request.bars) {
      const block = await encodeMarketHistoryBlock(request.bars);
      const decoded = await decodeMarketHistoryBlock(block);
      process.stdout.write(`${JSON.stringify({ block, equal: isDeepStrictEqual(request.bars, decoded) })}\n`);
    } else throw new Error("Expected bars or an archive block.");
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "Archive codec failed." })}\n`);
  }
}
