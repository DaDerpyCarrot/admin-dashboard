const express = require("express");
const router = express.Router();

const { resetPlayFabPassword } = require("../services/playfab");

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