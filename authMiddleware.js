const { createClient } = require("@supabase/supabase-js");

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

// Middleware: requires a valid Supabase Bearer token in Authorization header.
// Attaches req.user (Supabase auth user) on success.
// Apply to any route that should only be accessible to authenticated agents.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: missing token" });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await getAdminClient().auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: "Unauthorized: invalid or expired token" });
  }

  req.user = user;
  next();
}

module.exports = { requireAuth };
