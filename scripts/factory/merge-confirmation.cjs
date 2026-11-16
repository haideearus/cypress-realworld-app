const { ROOT } = require("./github.cjs");
const { SHA } = require("./policy.cjs");

class ConfirmationUnavailable extends Error {
  constructor() {
    super("Merge confirmation temporarily unavailable");
  }
}

async function readMergePR(api, number, confirmation = false) {
  try {
    return await api.request("GET", `${ROOT}/pulls/${number}`);
  } catch (error) {
    if (confirmation) throw new ConfirmationUnavailable();
    throw error;
  }
}

function mergeReceipt(response, error) {
  if (error)
    return {
      outcome: "unknown",
      ...(Number.isSafeInteger(error.status) && error.status >= 400 && error.status <= 599
        ? { httpStatus: error.status }
        : {}),
    };
  if (response?.merged === true && typeof response.sha === "string" && SHA.test(response.sha))
    return { outcome: "accepted", mergeCommit: response.sha };
  return { outcome: response?.merged === false ? "rejected" : "malformed" };
}

module.exports = { ConfirmationUnavailable, readMergePR, mergeReceipt };
