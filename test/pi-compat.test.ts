import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupportedPiVersion } from "../src/pi-compat.ts";

test("host floor rejects old, malformed and pre-1.0 versions", () => {
  for (const version of ["0.83.0", "0.99.99", "1.0.0-rc.1", "1", "01.0.0", "garbage", "999999999999999999999.0.0"]) {
    assert.equal(isSupportedPiVersion(version), false, version);
  }
  for (const version of ["1.0.0", "1.0.0+build.1", "1.0.1", "1.1.0", "2.0.0"]) {
    assert.equal(isSupportedPiVersion(version), true, version);
  }
});
