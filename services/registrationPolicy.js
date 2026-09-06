const DEFAULT_ALLOWED_REGISTRATION_DOMAINS = "dlsud.edu.ph";

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function getAllowedRegistrationDomains(value = process.env.ALLOWED_REGISTRATION_DOMAINS) {
  const configuredValue = String(value || DEFAULT_ALLOWED_REGISTRATION_DOMAINS);

  return new Set(
    configuredValue
      .split(",")
      .map(normalizeDomain)
      .filter(Boolean)
  );
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getEmailDomain(email) {
  const normalizedEmail = normalizeEmail(email);

  if (
    normalizedEmail.length === 0 ||
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+$/.test(normalizedEmail)
  ) {
    return null;
  }

  return normalizedEmail.slice(normalizedEmail.lastIndexOf("@") + 1);
}

function isAllowedRegistrationEmail(email, allowedDomains = getAllowedRegistrationDomains()) {
  const domain = getEmailDomain(email);
  return Boolean(domain && allowedDomains.has(domain));
}

function formatAllowedDomains(allowedDomains) {
  return [...allowedDomains].map(domain => `@${domain}`).join(" or ");
}

function validateRegistrationInput(input = {}, allowedDomains = getAllowedRegistrationDomains()) {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";

  if (username.length < 3 || username.length > 20) {
    return {
      valid: false,
      message: "Username must be between 3 and 20 characters."
    };
  }

  if (!getEmailDomain(email)) {
    return {
      valid: false,
      message: "Please enter a valid email address."
    };
  }

  if (!isAllowedRegistrationEmail(email, allowedDomains)) {
    return {
      valid: false,
      message: `New accounts require a ${formatAllowedDomains(allowedDomains)} student email address.`
    };
  }

  if (password.length < 8 || password.length > 100) {
    return {
      valid: false,
      message: "Password must be between 8 and 100 characters."
    };
  }

  return {
    valid: true,
    username,
    email,
    password
  };
}

module.exports = {
  DEFAULT_ALLOWED_REGISTRATION_DOMAINS,
  normalizeDomain,
  getAllowedRegistrationDomains,
  normalizeEmail,
  getEmailDomain,
  isAllowedRegistrationEmail,
  formatAllowedDomains,
  validateRegistrationInput
};
