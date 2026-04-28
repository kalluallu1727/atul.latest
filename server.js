// =============================================================
// Required env vars (add to .env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_API_KEY, TWILIO_API_SECRET
//   TWILIO_TWIML_APP_SID
//   TWILIO_PHONE_NUMBER
//   APP_BASE_URL
//   CORS_ORIGIN, PORT
// =============================================================

const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent";

const express  = require("express");
const http     = require("http");
const { randomUUID } = require("crypto");
const cors     = require("cors");
const { createClient } = require("@supabase/supabase-js");
const twilio   = require("twilio");
const { analyzeCustomerSpeech }                            = require("./decisionEngine");
const { generateEmbedding, searchKnowledge, generateSuggestedReply, generateGreeting } = require("./ragService");
const { upload, extractText, chunkText }                   = require("./uploadService");
const { runMigrations }                                    = require("./migrate");
const authRoutes                                           = require("./authRoutes");
require("dotenv").config({ quiet: true });

// ── App + HTTP server ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : true;

app.use(cors({ origin: corsOrigin }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Auth module (new, independent — does not touch existing routes) ──
app.use("/api/auth", authRoutes);

// ── Env validation ────────────────────────────────────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY,
  APP_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
  PORT,
} = process.env;

const MISSING_VARS = [
  ["SUPABASE_URL",            SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
  ["GEMINI_API_KEY",          GEMINI_API_KEY],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING_VARS.length > 0) {
  console.error(`[startup] Missing required environment variable(s): ${MISSING_VARS.join(", ")}`);
  console.error("[startup] Set these in your Render dashboard → Environment, then redeploy.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Twilio REST client (optional — only needed for dialling agents)
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const BASE_URL = (APP_BASE_URL || "").replace(/\/+$/, "");

const port          = Number(PORT) || 3000;
const hasExplicitPort = Boolean(PORT);

// ── Startup diagnostics ──────────────────────────────────────
console.log("[startup] APP_BASE_URL    :", BASE_URL || "(not set!)");
console.log("[startup] Twilio client   :", twilioClient ? "configured" : "NOT configured");

// ── Helpers ───────────────────────────────────────────────────
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildPhoneVariants(rawPhone) {
  const digitsOnly = String(rawPhone || "").replace(/\D/g, "");
  if (!digitsOnly) return [rawPhone].filter(Boolean);

  const lastTen = digitsOnly.slice(-10);
  const variants = new Set([rawPhone, digitsOnly, `+${digitsOnly}`]);

  if (digitsOnly.length === 10) {
    variants.add(`1${digitsOnly}`);
    variants.add(`+1${digitsOnly}`);
  }
  if (digitsOnly.length > 10) {
    variants.add(lastTen);
    variants.add(`+1${lastTen}`);
    variants.add(`1${lastTen}`);
  }

  return Array.from(variants).filter(Boolean);
}

async function lookupCustomerByPhone(rawPhone) {
  if (!rawPhone) return null;

  const variants = buildPhoneVariants(rawPhone);
  if (variants.length === 0) return null;

  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .in("phone", variants)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Customer lookup failed:", error.message);
    return null;
  }
  return data || null;
}

// ── Conference TwiML builders ─────────────────────────────────
// Twilio's <Start><Transcription> handles speech-to-text natively.
// Final transcripts are POSTed to /api/transcription by Twilio.
function customerConferenceTwiml(callId) {
  const transcriptionUrl = escapeXml(`${BASE_URL}/api/transcription?call_id=${callId}&role=customer`);
  const statusUrl        = escapeXml(`${BASE_URL}/api/conference-status?call_id=${callId}`);
  const room             = `room-${callId}`;
  console.log(`[twiml] Transcription callback: ${BASE_URL}/api/transcription?call_id=${callId}&role=customer`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you. Connecting you to an agent now. Please hold.</Say>
  <Start>
    <Transcription statusCallbackUrl="${transcriptionUrl}"
                   statusCallbackMethod="POST"
                   track="inbound_track" />
  </Start>
  <Dial>
    <Conference beep="false"
                waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
                statusCallbackEvent="join end"
                statusCallback="${statusUrl}"
                endConferenceOnExit="true">
      ${room}
    </Conference>
  </Dial>
</Response>`;
}

function agentConferenceTwiml(callId) {
  const transcriptionUrl   = escapeXml(`${BASE_URL}/api/transcription?call_id=${callId}&role=agent`);
  const recordingStatusUrl = escapeXml(`${BASE_URL}/api/twilio/recording-status?call_id=${callId}`);
  const room               = `room-${callId}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Transcription statusCallbackUrl="${transcriptionUrl}"
                   statusCallbackMethod="POST"
                   track="inbound_track" />
  </Start>
  <Dial>
    <Conference beep="false" waitUrl=""
                endConferenceOnExit="true"
                record="record-from-start"
                recordingStatusCallback="${recordingStatusUrl}"
                recordingStatusCallbackMethod="POST"
                recordingStatusCallbackEvent="completed absent">
      ${room}
    </Conference>
  </Dial>
</Response>`;
}

// ── Billing lookup from knowledge_base by customer name ──────
// Handles cases where bills are stored directly in knowledge_base
// as structured rows with name / billing_date / due_date / invoice_no etc.
async function fetchBillingFromKnowledgeBase(customerName) {
  if (!customerName) return null;
  try {
    const { data, error } = await supabase
      .from("knowledge_base")
      .select("*")
      .ilike("name", `%${customerName}%`)
      .order("billing_date", { ascending: false })
      .limit(3);

    if (error || !data || data.length === 0) return null;

    const skip = new Set(["id", "embedding", "content", "source", "created_at"]);
    const rows = data.map((row) => {
      const parts = [];
      Object.entries(row).forEach(([k, v]) => {
        if (!skip.has(k) && v != null && String(v).trim()) {
          const label = k.replace(/_/g, " ");
          parts.push(`${label}: ${v}`);
        }
      });
      return parts.join(" | ");
    }).filter(Boolean);

    return rows.length > 0 ? rows.join("\n") : null;
  } catch {
    return null;
  }
}

// ── Combine recent speech-to-text fragments ───────────────────
// Speech-to-text often splits a single utterance into 2-3 short messages.
// This fetches the last few user messages within a 45-second window and
// joins them so the AI sees the full intended sentence.
async function getCombinedUserTranscript(callId, latestTranscript) {
  try {
    const { data } = await supabase
      .from("messages")
      .select("content, created_at")
      .eq("call_id", callId)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(4);

    if (!data || data.length === 0) return latestTranscript;

    const WINDOW_MS = 45_000; // 45 seconds — covers typical STT lag
    const latestTime = new Date(data[0].created_at).getTime();

    const recentFragments = data
      .filter((m) => latestTime - new Date(m.created_at).getTime() < WINDOW_MS)
      .reverse()
      .map((m) => String(m.content || "").trim())
      .filter(Boolean);

    const combined = recentFragments.join(" ");
    if (combined !== latestTranscript) {
      console.log(`[analysis] Combined ${recentFragments.length} fragments: "${combined.slice(0, 100)}"`);
    }
    return combined || latestTranscript;
  } catch {
    return latestTranscript;
  }
}

// ── Shared AI analysis pipeline ───────────────────────────────
// Called from both /api/transcription (conference speech) and
// /api/twilio/ivr-query (IVR-captured user query).
async function runAnalysisPipeline(callId, transcript) {
  try {
    const { data: callData } = await supabase
      .from("calls").select("*").eq("id", callId).maybeSingle();
    const tier          = callData?.tier          || "Regular";
    const customerName  = callData?.customer_name || null;
    const customerPhone = callData?.customer_phone || null;

    // Combine recent STT fragments so the AI understands the full sentence
    const fullTranscript = await getCombinedUserTranscript(callId, transcript);

    const searchQuery = customerName ? `${customerName} ${fullTranscript}` : fullTranscript;

    // Fetch embedding + billing context in parallel so analysis can use real bill data
    const [embedding, billsTableCtx, kbBillingCtx] = await Promise.all([
      generateEmbedding(searchQuery).catch(() => null),
      fetchCustomerBillingContext(null, customerPhone, customerName),
      fetchBillingFromKnowledgeBase(customerName),
    ]);

    const billingContext = [billsTableCtx, kbBillingCtx].filter(Boolean).join("\n") || null;
    if (billingContext) console.log(`[analysis] billing context found for ${customerName || customerPhone}`);
    else console.log(`[analysis] no billing context found for ${customerName || customerPhone}`);

    // Pass billing context into analysis so suggested_actions are resolution-focused, not discovery-focused
    const analysisResult = await analyzeCustomerSpeech(fullTranscript, tier, billingContext);

    console.log(`[analysis] emotion=${analysisResult.emotion} intent=${analysisResult.intent} priority=${analysisResult.priority}`);

    const { data: savedRows, error: insertErr } = await supabase
      .from("analysis")
      .insert({
        call_id:           callId,
        emotion:           analysisResult.emotion,
        intent:            analysisResult.intent,
        priority:          analysisResult.priority,
        suggested_actions: analysisResult.suggested_actions,
        suggested_reply:   null,
      })
      .select("id");

    if (insertErr) console.error("[analysis] Insert error:", insertErr.message);
    else console.log("[analysis] Basic analysis saved ✓", savedRows?.[0]?.id ? `id=${savedRows[0].id}` : "(no id returned)");

    supabase.from("calls").update({ priority: analysisResult.priority })
      .eq("id", callId)
      .then(({ error }) => { if (error) console.error("[analysis] Priority update:", error.message); });

    try {
      const contextChunks = embedding ? await searchKnowledge(supabase, embedding) : [];

      const customerData   = { name: customerName, tier, billingContext };
      // Use the full combined transcript so the reply addresses the complete thought
      const suggestedReply = await generateSuggestedReply(fullTranscript, contextChunks, tier, customerData, analysisResult.emotion);
      console.log(`[analysis] suggested reply generated: "${(suggestedReply || "").slice(0, 80)}"`);

      if (suggestedReply) {
        const analysisId = savedRows?.[0]?.id;
        const updateQuery = analysisId
          ? supabase.from("analysis").update({ suggested_reply: suggestedReply }).eq("id", analysisId)
          : supabase.from("analysis").update({ suggested_reply: suggestedReply }).eq("call_id", callId);

        updateQuery.then(({ error }) => {
          if (error) console.error("[analysis] Reply update error:", error.message);
          else console.log("[analysis] Suggested reply saved ✓");
        });
      } else {
        console.warn("[analysis] generateSuggestedReply returned empty string");
      }
    } catch (replyErr) {
      console.error("[analysis] Suggested reply failed (basic analysis still saved):", replyErr.message);
    }
  } catch (err) {
    console.error("[analysis] Pipeline error:", err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────

// ── Department-based routing helpers ─────────────────────────
// Maps the IVR category chosen by the customer to the Twilio
// client identity of the correct department agent pool.
function categoryToAgentIdentity(category) {
  const map = {
    billing:   "agent_billing",
    new_lines: "agent_support",
    service:   "agent_support",
    general:   "agent_general",
  };
  return map[category] || "agent_general";
}

// Maps the department stored in the agents table to the same
// Twilio client identity, so each agent registers under the right pool.
function departmentToAgentIdentity(department) {
  const deptMap = {
    "Billing":           "agent_billing",
    "Technical Support": "agent_support",
    "Sales":             "agent_support",
    "Customer Success":  "agent_support",
    "General":           "agent_general",
  };
  return deptMap[department] || "agent_general";
}

// Redirects every participant in a waiting conference to the
// "no agents available" TwiML endpoint.
async function redirectCustomerToNoAgentMessage(callId) {
  if (!twilioClient) return;
  try {
    const conferences = await twilioClient.conferences.list({
      friendlyName: `room-${callId}`,
      status: "in-progress",
      limit: 1,
    });
    if (!conferences.length) return;
    const participants = await twilioClient
      .conferences(conferences[0].sid)
      .participants.list({ limit: 20 });
    for (const p of participants) {
      await twilioClient.calls(p.callSid).update({
        url:    `${BASE_URL}/api/twilio/no-agent-available`,
        method: "POST",
      });
    }
    console.log(`[no-agent] Customer redirected for callId=${callId}`);
  } catch (err) {
    console.error("[no-agent] Redirect error:", err.message);
  }
}

app.get("/", (_req, res) => res.send("Agent-assist IVR server running."));

// -- Twilio Access Token for agent browser softphone ----------
// Accepts an optional Bearer token (Supabase JWT) to derive the
// agent's department and assign the correct Twilio client identity.
// Falls back to "agent_general" if no auth header is present.
app.get("/api/token", async (req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
    return res.status(503).json({ error: "Twilio credentials not configured." });
  }

  let agentIdentity = "agent_general";

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const bearerToken = authHeader.slice(7);
      const { data: { user } } = await supabase.auth.getUser(bearerToken);
      if (user) {
        const { data: agent } = await supabase
          .from("agents")
          .select("department")
          .eq("auth_user_id", user.id)
          .single();
        if (agent?.department) {
          agentIdentity = departmentToAgentIdentity(agent.department);
        }
      }
    } catch (e) {
      console.warn("[token] Could not resolve agent department:", e.message);
    }
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    { identity: agentIdentity, ttl: 3600 }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID || undefined,
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);
  console.log(`[token] Issued Twilio token → identity="${agentIdentity}"`);
  return res.json({ token: token.toJwt(), identity: agentIdentity });
});

// -- Customer calls in → IVR greeting + menu -----------------
// Agent is NOT dialled here; dialling happens after the customer
// completes the IVR so the agent only rings when ready to talk.
app.post("/api/twilio/voice", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const callId      = randomUUID();
  const callerPhone = String(req.body.From || req.body.Caller || "").trim() || null;

  console.log(`\n[voice] ── Incoming call ──────────────────────`);
  console.log(`[voice] callId      : ${callId}`);
  console.log(`[voice] callerPhone : ${callerPhone || "(unknown)"}`);

  try {
    const customer = callerPhone ? await lookupCustomerByPhone(callerPhone) : null;
    console.log(`[voice] customer    : ${customer ? `${customer.name} / tier=${customer.tier}` : "not found in DB"}`);

    // Insert call record — status/ivr_category updated separately so the
    // INSERT succeeds even if those columns haven't been migrated yet.
    supabase.from("calls").insert({
      id:             callId,
      customer_phone: customer?.phone || callerPhone,
      customer_name:  customer?.name  || null,
      tier:           customer?.tier  || null,
      priority:       "low",
    }).then(({ error }) => {
      if (error) { console.error("[voice] Call insert error:", error.message); return; }
      console.log(`[voice] Call inserted in DB ✓`);
      // Best-effort status update (silent if column not yet migrated)
      supabase.from("calls").update({ status: "ivr" }).eq("id", callId).then(() => {});
    });

    const menuUrl    = escapeXml(`${BASE_URL}/api/twilio/ivr-menu?call_id=${callId}`);
    const noInputUrl = escapeXml(`${BASE_URL}/api/twilio/ivr-noinput?call_id=${callId}&step=menu&attempt=1`);

    // Generate AI greeting suggestion so it's ready when the agent connects
    if (customer?.name) {
      generateGreeting(customer.name, customer.tier || "Regular")
        .then(async (greetingText) => {
          if (!greetingText) return;
          const { error } = await supabase.from("analysis").insert({
            call_id:           callId,
            emotion:           "calm",
            intent:            "call_greeting",
            priority:          "low",
            suggested_actions: [
              "Greet the customer warmly by name",
              "Confirm their identity if needed",
              "Ask how you can help today",
            ],
            suggested_reply: greetingText,
          });
          if (error) console.error("[voice] Greeting suggestion error:", error.message);
          else console.log("[voice] Greeting suggestion saved ✓");
        })
        .catch((err) => console.error("[voice] Greeting generation failed:", err.message));
    }

    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" action="${menuUrl}" method="POST" timeout="8" numDigits="1" speechTimeout="auto">
    <Say voice="alice">For Billing, press 1. For New Lines or New Services, press 2. For Service related Queries, press 3. Or in a few words, please tell me how I can help you.</Say>
  </Gather>
  <Redirect method="POST">${noInputUrl}</Redirect>
</Response>`);
    console.log(`[voice] IVR TwiML sent ✓`);
  } catch (error) {
    console.error("[voice] Unexpected error:", error.message);
    // Fallback: skip IVR and connect directly
    res.send(customerConferenceTwiml(callId));
  }
});

// -- IVR: menu selection handler ------------------------------
// Called by Twilio after customer presses a digit or speaks.
app.post("/api/twilio/ivr-menu", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const callId      = String(req.query.call_id   || "").trim();
  const digits      = String(req.body.Digits      || "").trim();
  const speech      = String(req.body.SpeechResult || "").trim();

  console.log(`[ivr-menu] callId=${callId} digits="${digits}" speech="${speech.slice(0, 60)}"`);

  // Map input to a support category
  let category, categoryLabel;
  if (digits === "1" || /billing|bill|payment|invoice|charge/i.test(speech)) {
    category = "billing";      categoryLabel = "Billing";
  } else if (digits === "2" || /new line|new service|add line|upgrade|plan|activate/i.test(speech)) {
    category = "new_lines";    categoryLabel = "New Lines and Services";
  } else if (digits === "3" || /service|technical|issue|problem|not working|outage|slow|broken/i.test(speech)) {
    category = "service";      categoryLabel = "Service Support";
  } else {
    category = "general";      categoryLabel = "Support";
  }

  if (callId) {
    supabase.from("calls").update({ ivr_category: category })
      .eq("id", callId)
      .then(({ error }) => { if (error) console.error("[ivr-menu] Category update:", error.message); });
  }

  const queryUrl   = escapeXml(`${BASE_URL}/api/twilio/ivr-query?call_id=${callId}&category=${category}`);
  const noInputUrl = escapeXml(`${BASE_URL}/api/twilio/ivr-noinput?call_id=${callId}&step=query&category=${category}&attempt=1`);

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${queryUrl}" method="POST" timeout="8" speechTimeout="auto">
    <Say voice="alice">I will connect you with our ${escapeXml(categoryLabel)} team. Please briefly describe your issue in a few words.</Say>
  </Gather>
  <Redirect method="POST">${noInputUrl}</Redirect>
</Response>`);
});

// -- IVR: capture user query, save to DB, dial agent ----------
// Only the customer's spoken query is stored — IVR prompts are never saved.
app.post("/api/twilio/ivr-query", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const callId   = String(req.query.call_id  || "").trim();
  const category = String(req.query.category || "general").trim();
  const speech   = String(req.body.SpeechResult || "").trim();

  console.log(`[ivr-query] callId=${callId} category=${category} speech="${speech.slice(0, 80)}"`);

  if (callId && speech) {
    // Persist only the user's actual problem statement
    supabase.from("messages").insert({ call_id: callId, role: "user", content: speech })
      .then(({ error }) => {
        if (error) console.error("[ivr-query] Message insert error:", error.message);
        else console.log(`[ivr-query] User query saved ✓`);
      });

    // Kick off AI analysis so suggestions are ready when agent joins
    runAnalysisPipeline(callId, speech).catch((err) =>
      console.error("[ivr-query] Analysis pipeline error:", err.message)
    );
  }

  // Mark call as active and lock in the category
  if (callId) {
    supabase.from("calls").update({ status: "active", ivr_category: category })
      .eq("id", callId)
      .then(({ error }) => { if (error) console.error("[ivr-query] Call update:", error.message); });
  }

  // Dial the agent browser now that the customer is ready to talk.
  // Routes to the department pool that matches the customer's IVR choice.
  if (twilioClient && TWILIO_PHONE_NUMBER && callId) {
    const agentIdentity = categoryToAgentIdentity(category);
    const agentUrl      = `${BASE_URL}/api/twilio/agent?call_id=${callId}`;
    console.log(`[ivr-query] Dialling agent → client:${agentIdentity} (category=${category})`);
    twilioClient.calls.create({
      to:   `client:${agentIdentity}`,
      from: TWILIO_PHONE_NUMBER,
      url:  agentUrl,
      statusCallback:       `${BASE_URL}/api/twilio/agent-status?call_id=${callId}&identity=${agentIdentity}`,
      statusCallbackEvent:  ["completed", "no-answer", "busy", "failed"],
      statusCallbackMethod: "POST",
      timeout: 15,
    }).then((call) => {
      console.log(`[ivr-query] Agent call created ✓ SID=${call.sid} identity=${agentIdentity}`);
    }).catch((err) => {
      console.error(`[ivr-query] Agent dial FAILED: ${err.message}`);
    });
  } else {
    console.warn("[ivr-query] Twilio client not configured — agent NOT dialled.");
  }

  // Put the customer into the conference room (hold music plays until agent joins)
  res.send(customerConferenceTwiml(callId));
  console.log(`[ivr-query] Customer conference TwiML sent ✓`);
});

// -- IVR: no-input handler ------------------------------------
// First attempt: reprompt with "I have not received any input."
// Second attempt: disconnect gracefully.
app.post("/api/twilio/ivr-noinput", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const callId   = String(req.query.call_id  || "").trim();
  const step     = String(req.query.step     || "menu").trim();
  const category = String(req.query.category || "general").trim();
  const attempt  = parseInt(req.query.attempt || "1", 10);

  console.log(`[ivr-noinput] callId=${callId} step=${step} attempt=${attempt}`);

  if (attempt >= 2) {
    // Second silence → disconnect gracefully
    if (callId) {
      supabase.from("calls").update({ status: "disconnected" })
        .eq("id", callId)
        .then(({ error }) => { if (error) console.error("[ivr-noinput] Status update:", error.message); });
    }
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">We did not receive a response. Thank you for calling BrightSuite. Goodbye.</Say>
  <Hangup/>
</Response>`);
  }

  // First silence — reprompt based on which step timed out
  if (step === "query") {
    const queryUrl   = escapeXml(`${BASE_URL}/api/twilio/ivr-query?call_id=${callId}&category=${category}`);
    const noInputUrl = escapeXml(`${BASE_URL}/api/twilio/ivr-noinput?call_id=${callId}&step=query&category=${category}&attempt=2`);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${queryUrl}" method="POST" timeout="8" speechTimeout="auto">
    <Say voice="alice">I have not received any input. Please tell your query in a few words.</Say>
  </Gather>
  <Redirect method="POST">${noInputUrl}</Redirect>
</Response>`);
  }

  // step === "menu"
  const menuUrl    = escapeXml(`${BASE_URL}/api/twilio/ivr-menu?call_id=${callId}`);
  const noInputUrl = escapeXml(`${BASE_URL}/api/twilio/ivr-noinput?call_id=${callId}&step=menu&attempt=2`);
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" action="${menuUrl}" method="POST" timeout="8" numDigits="1" speechTimeout="auto">
    <Say voice="alice">I have not received any input. For Billing press 1, for New Lines or New Services press 2, for Service related Queries press 3. Or please tell me how I can help you.</Say>
  </Gather>
  <Redirect method="POST">${noInputUrl}</Redirect>
</Response>`);
});

