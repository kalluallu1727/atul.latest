// Auth module — new, independent routes mounted at /api/auth
// Does NOT modify any existing IVR / call / transcription logic.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { requireAuth } = require("./authMiddleware");

const router = express.Router();

let _adminClient = null;
function getAdminClient() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return _adminClient;
}

// ── GET /api/auth/me ──────────────────────────────────────────
// Returns the authenticated agent's profile from the agents table.
router.get("/me", requireAuth, async (req, res) => {
  const { data, error } = await getAdminClient()
    .from("agents")
    .select("id, agent_id, name, email, department, is_verified, created_at")
    .eq("auth_user_id", req.user.id)
    .single();

  if (error) return res.status(404).json({ error: "Agent profile not found" });
  return res.json({ agent: data });
});

// ── POST /api/auth/create-profile ─────────────────────────────
// Creates an agent profile for OAuth sign-ins where the DB trigger
// may not have received department/name from user_metadata.
// Safe to call multiple times — ignored if profile already exists.
router.post("/create-profile", requireAuth, async (req, res) => {
  const { name, department } = req.body;
  const user = req.user;

  const { data: existing } = await getAdminClient()
    .from("agents")
    .select("id")
    .eq("auth_user_id", user.id)
    .single();

  if (existing) return res.json({ message: "Profile already exists" });

  const agentId =
    "AGT-" +
    Math.random().toString(36).slice(2, 6).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase();

  const { data, error } = await getAdminClient()
    .from("agents")
    .insert({
      auth_user_id: user.id,
      agent_id: agentId,
      name: name || user.user_metadata?.name || user.email.split("@")[0],
      email: user.email,
      department: department || user.user_metadata?.department || "General",
      is_verified: !!user.email_confirmed_at,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ agent: data });
});

module.exports = router;
