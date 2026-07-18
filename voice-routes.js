// voice-routes.js — Missed-call text-back + AI voice receptionist.
// Wire-in (server.js):  require("./voice-routes")(app, server);
//   NOTE: needs the http server instance for the websocket —
//   change `app.listen(PORT, ...)` to:
//     const server = require("http").createServer(app);
//     require("./voice-routes")(app, server);
//     server.listen(PORT, () => console.log(`on :${PORT}`));
// Install: npm i ws
// Env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, PUBLIC_HOST (e.g. jenworker-api.up.railway.app)
//
// Twilio console setup (per client number):
//   Voice webhook  → POST https://<PUBLIC_HOST>/voice/incoming
//   Call status callback → POST https://<PUBLIC_HOST>/voice/status

const { WebSocketServer } = require("ws");
const { addLead, existsInAirtable } = require("./airtable-leads");

const twilioAuth = () =>
  "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");

async function sendSMS(to, body) {
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: { authorization: twilioAuth(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_NUMBER, Body: body }),
    }
  );
  if (!r.ok) console.error("sms error:", (await r.json())?.message);
}

module.exports = function attach(app, server) {
  // Twilio posts form-encoded bodies:
  const express = require("express");
  app.use("/voice", express.urlencoded({ extended: false }));

  // ---------- Incoming call → AI receptionist ----------
  app.post("/voice/incoming", (req, res) => {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${process.env.PUBLIC_HOST}/voice/relay"
      welcomeGreeting="Thanks for calling! I'm the automated assistant. How can I help you today?" />
  </Connect>
</Response>`);
  });

  // ---------- Missed / failed call → instant text-back ----------
  app.post("/voice/status", async (req, res) => {
    const { CallStatus, From } = req.body || {};
    if (["no-answer", "busy", "failed"].includes(CallStatus) && From && From.startsWith("+")) {
      await sendSMS(
        From,
        "Sorry we missed your call! What property or service are you reaching out about? Reply here and we'll get right back to you."
      );
      try {
        if (!(await existsInAirtable({ company: From }))) {
          await addLead({ company: From, phone: From, source: "missed-call", stage: "New",
            notes: `Missed call ${new Date().toISOString()} — text-back sent.` });
        }
      } catch (e) { console.error("missed-call lead error:", e.message); }
    }
    res.sendStatus(200);
  });

  // ---------- ConversationRelay websocket: Twilio transcribes, Claude replies, Twilio speaks ----------
  const wss = new WebSocketServer({ server, path: "/voice/relay" });
  wss.on("connection", (ws) => {
    const history = [];
    let callerNumber = null;

    ws.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === "setup") { callerNumber = msg.from || null; return; }
      if (msg.type !== "prompt" || !msg.voicePrompt) return;

      history.push({ role: "user", content: msg.voicePrompt });
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", // fast = natural on the phone
            max_tokens: 150,
            system:
              "You are a friendly phone receptionist for a real estate brokerage. Keep replies to 1-2 short " +
              "spoken sentences, no lists or formatting. Goals: learn what the caller needs (buying, selling, " +
              "renting, or reaching an agent), and collect their name and best callback number. Once you have " +
              "name + number + need, thank them and say an agent will call back shortly. Never invent listing " +
              "details, prices, or availability — say the agent will confirm specifics.",
            messages: history.slice(-12),
          }),
        });
        const data = await r.json();
        const reply = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ")
          || "I'm sorry, could you say that again?";
        history.push({ role: "assistant", content: reply });
        ws.send(JSON.stringify({ type: "text", token: reply, last: true }));
      } catch (e) {
        console.error("relay error:", e.message);
        ws.send(JSON.stringify({ type: "text", token: "I'm having trouble hearing you — an agent will call you back shortly.", last: true }));
      }
    });

    // Call ended → file the transcript as a lead
    ws.on("close", async () => {
      if (!history.length) return;
      const transcript = history.map((m) => `${m.role === "user" ? "Caller" : "AI"}: ${m.content}`).join("\n");
      try {
        await addLead({
          company: callerNumber || "Voice caller", phone: callerNumber || "",
          source: "voice-receptionist", stage: "New",
          notes: `Call transcript:\n${transcript.slice(0, 3000)}`,
        });
      } catch (e) { console.error("voice lead error:", e.message); }
    });
  });

  console.log("[voice] routes + relay websocket attached");
};
