const { SHA } = require("./policy.cjs");
const quality = require("./review-quality.cjs");
const MAX_FILE = 200000;
const MAX_TOTAL = 500000;
const COMPATIBILITY_BUNDLE_LIMIT = 6000000;
const DEPENDENCY_FILE_LIMITS = Object.freeze({ "package.json": 65536, "yarn.lock": 2000000 });
const COMPATIBILITY_SEED_PATHS = Object.freeze([
  "scripts/generateSeedData.ts",
  "scripts/seedDataUtils.ts",
]);
function secretLike(text) {
  return /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|sk-(?:ant-(?:api|oat|sid)\d*-|proj-)[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:postgres(?:ql)?):\/\/[^\s/:]+:[^\s@]+@(?!localhost[:/]|127\.0\.0\.1[:/])[^\s]+/i.test(
    text
  );
}
function validPath(path) {
  if (
    typeof path !== "string" ||
    path.length > 240 ||
    /[\\\0\r\n]/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    return false;
  const lower = path.toLowerCase();
  if (
    path.split("/").some((p) => /^\.|^(?:agents|claude)\.md$/i.test(p)) ||
    lower.startsWith("scripts/tests/factory-") ||
    lower.startsWith("scripts/tests/helpers/factory-")
  )
    return false;
  return (
    /^(?:src\/|backend\/|cypress\/tests\/|scripts\/tests\/)/.test(path) || path === "README.md"
  );
}
function compatibilityArtifactPath(name) {
  return (
    typeof name === "string" &&
    (Object.hasOwn(DEPENDENCY_FILE_LIMITS, name) ||
      COMPATIBILITY_SEED_PATHS.includes(name) ||
      (name !== "README.md" && validPath(name)))
  );
}
function artifactFileLimit(name, compatibility = false) {
  return compatibility && Object.hasOwn(DEPENDENCY_FILE_LIMITS, name)
    ? DEPENDENCY_FILE_LIMITS[name]
    : MAX_FILE;
}
function validatePatch(files, compatibility) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 50)
    throw new Error("Invalid patch size");
  const allowedPath = compatibility ? compatibilityArtifactPath : validPath;
  let total = 0;
  const seen = new Set();
  for (const file of files) {
    if (!allowedPath(file?.path) || seen.has(file.path.toLowerCase()))
      throw new Error("Forbidden or duplicate patch path/policy change");
    seen.add(file.path.toLowerCase());
    const dependencyFile = compatibility && Object.hasOwn(DEPENDENCY_FILE_LIMITS, file.path);
    if (file.deleted === true) {
      if (dependencyFile) throw new Error("Forbidden dependency manifest or lockfile deletion");
      if (file.content !== undefined) throw new Error("Invalid deleted file");
      continue;
    }
    if (file.mode !== "100644" || typeof file.content !== "string")
      throw new Error("Only regular text files may be published");
    const size = Buffer.byteLength(file.content);
    if (!dependencyFile) total += size;
    if (size > artifactFileLimit(file.path, compatibility) || total > MAX_TOTAL)
      throw new Error("Generated patch exceeds size limit");
    if (file.content.includes("\0") || file.content.includes("\uFFFD"))
      throw new Error("Generated patch is binary or invalid UTF-8");
    if (secretLike(file.content)) throw new Error("Generated patch contains secret-like content");
  }
  return files;
}
const validateChanges = (files) => validatePatch(files, false);
const validateCompatibilityChanges = (files) => validatePatch(files, true);
function validateReview(value, head) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !SHA.test(head) ||
    value.head !== head ||
    Object.keys(value).some((k) => !["head", "verdict", "summary", "findings"].includes(k)) ||
    !["pass", "changes_requested"].includes(value.verdict) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    value.summary.length > 5000 ||
    secretLike(value.summary) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 20
  )
    throw new Error("Invalid independent review result");
  if (!quality.substantive(value.summary, "summary"))
    throw new Error("Invalid independent review summary: placeholder or insufficient explanation");
  for (const f of value.findings) {
    if (
      !f ||
      !["critical", "important", "minor"].includes(f.severity) ||
      typeof f.message !== "string" ||
      !f.message.trim() ||
      f.message.length > 2000 ||
      secretLike(f.message) ||
      Object.keys(f).some((k) => !["severity", "message"].includes(k))
    )
      throw new Error("Invalid independent review finding");
    if (!quality.substantive(f.message, "finding"))
      throw new Error(
        "Invalid independent review finding: placeholder or insufficient explanation"
      );
  }
  if (value.verdict === "pass" && value.findings.some((f) => f.severity !== "minor"))
    throw new Error("Invalid passing review with blocking findings");
  return value;
}
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["head", "verdict", "summary", "findings"],
  properties: {
    head: { type: "string", pattern: "^[a-f0-9]{40}$" },
    verdict: { enum: ["pass", "changes_requested"] },
    summary: { type: "string", minLength: quality.MIN_SUMMARY, maxLength: 5000 },
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message"],
        properties: {
          severity: { enum: ["critical", "important", "minor"] },
          message: { type: "string", minLength: quality.MIN_FINDING, maxLength: 2000 },
        },
      },
    },
  },
};
module.exports = {
  validPath,
  validateChanges,
  validateReview,
  secretLike,
  REVIEW_SCHEMA,
  compatibilityArtifactPath,
  artifactFileLimit,
  validateCompatibilityChanges,
  COMPATIBILITY_SEED_PATHS,
  COMPATIBILITY_BUNDLE_LIMIT,
};
