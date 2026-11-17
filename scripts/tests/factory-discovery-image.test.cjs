const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const s = require("../factory/discovery-sandbox.cjs");
const { buildImage } = require("../factory/discovery-worker.cjs");
test(
  "actual isolated app image starts offline and browser can log in through the unchanged API origin",
  { skip: process.env.FACTORY_DISCOVERY_IMAGE_TEST !== "true", timeout: 1500000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-image-smoke-"));
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const archive = execFileSync("git", ["archive", "--format=tar", head], {
        env: s.safeEnv(),
        maxBuffer: 64000000,
      });
      execFileSync("tar", ["-xf", "-", "-C", source], { env: s.safeEnv(), input: archive });
      const image = await buildImage(source, root, head);
      const tests = path.join(root, "tests");
      fs.mkdirSync(tests);
      fs.writeFileSync(
        path.join(tests, "health.api.test.cjs"),
        `const test=require('node:test');const assert=require('node:assert/strict');test('isolated real app health',async()=>{const response=await fetch(process.env.DISCOVERY_API_URL+'/healthz');assert.equal(response.status,200);});`
      );
      fs.writeFileSync(
        path.join(tests, "pagination.unit.test.ts"),
        `import {test,expect} from 'vitest';import {getPaginatedItems} from '../src/utils/transactionUtils';test('real source pagination import',()=>{expect(getPaginatedItems(2,2,[1,2,3,4,5])).toEqual({totalPages:3,data:[3,4]});});`
      );
      fs.writeFileSync(
        path.join(tests, "login.cy.ts"),
        `describe('isolated source login',()=>{it('uses sandbox app and API origin',()=>{cy.visit('/signin');cy.get('[data-test=signin-username]').find('input').type('Heath93');cy.get('[data-test=signin-password]').find('input').type('discovery-only-password');cy.get('[data-test=signin-submit]').click();cy.location('pathname',{timeout:20000}).should('equal','/');cy.request('http://localhost:3001/checkAuth').its('status').should('equal',200);});});`
      );
      const results = [];
      for (const request of [
        { mode: "api", file: "health.api.test.cjs" },
        { mode: "unit", file: "pagination.unit.test.ts" },
        { mode: "cypress", file: "login.cy.ts" },
      ]) {
        const result = await s.sandbox({ image, tests, request });
        // Bounded output is synthetic and contains no provider or live credentials.
        console.log(request.mode, result.code, result.exitState);
        if (result.code !== 0) console.log(result.log);
        console.log(
          result.log.split("\n").filter((line) => line.includes("Discovery resource summary:"))
        );
        results.push({ mode: request.mode, code: result.code });
      }
      assert.deepEqual(
        results,
        [
          { mode: "api", code: 0 },
          { mode: "unit", code: 0 },
          { mode: "cypress", code: 0 },
        ],
        "actual isolated API, unit or browser execution failed"
      );
      // Unmerged setup code runs only under uid1000 in a runtime overlay.
      const overlayFile = path.join(root, "repair-overlay.json");
      const setup =
        fs.readFileSync(path.join(source, "src/setup-tests.js"), "utf8") +
        `\nimport overlayFs from 'node:fs';for(const target of ['/trusted/oracles.cjs','/trusted/entry.cjs','/usr/local/bin/node']){let denied=false;try{overlayFs.writeFileSync(target,'forged verifier');}catch{denied=true;}if(!denied)throw Error('untrusted overlay replaced trusted image');}globalThis.__factoryOverlayLocked=true;\n`;
      fs.writeFileSync(
        overlayFile,
        JSON.stringify([
          { path: "src/setup-tests.js", mode: "100644", content: setup },
          {
            path: "src/discovery-overlay-marker.ts",
            mode: "100644",
            content: "export const marker='runtime-overlay';",
          },
        ])
      );
      fs.writeFileSync(
        path.join(tests, "overlay.unit.test.ts"),
        `import {it,expect} from 'vitest';import {marker} from '../src/discovery-overlay-marker';it('runtime overlay leaves trusted image immutable',()=>{expect(marker).toBe('runtime-overlay');expect(globalThis.__factoryOverlayLocked).toBe(true);});`
      );
      const overlay = await s.sandbox({
        image,
        tests,
        overlayFile,
        request: { mode: "unit", file: "overlay.unit.test.ts" },
      });
      if (overlay.code !== 0) console.log(overlay.log);
      assert.equal(overlay.code, 0, "unmerged source did not stay isolated from the trusted image");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
