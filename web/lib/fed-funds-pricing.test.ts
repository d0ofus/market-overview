import assert from "node:assert/strict";
import test from "node:test";
import { fedFundsPricingHeadline } from "./fed-funds-pricing";

test("missing probabilities are unavailable and zero directional pricing is not mislabeled zero no-change probability", () => {
  assert.equal(fedFundsPricingHeadline(null, false), "Unavailable");
  assert.equal(fedFundsPricingHeadline(Number.NaN, true), "Unavailable");
  assert.equal(fedFundsPricingHeadline(0, false), "NO MOVE PRICED");
  assert.equal(fedFundsPricingHeadline(72.4, true), "72% CUT");
  assert.equal(fedFundsPricingHeadline(28, false), "28% HIKE");
});