// -- Agent leg TwiML (called by Twilio when agent answers) ----
// Recording starts automatically via record="record-from-start" in the TwiML.
// Twilio fires recordingStatusCallback when recording completes.
app.post("/api/twilio/agent", (req, res) => {
  res.set("Content-Type", "text/xml");

  const callId = String(req.query.call_id || "").trim();
  if (!callId) {
    return res.send("<Response><Hangup/></Response>");
  }

  res.send(agentConferenceTwiml(callId));
});

// -- Outbound call: agent leg (TwiML App calls this when agent dials) -
app.post("/api/twilio/outbound", async (req, res) => {
  res.set("Content-Type", "text/xml");
  const to = String(req.body.To || "").trim();

  if (!to || !TWILIO_PHONE_NUMBER || !twilioClient) {
    return res.send("<Response><Hangup/></Response>");
  }

  const callId = randomUUID();
  const room   = `room-${callId}`;

  console.log(`\n[outbound] ── Outbound call ───────────────────`);
  console.log(`[outbound] callId : ${callId}`);
  console.log(`[outbound] to     : ${to}`);

  // Insert call record then update with customer info if found
  supabase.from("calls").insert({
    id:             callId,
    customer_phone: to,
    customer_name:  null,
    tier:           null,
    priority:       "low",
  }).then(({ error }) => {
    if (error) console.error("[outbound] Call insert error:", error.message);
    else console.log(`[outbound] Call inserted in DB ✓`);
  });

  lookupCustomerByPhone(to).then((customer) => {
    if (!customer) return;
    supabase.from("calls").update({ customer_name: customer.name, tier: customer.tier })
      .eq("id", callId).then(({ error }) => {
        if (error) console.error("[outbound] Customer update error:", error.message);
      });
  });

  // Dial the customer into the same conference room via REST API
  const customerUrl = `${BASE_URL}/api/twilio/outbound-customer?call_id=${callId}`;
  twilioClient.calls.create({ to, from: TWILIO_PHONE_NUMBER, url: customerUrl })
    .then((call) => console.log(`[outbound] Customer dialed ✓ SID=${call.sid}`))
    .catch((err) => console.error(`[outbound] Customer dial FAILED: ${err.message}`));

  // Put agent into the conference room with transcription
  const agentTranscriptionUrl = escapeXml(`${BASE_URL}/api/transcription?call_id=${callId}&role=agent`);
  const statusUrl              = escapeXml(`${BASE_URL}/api/conference-status?call_id=${callId}`);

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Transcription statusCallbackUrl="${agentTranscriptionUrl}"
                   statusCallbackMethod="POST"
                   track="inbound_track" />
  </Start>
  <Dial>
    <Conference beep="false"
                waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
                statusCallbackEvent="end"
                statusCallback="${statusUrl}">
      ${room}
    </Conference>
  </Dial>
</Response>`);
  console.log(`[outbound] Agent TwiML sent ✓`);
});

// -- Outbound call: customer leg (Twilio calls this when customer answers) -
app.post("/api/twilio/outbound-customer", (req, res) => {
  res.set("Content-Type", "text/xml");
  const callId = String(req.query.call_id || "").trim();
  if (!callId) return res.send("<Response><Hangup/></Response>");

  const room                    = `room-${callId}`;
  const customerTranscriptionUrl = escapeXml(`${BASE_URL}/api/transcription?call_id=${callId}&role=customer`);

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Transcription statusCallbackUrl="${customerTranscriptionUrl}"
                   statusCallbackMethod="POST"
                   track="inbound_track" />
  </Start>
  <Dial>
    <Conference beep="false" waitUrl="">
      ${room}
    </Conference>
  </Dial>
</Response>`);
});

