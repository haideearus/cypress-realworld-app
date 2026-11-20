const WORKFLOW_FILE = "factory-functional-discovery.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
const PROBE_MODE = "functional-browser";
const CHECKS = Object.freeze({
  "sign-in": "Browser sign-in",
  navigation: "Home and Settings navigation",
  settings: "Opening Settings",
  "settings-persistence": "Saving Settings and reloading the profile",
  "form-validation": "Settings form validation",
  "sign-in-accessibility": "Sign-in field labels",
  "bank-account-onboarding": "Bank account onboarding",
});
const ASSERTIONS = Object.freeze({
  "sign-in": ["sign-in-form", "sign-in-route", "sign-in-identity", "sign-in-session"],
  navigation: [
    "navigation-settings-link",
    "navigation-settings-route",
    "navigation-home-link",
    "navigation-home-route",
  ],
  settings: ["settings-form", "settings-profile"],
  "settings-persistence": ["settings-persistence-saved", "settings-persistence-reloaded"],
  "form-validation": [
    "settings-first-name-required",
    "settings-email-required",
    "settings-email-invalid",
    "settings-save-disabled",
  ],
  "sign-in-accessibility": ["sign-in-username-label", "sign-in-password-label"],
  "bank-account-onboarding": [
    "onboarding-wizard",
    "onboarding-save-rejected",
    "onboarding-save-confirmed",
    "onboarding-finish",
    "onboarding-sign-out",
    "onboarding-account-after-sign-in",
  ],
});

function validAssertion(check, assertion) {
  return (
    typeof check === "string" &&
    Object.hasOwn(ASSERTIONS, check) &&
    ASSERTIONS[check].includes(assertion)
  );
}

function validateFunctionalResult(status, check, assertion) {
  if (
    !["healthy", "confirmed_failure", "inconclusive"].includes(status) ||
    (status === "confirmed_failure"
      ? !validAssertion(check, assertion)
      : check !== "" || assertion !== "")
  )
    throw Error("Invalid functional discovery evidence");
  return { status, check, assertion };
}

function functionalIssueCheck(issue) {
  return Object.keys(CHECKS).find(
    (check) => issue?.title === `Functional discovery: ${CHECKS[check]} failed`
  );
}

module.exports = {
  WORKFLOW_FILE,
  WORKFLOW_PATH,
  PROBE_MODE,
  CHECKS,
  ASSERTIONS,
  validAssertion,
  validateFunctionalResult,
  functionalIssueCheck,
};
