const SWITCHES = ["FACTORY_ENABLED", "FACTORY_AUTOMATION_ENABLED", "FACTORY_AUTOMERGE_ENABLED"];
function validateStop(value) {
  if (value === undefined || value === null) return;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "actor,at,id,previous,reason" ||
    value.actor !== "haideearus" ||
    value.reason !== "Owner emergency stop" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id || "") ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at)) ||
    new Date(value.at).toISOString() !== value.at ||
    !value.previous ||
    typeof value.previous !== "object" ||
    Array.isArray(value.previous) ||
    Object.keys(value.previous).sort().join(",") !== [...SWITCHES].sort().join(",") ||
    SWITCHES.some((key) => !["true", "false"].includes(value.previous[key]))
  )
    throw new Error("Invalid durable factory stop marker");
}
module.exports = { SWITCHES, validateStop };
