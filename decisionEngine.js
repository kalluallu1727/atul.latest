const { normalizeEmotion } = require("./emotionService");
const { normalizeIntent, isHighStakesIntent } = require("./intentService");

const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent";

async function geminiGenerate(prompt, maxOutputTokens = 300, temperature = 0.2) {
  const key = process.env.GEMINI_API_KEY;
  const res = await fetch(`${GEMINI_GENERATE_URL}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens, temperature },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function buildAnalysisPrompt(userInput, tier, billingContext) {
  const lines = [
    "You are an AI assistant for call center agents. Analyze the customer speech below.",
    `Customer tier: ${tier || "Regular"}`,
    `Customer said: "${userInput}"`,
    "",
  ];

  if (billingContext) {
    lines.push("Customer billing data already retrieved:");
    lines.push(billingContext);
    lines.push("");
  }

  lines.push(
    "Return ONLY valid JSON — no markdown, no code blocks, no explanation:",
    JSON.stringify({
      emotion: "<calm|confused|frustrated|angry>",
      intent: "<snake_case intent e.g. billing_issue, payment_issue, cancellation, complaint, technical_support, account_inquiry, refund_request, general_inquiry>",
      suggested_actions: ["<specific action for human agent>", "<action2>", "<action3>"],
    }),
    "",
    "Rules:",
    "- emotion: exactly one of calm, confused, frustrated, angry",
    "- intent: snake_case label that best describes the customer's issue",
    billingContext
      ? "- suggested_actions: 2-3 RESOLUTION steps the agent should take. The billing data above is ALREADY available — do NOT suggest reviewing or checking the bill. Instead suggest concrete next steps like: offering a payment plan or extension, applying a one-time courtesy credit, explaining the specific charge that caused the increase, escalating to a billing supervisor, or processing an account adjustment."
      : "- suggested_actions: 2-3 specific, actionable steps the human agent should take right now",
  );

  return lines.join("\n");
}

function computePriority(emotion, intent, tier) {
  const tierLower = String(tier || "").toLowerCase();
  const isHighTier = tierLower === "platinum" || tierLower === "gold";
  const isAngry = emotion === "angry";
  const isFrustrated = emotion === "frustrated";
  const highStakes = isHighStakesIntent(intent);

  if (isAngry || (isFrustrated && highStakes) || (isHighTier && isAngry)) return "high";
  if (isFrustrated || (isHighTier && highStakes) || (highStakes && emotion !== "calm")) return "medium";
  return "low";
}

async function analyzeCustomerSpeech(userInput, customerTier = "Regular", billingContext = null) {
  const prompt = buildAnalysisPrompt(userInput, customerTier, billingContext);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 5000;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const raw = await geminiGenerate(prompt, 300, 0.2);
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const emotion = normalizeEmotion(parsed.emotion);
    const intent = normalizeIntent(parsed.intent);
    const suggested_actions = Array.isArray(parsed.suggested_actions)
      ? parsed.suggested_actions.filter(Boolean).slice(0, 3)
      : ["Listen carefully", "Address the customer's concern", "Offer an appropriate solution"];
    const priority = computePriority(emotion, intent, customerTier);

    return { emotion, intent, priority, suggested_actions };
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("analyzeCustomerSpeech timed out");
    } else {
      console.warn("analyzeCustomerSpeech error:", error.message);
    }
    return {
      emotion: "calm",
      intent: "general_inquiry",
      priority: "low",
      suggested_actions: [
        "Listen to the customer carefully",
        "Address their concern directly",
        "Offer an appropriate solution",
      ],
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

module.exports = { analyzeCustomerSpeech };
