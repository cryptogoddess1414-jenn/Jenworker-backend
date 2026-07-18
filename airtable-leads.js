// airtable-leads.js — replaces the guessed "Prospects" mapping in server.js and signals-worker.js.
// Your ACTUAL CRM: base appo6KiZJGOto9bcA (the "Untitled Base" — rename it "Agentic Builder CRM"
// in the Airtable app), table "Leads".
//
// Railway env vars:
//   AIRTABLE_BASE_ID=appo6KiZJGOto9bcA
//   AIRTABLE_TABLE=Leads
//   AIRTABLE_TOKEN=<your personal access token>

const AT_URL = () =>
  `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE || "Leads")}`;

const atHeaders = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
});

// Dedup: match on Contact Email first, else Company Name.
async function existsInAirtable({ email, company }) {
  const clean = (s) => String(s || "").replace(/"/g, "");
  let formula = null;
  if (email) formula = `LOWER({Contact Email}) = "${clean(email).toLowerCase()}"`;
  else if (company) formula = `LOWER({Company Name}) = "${clean(company).toLowerCase()}"`;
  if (!formula) return false;
  const r = await fetch(`${AT_URL()}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`, {
    headers: atHeaders(),
  });
  const d = await r.json();
  return (d.records || []).length > 0;
}

// One writer for every pipeline: outreach logging, signal watcher, engagers, site CTAs.
// lead: { company, name, email, phone, industry, source, stage, score, notes }
async function addLead(lead) {
  const fields = {
    "Company Name": lead.company || lead.name || lead.email || "Unknown",
    "Contact Name": lead.name || "",
    "Contact Email": lead.email || "",
    "Lead Source": lead.source || "unknown",
    "Current Stage": lead.stage || "New",
    "Last Contact Date": new Date().toISOString().slice(0, 10),
    Notes: lead.notes || "",
  };
  if (lead.phone) fields["Contact Phone"] = lead.phone;
  if (lead.industry) fields["Industry Type"] = lead.industry; // typecast creates the option if new
  if (typeof lead.score === "number") fields["Lead Score"] = lead.score;

  const r = await fetch(AT_URL(), {
    method: "POST",
    headers: atHeaders(),
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`Airtable ${r.status}: ${e?.error?.message || "write failed"}`);
  }
  return (await r.json()).records[0].id;
}

module.exports = { addLead, existsInAirtable };

/* ------------------------------------------------------------------
HOW TO SWAP IN (three small edits):

1. server.js — /api/leads route body becomes:
     const { addLead, existsInAirtable } = require("./airtable-leads");
     if (!(await existsInAirtable({ email }))) {
       await addLead({ email, source: source || "site-cta", notes: prompt ? `Hero prompt: ${prompt}` : "" });
     }
     res.json({ ok: true });

2. signals-worker.js — delete its local existsInAirtable/addLead + AT_URL/atHeaders,
   import from "./airtable-leads", and map its lead objects:
     await addLead({
       company: lead.company, name: lead.name, email: lead.email,
       source: `signal-${lead.signal}`, industry: null, stage: "New",
       notes: [lead.title, lead.domain, lead.linkedin].filter(Boolean).join(" | "),
     });

3. Manual outreach logging (your 10/day): create each broker as
   source "outreach-re", stage "Contacted", industry "Real Estate" —
   or just add rows by hand in the app; same table either way.
------------------------------------------------------------------ */