// -- Conference status callback (called when conference ends) -
app.post("/api/conference-status", (req, res) => {
  const callId = String(req.query.call_id        || "").trim();
  const event  = String(req.body.StatusCallbackEvent || "").trim();

  if (event === "conference-end" && callId) {
    console.log(`[conference-status] Conference ended callId=${callId}`);
    supabase.from("calls").update({ status: "disconnected" })
      .eq("id", callId)
      .then(({ error }) => {
        if (error) console.error("[conference-status] Status update:", error.message);
        else console.log(`[conference-status] Call ${callId} marked disconnected ✓`);
      });
  }

  res.status(200).end();
});

// -- Fetch customer's recent bills from DB (graceful — works even if table missing) --
async function fetchCustomerBillingContext(customerId, customerPhone, customerName) {
  // Try to query a `bills` table; adapt to whatever columns exist.
  try {
    let query = supabase.from("bills").select("*").order("created_at", { ascending: false }).limit(3);
    if (customerId)     query = query.eq("customer_id", customerId);
    else if (customerPhone) query = query.or(`customer_phone.eq.${customerPhone},phone.eq.${customerPhone}`);
    else if (customerName)  query = query.ilike("customer_name", `%${customerName}%`);
    else return null;

    const { data, error } = await query;
    if (error || !data || data.length === 0) return null;

    return data.map((row) => {
      const parts = [];
      const month  = row.bill_month  || row.month         || row.billing_period || row.period || null;
      const amount = row.amount      || row.total_amount  || row.bill_amount    || null;
      const due    = row.due_date    || row.due           || null;
      const status = row.status      || row.payment_status|| null;
      const paid   = row.paid_date   || row.payment_date  || null;
      if (month)  parts.push(`Month: ${month}`);
      if (amount) parts.push(`Amount: ${amount}`);
      if (due)    parts.push(`Due: ${due}`);
      if (status) parts.push(`Status: ${status}`);
      if (paid)   parts.push(`Paid on: ${paid}`);
      // Fall back: any remaining string columns
      if (parts.length === 0) {
        Object.entries(row).forEach(([k, v]) => {
          if (k !== "id" && k !== "customer_id" && v != null)
            parts.push(`${k}: ${v}`);
        });
      }
      return parts.join(", ");
    }).filter(Boolean).join("\n");
  } catch {
    return null;
  }
}

