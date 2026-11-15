import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const readiness = require("../../backend/factory-drill/readiness.cjs");

describe("isolated readiness contract", () => {
  it("reports ready when the dependency is available", () => {
    expect(readiness(true)).toEqual({ statusCode: 200, body: { status: "ok" } });
  });
  it.each([false, undefined])("fails closed for an unavailable dependency: %s", (available) => {
    expect(readiness(available)).toEqual({ statusCode: 503, body: { status: "unavailable" } });
  });
});
