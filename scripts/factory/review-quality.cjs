const MIN_SUMMARY = 60;
const MIN_FINDING = 30;
// These are sample/approval filler, not terms prohibited in genuine explanations.
const FILLER = new Set(
  (
    "a an and as for in is it of on or that the this to was were with without " +
    "just only text test tests testing sample example placeholder dummy review summary " +
    "finding findings message output result generated final structured json validation " +
    "no issue issues blocking blocker blockers pass passed ok okay lgtm looks look good fine todo tbd na"
  ).split(/\s+/)
);
function substantive(text, kind) {
  if (typeof text !== "string") return false;
  const normalized = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .trim();
  if (normalized.length < (kind === "summary" ? MIN_SUMMARY : MIN_FINDING)) return false;
  const words = normalized.toLowerCase().match(/[\p{L}][\p{L}\p{N}]*/gu) || [];
  if (
    /^(?:(?:this|it) (?:is|was)|here is|the following is) (?:(?:a|an|just|only|simple|dummy|sample|example|test|placeholder|mock|synthetic|fake|generic|fabricated|illustrative) )*(?:sample|example|test|placeholder|dummy|mock|synthetic|fake|fabricated) (?:review|response|summary|finding|message|output)\b/u.test(
      words.join(" ")
    )
  )
    return false;
  const unique = new Set(words.map((word) => word.replace(/\d+$/u, "")));
  return (
    words.length >= (kind === "summary" ? 8 : 5) &&
    unique.size >= (kind === "summary" ? 6 : 4) &&
    [...unique].filter((word) => !FILLER.has(word)).length >= 3
  );
}
module.exports = { MIN_SUMMARY, MIN_FINDING, substantive };
