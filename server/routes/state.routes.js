'use strict';
const express = require('express');
const { requireAuth } = require('../auth');
const { asyncH } = require('../util');
const { buildState } = require('../state');

const router = express.Router();

// GET /api/state — full application state for the authenticated user.
router.get('/state', requireAuth, asyncH((req, res) => {
  res.json({ user: req.user, state: buildState() });
}));

module.exports = router;
