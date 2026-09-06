const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");

const {
  registerPlayFabUser,
  addOrUpdateContactEmail,
  authenticateSessionTicket,
  resetPlayFabPassword
} = require("../services/playfab");
const {
  getAllowedRegistrationDomains,
  validateRegistrationInput
} = require("../services/registrationPolicy");
const {
  findActiveAdminByPlayFabId,
  normalizePlayFabId
} = require("../services/adminAccounts");

const router = express.Router();

const HANDOFF_TTL_MS = 60 * 1000;
const MAX_PENDING_HANDOFFS = 500;
const pendingHandoffs = new Map();

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getDashboardOrigin() {
  return normalizeOrigin(
    process.env.DASHBOARD_ORIGIN || "https://roadimentary-dashboard.onrender.com"
  );
}

function hashHandoffCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function removeExpiredHandoffs() {
  const now = Date.now();

  for (const [codeHash, handoff] of pendingHandoffs.entries()) {
    if (handoff.expiresAt <= now) {
      pendingHandoffs.delete(codeHash);
    }
  }
}

function storeHandoff(admin, playFabId) {
  removeExpiredHandoffs();

  if (pendingHandoffs.size >= MAX_PENDING_HANDOFFS) {
    const oldestCodeHash = pendingHandoffs.keys().next().value;
    if (oldestCodeHash) pendingHandoffs.delete(oldestCodeHash);
  }

  const code = crypto.randomBytes(32).toString("base64url");
  const codeHash = hashHandoffCode(code);

  pendingHandoffs.set(codeHash, {
    username: admin.username,
    role: admin.role,
    playFabId: normalizePlayFabId(playFabId),
    expiresAt: Date.now() + HANDOFF_TTL_MS
  });

  return code;
}

function consumeHandoff(code) {
  removeExpiredHandoffs();

  const codeHash = hashHandoffCode(code);
  const handoff = pendingHandoffs.get(codeHash);

  // Delete before validating anything else so every code is single-use.
  pendingHandoffs.delete(codeHash);

  if (!handoff || handoff.expiresAt <= Date.now()) {
    return null;
  }

  return handoff;
}

async function resolvePlayFabIdentity(sessionTicket) {
  if (typeof sessionTicket !== "string" || sessionTicket.trim().length < 20) {
    const error = new Error("A valid PlayFab session ticket is required.");
    error.status = 400;
    throw error;
  }

  let result;

  try {
    result = await authenticateSessionTicket(sessionTicket.trim());
  } catch (error) {
    if (error.status && error.status < 500) {
      const invalidTicketError = new Error("The PlayFab session is invalid or expired.");
      invalidTicketError.status = 401;
      throw invalidTicketError;
    }

    throw error;
  }

  const playFabId = normalizePlayFabId(result?.data?.UserInfo?.PlayFabId);

  if (!playFabId) {
    const error = new Error("PlayFab did not return a valid player identity.");
    error.status = 401;
    throw error;
  }

  return {
    playFabId,
    admin: findActiveAdminByPlayFabId(playFabId)
  };
}

function publicAdmin(admin) {
  return {
    username: admin.username,
    role: admin.role
  };
}

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/* ================= STUDENT ACCOUNT REGISTRATION ================= */

router.post("/register", async (req, res, next) => {
  const allowedDomains = getAllowedRegistrationDomains();
  const validation = validateRegistrationInput(req.body, allowedDomains);

  if (!validation.valid) {
    return res.status(400).json({
      ok: false,
      message: validation.message
    });
  }

  try {
    let registration;

    try {
      registration = await registerPlayFabUser({
        username: validation.username,
        email: validation.email,
        password: validation.password
      });
    } catch (error) {
      const playFabError = error?.details?.error;

      if (playFabError === "EmailAddressNotAvailable") {
        return res.status(409).json({
          ok: false,
          message: "An account already exists for that email address."
        });
      }

      if (playFabError === "UsernameNotAvailable") {
        return res.status(409).json({
          ok: false,
          message: "That username is already taken."
        });
      }

      if (
        playFabError === "InvalidEmailAddress" ||
        playFabError === "InvalidUsername" ||
        playFabError === "InvalidPassword"
      ) {
        return res.status(400).json({
          ok: false,
          message: error.message || "The registration details are invalid."
        });
      }

      throw error;
    }

    const sessionTicket = registration?.data?.SessionTicket;

    if (!sessionTicket) {
      const error = new Error("PlayFab created no usable registration session.");
      error.status = 502;
      throw error;
    }

    let verificationEmailQueued = true;

    try {
      await addOrUpdateContactEmail(sessionTicket, validation.email);
    } catch (error) {
      verificationEmailQueued = false;
      console.error(
        "Account created, but contact email setup failed:",
        error?.details?.error || error.message
      );
    }

    return res.status(201).json({
      ok: true,
      verificationEmailQueued,
      message: verificationEmailQueued
        ? "Account created. Check your DLSU-D email to verify the account before signing in."
        : "Account created, but the verification email could not be queued. Sign in once to request another verification email."
    });
  } catch (error) {
    next(error);
  }
});

/* ================= LANDING-PAGE ADMIN SSO ================= */

router.post("/admin-status", async (req, res, next) => {
  try {
    const identity = await resolvePlayFabIdentity(req.body?.sessionTicket);

    return res.json({
      ok: true,
      isAdmin: Boolean(identity.admin),
      admin: identity.admin ? publicAdmin(identity.admin) : null
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin-handoff", async (req, res, next) => {
  try {
    const identity = await resolvePlayFabIdentity(req.body?.sessionTicket);

    if (!identity.admin) {
      return res.status(403).json({
        ok: false,
        message: "This PlayFab account is not authorized for the admin dashboard."
      });
    }

    const code = storeHandoff(identity.admin, identity.playFabId);
    const redirectUrl = new URL("/", getDashboardOrigin());
    redirectUrl.searchParams.set("handoff", code);

    return res.json({
      ok: true,
      redirectUrl: redirectUrl.toString(),
      expiresInSeconds: HANDOFF_TTL_MS / 1000
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin-handoff/consume", (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";

  if (!code) {
    return res.status(400).json({
      ok: false,
      message: "A dashboard handoff code is required."
    });
  }

  const handoff = consumeHandoff(code);

  if (!handoff) {
    return res.status(401).json({
      ok: false,
      message: "This dashboard handoff is invalid, expired, or already used."
    });
  }

  const currentAdmin = findActiveAdminByPlayFabId(handoff.playFabId);

  if (!currentAdmin || currentAdmin.username !== handoff.username) {
    return res.status(403).json({
      ok: false,
      message: "This administrator account is no longer authorized."
    });
  }

  const token = jwt.sign(
    {
      username: currentAdmin.username,
      role: currentAdmin.role,
      playFabId: normalizePlayFabId(currentAdmin.playFabId),
      authMethod: "playfab-handoff"
    },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "2h" }
  );

  return res.json({
    ok: true,
    token,
    admin: publicAdmin(currentAdmin)
  });
});

/* ================= EXISTING PASSWORD RECOVERY ================= */

router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        ok: false,
        message: "Token and password are required."
      });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters."
      });
    }

    await resetPlayFabPassword(token, password);

    return res.json({
      ok: true,
      message: "Password reset successful."
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
