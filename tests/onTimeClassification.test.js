import test from "node:test";
import assert from "node:assert/strict";
import { classifyDeviation, ON_TIME_TOLERANCE_MIN } from "../src/services/onTimeClassification.js";

test("ON_TIME_TOLERANCE_MIN is 15", () => {
  assert.equal(ON_TIME_TOLERANCE_MIN, 15);
});

test("classifyDeviation: within the tolerance band (inclusive) is on_time", () => {
  assert.equal(classifyDeviation(0), "on_time");
  assert.equal(classifyDeviation(15), "on_time");
  assert.equal(classifyDeviation(-15), "on_time");
  assert.equal(classifyDeviation(7.4), "on_time");
});

test("classifyDeviation: just outside the boundary is early/late", () => {
  assert.equal(classifyDeviation(15.0001), "late");
  assert.equal(classifyDeviation(-15.0001), "early");
  assert.equal(classifyDeviation(200), "late");
  assert.equal(classifyDeviation(-200), "early");
});

test("classifyDeviation: null/undefined/non-finite -> null", () => {
  assert.equal(classifyDeviation(null), null);
  assert.equal(classifyDeviation(undefined), null);
  assert.equal(classifyDeviation(NaN), null);
  assert.equal(classifyDeviation(Infinity), null);
  assert.equal(classifyDeviation(-Infinity), null);
});
