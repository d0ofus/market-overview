import assert from "node:assert/strict";
import { test } from "node:test";
import { applicableFedFundsSnapshot } from "./fed-funds-applicability";
import type { FedWatchResponse } from "./api";
const row=(meetingIso:string)=>({meeting:meetingIso,meetingIso,impliedRatePostMeeting:3.5,probMovePct:50,probIsCut:true,
  numMoves:0.5,numMovesIsCut:true,changeBps:-12.5});
const snapshot:FedWatchResponse={status:"stale",warning:"Historical probabilities",officialRates:{source:"New York Fed",sourceUrl:"official",
  effectiveDate:"2026-09-09",fetchedAt:"2026-09-11T04:00:00Z",effr:3.63,targetLower:3.5,targetUpper:3.75},data:{
  generatedAt:"2026-09-04T20:00:00Z",sourceUrl:"https://rateprobability.com/fed",asOf:"2026-09-04",currentBand:"3.50 - 3.75",
  midpoint:3.625,mostRecentEffr:3.63,assumedMoveBps:25,rows:[row("2026-09-16"),row("2026-12-09")],comparisons:[{
    key:"ago_1w",label:"One week ago",usedDate:"2026-08-28",effr:3.63,rows:[{meeting:"Sep16",meetingIso:"2026-09-16",implied:3.5}]}]}};
test("preserves dated September 4 probabilities while the September 16 meeting remains applicable",()=>{
  assert.equal(applicableFedFundsSnapshot(snapshot,Date.parse("2026-09-11T04:00:00Z")),snapshot);
  assert.equal(applicableFedFundsSnapshot(snapshot,Date.parse("2026-09-16T17:59:59Z")),snapshot);
});
test("removes elapsed rows and empty comparison curves when a page stays open through a decision",()=>{
  const current=applicableFedFundsSnapshot(snapshot,Date.parse("2026-09-16T18:00:00Z"));
  assert.deepEqual(current.data?.rows.map(item=>item.meetingIso),["2026-12-09"]);
  assert.deepEqual(current.data?.comparisons,[]);
  assert.equal(current.data?.asOf,"2026-09-04");
  assert.deepEqual(snapshot.data?.comparisons[0].rows.length,1);
});
test("honors New York winter time and keeps official facts when no probabilities remain",()=>{
  assert.ok(applicableFedFundsSnapshot(snapshot,Date.parse("2026-12-09T18:59:59Z")).data);
  const expired=applicableFedFundsSnapshot(snapshot,Date.parse("2026-12-09T19:00:00Z"));
  assert.equal(expired.data,null);assert.equal(expired.status,"unavailable");
  assert.equal(expired.officialRates,snapshot.officialRates);
  assert.match(expired.warning!,/have elapsed/);
});
