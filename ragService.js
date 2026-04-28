const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent";

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";

const EMBEDDING_DIMS = 768;

async function generateEmbedding(text) {
  const input = String(text || "").trim();
  if (!input) return null;

  const key = process.env.GEMINI_API_KEY;
  const res = await fetch(`${GEMINI_EMBED_URL}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: input }], role: "user" },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: EMBEDDING_DIMS,
    }),
  });

  if (!res.ok) throw new Error(`Gemini embed API ${res.status}`);
  const data = await res.json();
  const values = data.embedding?.values;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Empty embedding returned.");
  }

  return values;
}

async function searchKnowledge(supabase, embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return [];

  const { data, error } = await supabase.rpc("match_knowledge", {
    query_embedding: embedding,
    match_count: 3,
  });

  if (error) {
    if (error.code !== "PGRST202") {
      console.warn("Knowledge search error:", error.message);
    }
    return [];
  }

  return (data || []).map((r) => r.content).filter(Boolean);
}

async function generateGreeting(customerName, tier = "Regular") {
  const name = String(customerName || "").trim();
  if (!name) return null;

  const prompt = [
    `You are a call center agent greeting a ${tier} tier customer at the start of a support call.`,
    `Customer name: ${name}`,
    "",
    "Write a warm, professional opening greeting for the agent to say.",
    "Rules:",
    "- Maximum 2 sentences.",
    "- Use the customer's first name.",
    "- Do NOT mention any company name.",
    "- Keep it natural and conversational — not robotic.",
    "- Voice-friendly: short, clear sentences.",
    "Return only the greeting text — no labels, no quotes, no preamble.",
  ].join("\n");

  const key = process.env.GEMINI_API_KEY;
  try {
    const res = await fetch(`${GEMINI_GENERATE_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 80, temperature: 0.4 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    return text || `Hello ${name}, thank you for calling. How can I assist you today?`;
  } catch {
    return `Hello ${name}, thank you for calling. How can I assist you today?`;
  }
}

async function generateSuggestedReply(
  userInput,
  contextChunks,
  tier = "Regular",
  customerData = null,
  emotion = "calm"
) {
  const context = contextChunks.length > 0 ? contextChunks.join("\n\n") : null;

  const accountLines = [];
  if (customerData?.name)           accountLines.push(`Customer name: ${customerData.name}`);
  if (customerData?.tier)           accountLines.push(`Tier: ${customerData.tier}`);
  if (customerData?.billingContext) accountLines.push(`Recent bills:\n${customerData.billingContext}`);
  const accountSection = accountLines.length > 0
    ? `Customer account information:\n${accountLines.join("\n")}`
    : null;

  const isAngry = emotion === "angry" || emotion === "frustrated";
  const toneInstruction = isAngry
    ? [
        `IMPORTANT — The customer is ${emotion}. Start your reply with a genuine empathy phrase, for example:`,
        `"I completely understand your frustration, and I sincerely apologize for the inconvenience."`,
        `"I'm really sorry you're experiencing this — let me take care of it for you right now."`,
        `After the empathy opener, immediately give the resolution or next concrete step.`,
      ].join("\n")
    : "Use a warm, calm, and helpful tone throughout.";

  const prompt = [
    `You are coaching a call center agent handling a ${tier} tier customer.`,
    `Customer emotion: ${emotion}`,
    `The customer said: "${userInput}"`,
    "",
    accountSection || "",
    context
      ? `Retrieved account / knowledge base data:\n${context}`
      : "No specific account data found in the knowledge base.",
    "",
    toneInstruction,
    "",
    "Write the exact words the agent should say to the customer.",
    "Rules:",
    "- Do NOT start with 'Hello', 'Hi', or any greeting — the customer has already been greeted. Go straight to addressing their concern.",
    "- 1-3 short sentences. Voice-friendly — natural spoken language, no jargon.",
    "- If the retrieved data contains specific bill amounts, payment dates, due dates, or account figures, state them explicitly and precisely.",
    "- NEVER say 'I will look that up', 'let me check', or 'one moment' if the data is already present above — quote it directly.",
    "- If data is genuinely not available, acknowledge that clearly and offer the next step.",
    "- Address the customer by name if known.",
    "Return only the agent's reply text — no labels, no quotes, no preamble.",
  ].filter((line) => line !== "").join("\n");

  const key = process.env.GEMINI_API_KEY;
  const res = await fetch(`${GEMINI_GENERATE_URL}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.2 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

module.exports = { generateEmbedding, searchKnowledge, generateSuggestedReply, generateGreeting };