// -- Twilio transcription webhook -----------------------------
// Twilio calls this for every transcription event.
// We only act on final transcripts (Final=true).
app.post("/api/transcription", async (req, res) => {
  // Respond immediately so Twilio doesn't retry.
  res.status(200).end();

  const callId  = String(req.query.call_id || "").trim();
  const role    = String(req.query.role    || "customer").trim();
  const event   = req.body.TranscriptionEvent;
  const isFinal = req.body.Final === "true";

  // Log every event so we can see what Twilio is sending
  console.log(`[transcript] event=${event} final=${req.body.Final} role=${role} callId=${callId}`);

  if (!callId) { console.warn("[transcript] Missing call_id — skipping"); return; }
  if (event !== "transcription-content") { console.log(`[transcript] Skipping event type: ${event}`); return; }
  if (!isFinal) { console.log("[transcript] Partial transcript — waiting for final"); return; }

  let transcript = "";
  try {
    const data = JSON.parse(req.body.TranscriptionData || "{}");
    transcript = String(data.transcript || "").trim();
  } catch {
    console.warn("[transcript] Failed to parse TranscriptionData:", req.body.TranscriptionData);
    return;
  }

  if (!transcript) {
    console.log(`[transcript] [${role}] callId=${callId} — empty final transcript`);
    return;
  }

  console.log(`[transcript] [${role}] "${transcript.slice(0, 120)}"`);

  // Save the utterance to the messages table
  const dbRole = role === "agent" ? "agent" : "user";
  supabase
    .from("messages")
    .insert({ call_id: callId, role: dbRole, content: transcript })
    .then(({ error }) => {
      if (error) console.error("[transcript] Message insert error:", error.message);
      else console.log(`[transcript] Message saved ✓ role=${dbRole}`);
    });

  // Only run the AI analysis pipeline for customer speech
  if (role !== "customer") return;

  runAnalysisPipeline(callId, transcript).catch((err) =>
    console.error("[transcription] Analysis pipeline error:", err.message)
  );
});

