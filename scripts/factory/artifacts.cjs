const { SHA } = require("./policy.cjs");
const MAX_FILE = 200000;
const MAX_TOTAL = 500000;
function secretLike(text) {
  return /sk-(?:ant-(?:api|oat|sid)\d*-|proj-)[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:postgres(?:ql)?):\/\/[^\s/:]+:[^\s@]+@(?!localhost[:/]|127\.0\.0\.1[:/])[^\s]+/i.test(
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
function validateChanges(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 50)
    throw new Error("Invalid patch size");
  let total = 0;
  const seen = new Set();
  for (const file of files) {
    if (!validPath(file.path) || seen.has(file.path.toLowerCase()))
      throw new Error("Forbidden or duplicate patch path/policy change");
    seen.add(file.path.toLowerCase());
    if (file.deleted === true) {
      if (file.content !== undefined) throw new Error("Invalid deleted file");
      continue;
    }
    if (file.mode !== "100644" || typeof file.content !== "string")
      throw new Error("Only regular text files may be published");
    const size = Buffer.byteLength(file.content);
    total += size;
    if (size > MAX_FILE || total > MAX_TOTAL) throw new Error("Generated patch exceeds size limit");
    if (file.content.includes("\0") || file.content.includes("\uFFFD"))
      throw new Error("Generated patch is binary or invalid UTF-8");
    if (secretLike(file.content)) throw new Error("Generated patch contains secret-like content");
  }
  return files;
}
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
    summary: { type: "string", minLength: 1, maxLength: 5000 },
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message"],
        properties: {
          severity: { enum: ["critical", "important", "minor"] },
          message: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
  },
};
module.exports = { validPath, validateChanges, validateReview, secretLike, REVIEW_SCHEMA };
