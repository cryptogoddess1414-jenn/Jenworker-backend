// server.js — Jenworker / Agentic Builder backend (FINAL, all routes merged).
// Repo layout: server.js, airtable-leads.js, signals-worker.js, voice-routes.js, package.json, /public
// Deploy: push to GitHub → Railway auto-deploys. Set env vars in Railway → Variables:
//   ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID=appo6KiZJGOto9bcA, AIRTABLE_TABLE=Leads,
//   APOLLO_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, PUBLIC_HOST,
//   LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN   (LinkedIn ones optional until you set up the dev app)

const express = require("express");
const http = require("http");
const path = require("path");
const { addLead, existsInAirtable } = require("./airtable-leads");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Anthropic helper ----------
async function askClaude({ system, messages, model = "claude-sonnet-4-6", max_tokens = 1000 }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens, system, messages }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Anthropic API error");
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// ---------- POST /api/prospect — hero prompt → ICP plan ----------
app.post("/api/prospect", async (req, res) => {
  const { prompt, mode } = req.body || {};
  if (!prompt || prompt.trim().length < 3)
    return res.status(400).json({ error: "Describe the lead you want to find." });
  try {
    const text = await askClaude({
      system:
        "You are a B2B lead-targeting assistant. Given a description of an ideal customer (or a company domain), respond ONLY with JSON, no markdown fences, in this shape: " +
        '{"icp":{"title":"","industries":[],"company_size":"","signals":[]},"search_plan":["step1","step2"],"sample_outreach":{"subject":"","body":""}}',
      messages: [{ role: "user", content: `Mode: ${mode || "profile"}\nInput: ${prompt.trim()}` }],
      max_tokens: 1200,
    });
    res.json({ result: JSON.parse(text.replace(/```json|```/g, "").trim()) });
  } catch (err) {
    console.error("prospect error:", err.message);
    res.status(502).json({ error: "Couldn't generate a lead plan. Try again." });
  }
});

// ---------- POST /api/leads — CTA email capture → Airtable Leads ----------
app.post("/api/leads", async (req, res) => {
  const { email, source, prompt } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Enter a valid email." });
  try {
    if (!(await existsInAirtable({ email }))) {
      await addLead({
        email,
        source: source || "site-cta",
        stage: "New",
        notes: prompt ? `Hero prompt: ${prompt}` : "",
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("leads error:", err.message);
    res.status(502).json({ error: "Couldn't save your email. Try again." });
  }
});

// ---------- POST /api/chat — site chat widget ----------
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40)
    return res.status(400).json({ error: "Invalid conversation." });
  try {
    const reply = await askClaude({
      system:
        "You are the support assistant for Jenworker, an AI lead-generation product by Agentic Builder. " +
        "Help visitors understand the product: describe-your-customer prospecting, contact enrichment with " +
        "validation, and outreach drafting, across real estate, legal, healthcare, finance, and e-commerce. " +
        "Be concise and friendly. If asked about pricing or account issues, suggest the Start Free flow or " +
        "emailing the team. Don't invent features, guarantees, or specific numbers.",
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 4000),
      })),
      max_tokens: 600,
    });
    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(502).json({ error: "Chat is unavailable right now." });
  }
});

// ---------- POST /api/linkedin/post — publish to your profile ----------
app.post("/api/linkedin/post", async (req, res) => {
  const { text, visibility } = req.body || {};
  if (!text || text.trim().length < 2 || text.length > 3000)
    return res.status(400).json({ error: "Post text must be 2–3000 characters." });
  try {
    const r = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: process.env.LINKEDIN_AUTHOR_URN,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: text.trim() },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility":
            visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
        },
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.message || `LinkedIn ${r.status}`); // 401 = 60-day token expired
    }
    res.json({ ok: true, postId: r.headers.get("x-restli-id") });
  } catch (err) {
    console.error("linkedin post error:", err.message);
    res.status(502).json({ error: "Couldn't publish to LinkedIn." });
  }
});

// ---------- POST /api/enrich — LinkedIn profile URL → email via Apollo ----------
app.post("/api/enrich", async (req, res) => {
  const { linkedin_url } = req.body || {};
  if (!linkedin_url || !/linkedin\.com\/in\//i.test(linkedin_url))
    return res.status(400).json({ error: "Provide a linkedin.com/in/... profile URL." });
  try {
    const r = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.APOLLO_API_KEY },
      body: JSON.stringify({ linkedin_url, reveal_personal_emails: false }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || `Apollo ${r.status}`);
    const p = data.person;
    if (!p) return res.status(404).json({ error: "No match found for that profile." });
    res.json({
      name: p.name, title: p.title,
      company: p.organization?.name || null,
      email: p.email || null,
      email_status: p.email_status || "unknown",
      linkedin_url: p.linkedin_url,
    });
  } catch (err) {
    console.error("enrich error:", err.message);
    res.status(502).json({ error: "Enrichment failed. Try again." });
  }
});

// ---------- Attach modules: daily signal watcher + engagers, voice ----------
const server = http.createServer(app);
require("./signals-worker")(app);
require("./voice-routes")(app, server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Agentic Builder backend on :${PORT}`));
