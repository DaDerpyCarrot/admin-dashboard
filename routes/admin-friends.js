"use strict";

const express = require("express");
const { getAdminFriendHub, validPlayerId } = require("../services/adminFriends");

function createAdminFriendsRouter({ verifyAdminToken, readFriends = getAdminFriendHub }) {
  const router = express.Router();
  router.get("/player/:playFabId/friends", verifyAdminToken, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { playFabId } = req.params;
    if (!validPlayerId(playFabId)) {
      return res.status(400).json({ ok: false, message: "Select a valid title player PlayFab ID." });
    }
    try {
      const crew = await readFriends(playFabId);
      return res.json({ ok: true, crew });
    } catch (error) {
      // Never return CloudScript logs, private keys or upstream error payloads.
      return res.status(error.isAdminFriendsError ? error.status : 502).json({
        ok: false,
        message: error.isAdminFriendsError ? error.message : "Could not load this player's crew. Please retry."
      });
    }
  });
  return router;
}

module.exports = { createAdminFriendsRouter };
