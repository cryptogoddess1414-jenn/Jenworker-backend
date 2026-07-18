// signals-worker.js — Daily signal watcher + LinkedIn engager tracking → Airtable Leads.
// Wire-in (server.js): require("./signals-worker")(app);
// Install: npm i node-cron   (already in package.json)
// Runs daily at 03:00 UTC, plus an on-demand trigger for testing/ops.
//
// This module owns two jobs:
//   1. Signal watcher — polls configured lead sources for "signals" (job changes,
//      funding, new listings, etc.) and files new matches as leads.
//   2. Engager tracker — checks who engaged with your recent LinkedIn posts
//      (likes/comments) and files them as leads.
//
// Neither upstream data source is wired to a specific vendor yet — plug in
// real calls where marked TODO. Both paths dedupe + write through
// airtable-leads.js so nothing downstream needs to change.
//
// Optional env var: SIGNALS_TRIGGER_KEY — if set, enables GET /internal/signals/run
// as a manual trigger, gated by ?key=<SIGNALS_TRIGGER_KEY>. Left unset, the route
// isn't registered at all.

const cron = require("node-cron");
const { addLead, existsInAirtable } = require("./airtable-leads");

// ---------- Signal watcher ----------
// A "signal" is anything indicating a company/person is newly in-market.
// Each result funnels through this shape before hitting Airtable:
//   { company, name, email, domain, linkedin, title, signal }
async function fetchSignals() {
  // TODO: replace with a real signal source (e.g. Apollo job-change search,
  // a news/job-postings feed, or a CRM webhook). Returning [] keeps the
  // worker safe to run with no source configured.
  return [];
}

async function runSignalWatcher() {
  let leads = [];
  try {
    leads = await fetchSignals();
  } catch (e) {
    console.error("[signals] fetch error:", e.message);
    return;
  }
  for (const lead of leads) {
    try {
      const dup = lead.email
        ? await existsInAirtable({ email: lead.email })
        : await existsInAirtable({ company: lead.company });
      if (dup) continue;
      await addLead({
        company: lead.company,
        name: lead.name,
        email: lead.email,
        source: `signal-${lead.signal}`,
        stage: "New",
        notes: [lead.title, lead.domain, lead.linkedin].filter(Boolean).join(" | "),
      });
    } catch (e) {
      console.error("[signals] lead write error:", e.message);
    }
  }
  console.log(`[signals] watcher run complete — ${leads.length} candidate(s) checked`);
}

// ---------- Engager tracker ----------
// Pulls likes/comments off your recent LinkedIn posts (LINKEDIN_ACCESS_TOKEN /
// LINKEDIN_AUTHOR_URN, same creds as the /api/linkedin/post route in server.js)
// and files engagers as leads.
async function fetchEngagers() {
  if (!process.env.LINKEDIN_ACCESS_TOKEN || !process.env.LINKEDIN_AUTHOR_URN) return [];
  // TODO: call LinkedIn's social actions / comments API for recent posts by
  // LINKEDIN_AUTHOR_URN and map each engager to { company, name, linkedin }.
  return [];
}

async function runEngagerTracker() {
  let engagers = [];
  try {
    engagers = await fetchEngagers();
  } catch (e) {
    console.error("[engagers] fetch error:", e.message);
    return;
  }
  for (const person of engagers) {
    try {
      if (await existsInAirtable({ company: person.company || person.name })) continue;
      await addLead({
        company: person.company || person.name,
        name: person.name,
        source: "linkedin-engager",
        stage: "New",
        notes: person.linkedin || "",
      });
    } catch (e) {
      console.error("[engagers] lead write error:", e.message);
    }
  }
  console.log(`[engagers] tracker run complete — ${engagers.length} engager(s) checked`);
}

async function runAll() {
  await runSignalWatcher();
  await runEngagerTracker();
}

module.exports = function attach(app) {
  cron.schedule("0 3 * * *", () => {
    runAll().catch((e) => console.error("[signals] daily run error:", e.message));
  });

  if (process.env.SIGNALS_TRIGGER_KEY) {
    app.get("/internal/signals/run", async (req, res) => {
      if (req.query.key !== process.env.SIGNALS_TRIGGER_KEY) return res.sendStatus(403);
      try {
        await runAll();
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  console.log("[signals] daily watcher scheduled (03:00 UTC)");
};
