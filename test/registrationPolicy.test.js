const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getAllowedRegistrationDomains,
  getEmailDomain,
  isAllowedRegistrationEmail,
  validateRegistrationInput
} = require("../services/registrationPolicy");

const allowedDomains = getAllowedRegistrationDomains("@dlsud.edu.ph");

test("accepts the exact DLSU-D domain case-insensitively", () => {
  assert.equal(isAllowedRegistrationEmail(" Student@DLSUD.EDU.PH ", allowedDomains), true);
});

test("rejects personal Gmail and deceptive suffixes", () => {
  assert.equal(isAllowedRegistrationEmail("student@gmail.com", allowedDomains), false);
  assert.equal(isAllowedRegistrationEmail("student@dlsud.edu.ph.evil.test", allowedDomains), false);
  assert.equal(isAllowedRegistrationEmail("student@fake-dlsud.edu.ph", allowedDomains), false);
});

test("rejects malformed email addresses", () => {
  assert.equal(getEmailDomain("student@@dlsud.edu.ph"), null);
  assert.equal(getEmailDomain("student dlsud.edu.ph"), null);
});

test("normalizes accepted registration data", () => {
  const result = validateRegistrationInput(
    {
      username: "  roadbuilder  ",
      email: " Student@DLSUD.EDU.PH ",
      password: "correct-horse-battery-staple"
    },
    allowedDomains
  );

  assert.equal(result.valid, true);
  assert.equal(result.username, "roadbuilder");
  assert.equal(result.email, "student@dlsud.edu.ph");
});

test("returns a useful domain error", () => {
  const result = validateRegistrationInput(
    {
      username: "roadbuilder",
      email: "student@gmail.com",
      password: "correct-horse-battery-staple"
    },
    allowedDomains
  );

  assert.equal(result.valid, false);
  assert.match(result.message, /@dlsud\.edu\.ph/);
});