// -- Knowledge base: add text content + embedding -------------
app.post("/api/knowledge", async (req, res) => {
  const content = String(req.body.content || "").trim();
  const source  = String(req.body.source  || "").trim();

  if (!content) {
    return res.status(400).json({ error: "content is required." });
  }

  try {
    const embedding = await generateEmbedding(content);

    const { error } = await supabase.from("knowledge_base").insert({
      content,
      source:    source || null,
      embedding,
    });

    if (error) throw new Error(error.message);

    return res.json({ success: true, chunks: 1 });
  } catch (err) {
    console.error("Knowledge insert error:", err.message);
    return res.status(500).json({ error: "Failed to add to knowledge base." });
  }
});

// -- Knowledge base: upload file (PDF / DOCX / TXT / CSV) -----
app.post("/api/knowledge/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  const source = req.file.originalname;

  let chunks;
  try {
    const rawText = await extractText(req.file);
    if (!rawText.trim()) {
      return res.status(422).json({ error: "Could not extract text from file." });
    }

    chunks = chunkText(rawText);
    if (chunks.length === 0) {
      return res.status(422).json({ error: "File appears to be empty." });
    }
  } catch (err) {
    console.error("File parse error:", err.message);
    return res.status(422).json({ error: "Failed to parse file content." });
  }

  // Respond immediately — embedding can take minutes for large files.
  res.json({
    success:      true,
    file:         source,
    total_chunks: chunks.length,
    inserted_chunks: chunks.length,
    status:       "processing",
  });

  // Background: embed and insert each chunk sequentially (avoid rate limits)
  (async () => {
    let inserted = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await generateEmbedding(chunk);
        const { error } = await supabase.from("knowledge_base").insert({
          content:   chunk,
          source,
          embedding,
        });
        if (error) {
          console.error(`Chunk insert error (${source}):`, error.message);
        } else {
          inserted++;
        }
      } catch (chunkErr) {
        console.error(`Embedding error (${source}):`, chunkErr.message);
      }
    }
    console.log(`[upload] ${source}: inserted ${inserted}/${chunks.length} chunks`);
  })();
});

