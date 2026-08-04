const jwt = require("jsonwebtoken");
const { findActiveAdminByUsername, normalizePlayFabId } = require("../services/adminAccounts");

function verifyAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      ok: false,
      message: "Missing or invalid authorization header."
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);

    if (decoded.role !== "admin") {
      return res.status(403).json({
        ok: false,
        message: "Administrator access is required."
      });
    }

    const adminRecord = findActiveAdminByUsername(decoded.username);

    if (!adminRecord) {
      return res.status(403).json({
        ok: false,
        message: "This administrator account is no longer active."
      });
    }

    if (
      decoded.playFabId &&
      normalizePlayFabId(decoded.playFabId) !== normalizePlayFabId(adminRecord.playFabId)
    ) {
      return res.status(403).json({
        ok: false,
        message: "Administrator identity no longer matches this session."
      });
    }

    req.admin = decoded;
    req.adminRecord = adminRecord;
    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: "Invalid or expired token."
    });
  }
}

module.exports = verifyAdminToken;
