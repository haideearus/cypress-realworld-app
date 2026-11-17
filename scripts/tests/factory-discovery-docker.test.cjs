const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { docker, sandbox, safeEnv } = require("../factory/discovery-sandbox.cjs");
test(
  "real Docker fixture enforces immutable source, credential-free tests and no public/host egress",
  { skip: process.env.FACTORY_DISCOVERY_DOCKER_TEST !== "true", timeout: 180000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-fixture-"));
    try {
      // Tiny deterministic fixture, not the application or Claude. No registry request at runtime.
      fs.mkdirSync(path.join(root, "trusted"));
      fs.writeFileSync(
        path.join(root, "Dockerfile"),
        `FROM node:22.20.0-alpine@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af\nCOPY trusted/ /trusted/\n`
      );
      fs.writeFileSync(
        path.join(root, "trusted", "entry.cjs"),
        `const fs=require('node:fs');const role=process.argv[2];if(role==='app')require('node:http').createServer((q,r)=>r.end('ok')).listen(3001,'0.0.0.0');else if(role==='health')fetch('http://127.0.0.1:3001').catch(()=>process.exitCode=1);else(async()=>{if(process.env.GH_TOKEN||process.env.CLAUDE_CODE_OAUTH_TOKEN)throw Error('credential inherited');try{fs.writeFileSync('/trusted/mutated','x');throw Error('writable source');}catch(e){if(e.message==='writable source')throw e;}let networkBlocked=false;try{await fetch('https://example.com',{signal:AbortSignal.timeout(2000)});}catch{networkBlocked=true;}if(!networkBlocked)throw Error('external egress');const r=await fetch('http://app:3001');if(await r.text()!=='ok')throw Error('internal app unavailable');console.log('isolated fixture verified');})().catch(()=>process.exitCode=1);`
      );
      const build = await docker(["build", "--iidfile", path.join(root, "id"), root], {
        env: safeEnv(),
        timeout: 120000,
      });
      assert.equal(build.code, 0);
      const image = fs.readFileSync(path.join(root, "id"), "utf8").trim();
      const tests = path.join(root, "tests");
      fs.mkdirSync(tests);
      fs.writeFileSync(path.join(tests, "fixture.api.test.cjs"), "// input never executed on host");
      const r = await sandbox({
        image,
        request: { mode: "api", file: "fixture.api.test.cjs" },
        tests,
      });
      assert.equal(r.code, 0);
      assert.match(r.log, /isolated fixture verified/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