// Multer error handler
app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Max 10MB." });
  }
  if (err?.message) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Unexpected error." });
});

// -- Mute / unmute agent leg ----------------------------------
// Actual muting is done client-side via Twilio Voice SDK call.mute().
// This endpoint exists as a logging hook and for server-side enforcement.
app.post("/api/call/mute", (req, res) => {
  const { callId, muted } = req.body;
  console.log(`[mute] callId=${callId || "n/a"} muted=${muted}`);
  res.json({ success: true, muted: Boolean(muted) });
});

// -- Call summary: AI-generated summary of the conversation ---
app.get("/api/call-summary", async (req, res) => {
  const callId = String(req.query.call_id || "").trim();
  if (!callId) return res.status(400).json({ error: "call_id required" });

  try {
    const [{ data: msgs }, { data: analyses }] = await Promise.all([
      supabase.from("messages").select("role,content,created_at").eq("call_id", callId).order("created_at", { ascending: true }),
      supabase.from("analysis").select("*").eq("call_id", callId).order("created_at", { ascending: true }),
    ]);

    const allMsgs     = msgs     || [];
    const allAnalyses = (analyses || []).filter((a) => a.intent !== "call_greeting");
    const latest      = allAnalyses[allAnalyses.length - 1] || null;
    const customerCt  = allMsgs.filter((m) => m.role === "user").length;
    const agentCt     = allMsgs.filter((m) => m.role === "agent").length;

    const base = {
      emotion:       latest?.emotion  || "calm",
      intent:        latest?.intent   || "general_inquiry",
      priority:      latest?.priority || "low",
      message_count: { customer: customerCt, agent: agentCt },
    };

    if (allMsgs.length === 0) {
      return res.json({ ...base, topic: "Awaiting customer", summary: null, key_points: [], status: "pending" });
    }

    const transcript = allMsgs
      .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
      .join("\n");

    const prompt = [
      "You are summarizing a call center conversation for an agent dashboard.",
      "",
      "Conversation transcript:",
      transcript,
      "",
      latest ? `Most recent analysis — emotion: ${latest.emotion}, intent: ${latest.intent}, priority: ${latest.priority}` : "",
      "",
      "Return ONLY valid JSON — no markdown, no code blocks:",
      JSON.stringify({
        topic:      "<2-6 word label for the main issue, e.g. 'High electricity bill inquiry'>",
        summary:    "<2-3 sentences describing what the call is about and what has been established>",
        key_points: ["<key fact 1 e.g. specific amount or date>", "<key fact 2>", "<key fact 3>"],
        status:     "<in_progress|resolved|escalated|pending>",
      }),
    ].filter(Boolean).join("\n");

    const key      = process.env.GEMINI_API_KEY;
    const gRes     = await fetch(`${GEMINI_GENERATE_URL}?key=${key}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.2 },
      }),
    });

    if (!gRes.ok) throw new Error(`Gemini ${gRes.status}`);
    const gData  = await gRes.json();
    const raw    = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = JSON.parse(raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());

    return res.json({
      ...base,
      topic:      parsed.topic      || base.intent,
      summary:    parsed.summary    || null,
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points.filter(Boolean) : [],
      status:     parsed.status     || "in_progress",
    });
  } catch (err) {
    console.error("[call-summary] error:", err.message);
    return res.status(500).json({ error: "Failed to generate summary." });
  }
});

// -- Customer details -----------------------------------------
async function fetchCustomerDetails(req, res, overrides = {}) {
  const id    = String(overrides.id    ?? req.query.id    ?? "").trim();
  const email = String(overrides.email ?? req.query.email ?? "").trim();
  const phone = String(overrides.phone ?? req.query.phone ?? "").trim();

  if (!id && !email && !phone) {
    return res.status(400).json({ error: "Provide id, email, or phone." });
  }

  try {
    let query = supabase.from("customers").select("*").limit(1);

    if (id)    query = query.eq("id", id);
    else if (email) query = query.eq("email", email);
    else       query = query.in("phone", buildPhoneVariants(phone));

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.error("Customer fetch error:", error.message);
      return res.status(500).json({ error: "Failed to fetch customer." });
    }

    if (!data) return res.status(404).json({ error: "Customer not found." });

    return res.json({ customer: data });
  } catch (err) {
    console.error("customer-details error:", err.message);
    return res.status(500).json({ error: "Unexpected error." });
  }
}

app.get("/api/customer-details", (req, res) => fetchCustomerDetails(req, res));
app.get("/api/customers/:id",    (req, res) => fetchCustomerDetails(req, res, { id: req.params.id }));

// -- Agent dial status callback (fired when agent call ends/fails) -
// Handles no-answer/busy/failed by first trying the general pool,
// then redirecting the waiting customer if still no one picks up.
app.post("/api/twilio/agent-status", async (req, res) => {
  res.status(200).end();

  const callId   = String(req.query.call_id  || "").trim();
  const identity = String(req.query.identity || "").trim();
  const status   = String(req.body.CallStatus || "").trim();

  console.log(`[agent-status] callId=${callId} identity=${identity} status=${status}`);

  if (!callId || !twilioClient) return;
  if (!["no-answer", "busy", "failed"].includes(status)) return;

  if (identity !== "agent_general") {
    // First failure — try the general pool as a fallback
    console.log(`[agent-status] No answer from ${identity} — trying agent_general`);
    const fallbackUrl = `${BASE_URL}/api/twilio/agent?call_id=${callId}`;
    twilioClient.calls.create({
      to:   "client:agent_general",
      from: TWILIO_PHONE_NUMBER,
      url:  fallbackUrl,
      statusCallback:       `${BASE_URL}/api/twilio/agent-status?call_id=${callId}&identity=agent_general`,
      statusCallbackEvent:  ["completed", "no-answer", "busy", "failed"],
      statusCallbackMethod: "POST",
      timeout: 15,
    }).then((call) => {
      console.log(`[agent-status] Fallback agent call created ✓ SID=${call.sid}`);
    }).catch((err) => {
      console.error(`[agent-status] Fallback dial FAILED: ${err.message}`);
      redirectCustomerToNoAgentMessage(callId);
    });
  } else {
    // General pool also failed — no agents available at all
    console.log(`[agent-status] No agents available — redirecting customer callId=${callId}`);
    redirectCustomerToNoAgentMessage(callId);
  }
});

// -- Recording status callback (Twilio fires when conference recording completes) --
app.post("/api/twilio/recording-status", async (req, res) => {
  res.status(200).end();

  const callId       = String(req.query.call_id            || "").trim();
  const sid          = String(req.body.RecordingSid         || "").trim();
  const status       = String(req.body.RecordingStatus      || "").trim();
  const duration     = parseInt(req.body.RecordingDuration  || "0", 10);
  const recordingUrl = String(req.body.RecordingUrl         || "").trim();

  if (!callId || !sid) {
    console.warn("[recording-status] Missing callId or RecordingSid — ignoring");
    return;
  }

  console.log(`[recording] callId=${callId} sid=${sid} status=${status} duration=${isNaN(duration) ? "?" : duration}s`);

  const { error } = await supabase.from("recordings").upsert({
    call_id:          callId,
    recording_sid:    sid,
    recording_url:    recordingUrl || null,
    duration_seconds: isNaN(duration) ? null : duration,
    status,
    completed_at:     status === "completed" ? new Date().toISOString() : null,
  }, { onConflict: "recording_sid" });

  if (error) console.error("[recording] Save error:", error.message);
  else console.log(`[recording] ${status} recording saved ✓ sid=${sid}`);
});

// -- Stream a Twilio recording to the browser (proxies with Basic Auth) --
app.get("/api/recordings/stream/:sid", async (req, res) => {
  const { sid } = req.params;
  if (!sid || !sid.startsWith("RE")) return res.status(404).end();
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return res.status(503).end();

  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  try {
    const upstream = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!upstream.ok) return res.status(upstream.status).end();
    const buffer = await upstream.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.byteLength);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(Buffer.from(buffer));
  } catch (err) {
    console.error("[recording-stream] Error:", err.message);
    if (!res.headersSent) res.status(502).end();
  }
});

// -- No-agent TwiML (played to customer when no agent answers) -
app.post("/api/twilio/no-agent-available", (_req, res) => {
  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">We are sorry, but all agents are currently unavailable. Please call back during business hours or visit our website for assistance. Thank you for calling BrightSuite.</Say>
  <Hangup/>
</Response>`);
});

// ── Start server ──────────────────────────────────────────────
function startServer(p) {
  server.listen(p, () =>
    console.log(`Agent-assist IVR server running on port ${p}`)
  );

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    if (hasExplicitPort) {
      console.error(`Port ${p} is in use. Set a different PORT in .env.`);
      process.exit(1);
    }
    console.warn(`Port ${p} busy. Retrying on ${p + 1}...`);
    startServer(p + 1);
  });
}

if (require.main === module) {
  runMigrations().then(() => startServer(port));
}

module.exports = { app, server };
