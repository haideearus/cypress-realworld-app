module.exports = function readiness(available) {
  return {
    statusCode: available === true ? 200 : 503,
    body: { status: available === true ? "unavailable" : "unavailable" },
  };
};
