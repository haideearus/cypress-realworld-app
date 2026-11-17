const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { docker, sandbox, safeEnv } = require("../factory/discovery-sandbox.cjs");
test(
  "isolated seeded-defect intake preserves original RED and distinguishes a real fixed baseline",
  {
    skip: process.env.FACTORY_DISCOVERY_DOCKER_TEST !== "true",
    timeout: 180000,
  },
  async () => {
    const fx = require("./helpers/finding-fixtures.cjs"),
      f = require("../factory/discovery-finding-contract.cjs");
    const { replayForIntake } = require("../factory/discovery-intake.cjs");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-intake-fixture-"));
    try {
      const bundle = fx.evidence(),
        candidate = f.candidateFromEvidence(bundle, 0, fx.artifact, fx.proof());
      const outcomes = [];
      for (const fixed of [false, true]) {
        const build = path.join(root, fixed ? "green" : "red");
        fs.mkdirSync(path.join(build, "trusted"), { recursive: true });
        fs.copyFileSync(
          path.resolve(__dirname, "../factory/discovery-oracles.cjs"),
          path.join(build, "trusted/oracles.cjs")
        );
        fs.writeFileSync(
          path.join(build, "Dockerfile"),
          `FROM node:22.20.0-alpine@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af\nCOPY trusted/ /trusted/\n`
        );
        fs.writeFileSync(
          path.join(build, "trusted/entry.cjs"),
          `const role=process.argv[2],fs=require('node:fs');if(role==='app')require('node:http').createServer((q,r)=>{r.statusCode=q.url==='/users'?${fixed ? 401 : 200}:200;r.end('{}');}).listen(3001,'0.0.0.0');else if(role==='health')fetch('http://127.0.0.1:3001').catch(()=>process.exitCode=1);else(async()=>{if(process.env.GH_TOKEN||process.env.CLAUDE_CODE_OAUTH_TOKEN)throw Error('credential inherited');const r=await fetch('http://app:3001/users');if(role==='oracle')console.log(JSON.stringify(require('/trusted/oracles.cjs').observe(JSON.parse(fs.readFileSync('/oracle-request.json','utf8')),r.status,await r.json())));else {console.log('seeded protected-route check');process.exitCode=r.status===401?0:1;}})().catch(()=>process.exitCode=1);`
        );
        const built = await docker(["build", "--iidfile", path.join(build, "id"), build], {
          env: safeEnv(),
          timeout: 120000,
        });
        assert.equal(built.code, 0);
        const image = fs.readFileSync(path.join(build, "id"), "utf8").trim();
        const result = await replayForIntake({
          candidate,
          bundle,
          image,
          tests: path.join(build, "tests"),
        });
        outcomes.push(result.outcome);
        assert.equal(result.originalRedHash, candidate.redLogHash);
      }
      assert.deepEqual(outcomes, ["ready", "observed-resolved"]);
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("discovery-intake-fixture-"));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
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
