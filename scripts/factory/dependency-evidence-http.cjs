class PublicEvidenceError extends Error {
  constructor(code, source) {
    super(`${source} evidence service unavailable`);
    this.code = code;
  }
}

function checkAvailability(response, source = "Public") {
  if ([502, 503, 504].includes(response.status))
    throw new PublicEvidenceError("public_service_unavailable", source);
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers?.get("x-ratelimit-remaining") === "0")
  )
    throw new PublicEvidenceError("public_rate_limit", source);
}

module.exports = { PublicEvidenceError, checkAvailability };
