import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../../src/price.js";

test("AC-01 total of 100.00 THB is 107.00 THB incl. VAT", () => assert.equal(total(10000), 10700));
