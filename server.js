import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ============================
   Static Frontend
============================ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;

/* ============================
   OpenAI Setup
============================ */
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY not set. Add it to .env (local) or Render env vars.");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

/* ============================
   Helpers
============================ */
function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function computeFinancials(input) {
  // Conservative defaults; these are illustrative unless telemetry validates
  const physicians = clamp(safeNum(input.physicianCount, 1), 1, 200000);
  const timeSaved = clamp(safeNum(input.timeSavedHrsPerDay, 0), 0, 8);
  const patientIncrease = clamp(safeNum(input.patientIncreasePerDay, 0), 0, 30);

  const fullyLoadedPhysicianRate = clamp(safeNum(input.assumptions?.physicianHourlyRate, 200), 80, 600);
  const reimbursementPerVisit = clamp(safeNum(input.assumptions?.reimbursementPerVisit, 150), 40, 1000);
  const sukiCostPerPhysicianPerMonth = clamp(
    safeNum(input.assumptions?.sukiCostPerPhysicianPerMonth, 300),
    50,
    2000
  );

  const workDays = clamp(safeNum(input.assumptions?.workDaysPerYear, 250), 180, 365);

  const annualLaborValue = physicians * timeSaved * fullyLoadedPhysicianRate * workDays;
  const annualRevenueUplift = physicians * patientIncrease * reimbursementPerVisit * workDays;

  const annualSukiCost = physicians * sukiCostPerPhysicianPerMonth * 12;
  const annualTotalValue = annualLaborValue + annualRevenueUplift;
  const roiX = annualSukiCost > 0 ? annualTotalValue / annualSukiCost : null;

  return {
    assumptionsUsed: {
      fullyLoadedPhysicianRate,
      reimbursementPerVisit,
      sukiCostPerPhysicianPerMonth,
      workDays
    },
    annualLaborValue,
    annualRevenueUplift,
    annualSukiCost,
    annualTotalValue,
    roiX
  };
}

/* ============================
   API: Generate Narratives
============================ */
app.post("/api/suki-value-intelligence/translate", async (req, res) => {
  const t0 = Date.now();
  try {
    const payload = req.body || {};
    const {
      customerName,
      specialty,
      physicianCount,
      timeSavedHrsPerDay,
      patientIncreasePerDay,
      burnoutImprovement,
      adoptionRatePct,
      npsScore,
      clinicalContext,
      audiences,
      clinicalValidationMode,
      epicMapping,
      telemetrySummary
    } = payload;

    if (!customerName || !specialty || !Array.isArray(audiences) || audiences.length === 0) {
      return res.status(400).json({ error: "Missing required fields (customerName, specialty, audiences[])." });
    }

    // Compute illustrative financials for CFO/executive narratives
    const financials = computeFinancials({
      physicianCount,
      timeSavedHrsPerDay,
      patientIncreasePerDay,
      assumptions: payload.assumptions
    });

    const system = `
You are "Suki Value Intelligence" — a Customer Value & Clinical Impact narrative generator for a healthcare ambient documentation AI platform.

You must:
- Be specific, executive-ready, and non-hype.
- Avoid medical claims.
- Clearly label any estimates as "illustrative unless validated by telemetry."
- Use conservative language when clinicalValidationMode=true.
- Output STRICT JSON that matches the provided JSON schema.

If telemetrySummary is present, treat it as higher-confidence evidence; still call out limitations.
If epicMapping is present, reference it as provenance (e.g., "based on mapped fields from Epic exports") without revealing sensitive PHI.

Write narratives that sound like:
- A Medical Director speaking to clinicians
- An Operations leader speaking to administrators
- A CFO speaking to finance/board
- An Executive sponsor summarizing the whole picture

Also include a "clinical_validation_checklist" (5-8 bullets) that a clinical lead would use to validate the claims.
`;

    const user = `
INPUT
Customer:
- Name: ${customerName}
- Specialty: ${specialty}
- Physicians using solution: ${safeNum(physicianCount, 0)}
- Time saved per physician per day (hours): ${safeNum(timeSavedHrsPerDay, 0)}
- Additional patient capacity per physician per day: ${safeNum(patientIncreasePerDay, 0)}
- Burnout improvement: ${burnoutImprovement || "Not provided"}
- Adoption rate (%): ${safeNum(adoptionRatePct, 0)}
- NPS: ${safeNum(npsScore, 0)}
- Clinical context: ${clinicalContext || "None"}

Flags:
- clinicalValidationMode: ${clinicalValidationMode ? "true" : "false"}

Telemetry summary (optional; may be mock):
${telemetrySummary ? JSON.stringify(telemetrySummary, null, 2) : "None"}

Epic column mapping (optional):
${epicMapping ? JSON.stringify(epicMapping, null, 2) : "None"}

ILLUSTRATIVE FINANCIALS (unless validated by telemetry):
- Fully-loaded physician rate: $${financials.assumptionsUsed.fullyLoadedPhysicianRate}/hr
- Reimbursement per visit: $${financials.assumptionsUsed.reimbursementPerVisit}
- Suki cost per physician per month: $${financials.assumptionsUsed.sukiCostPerPhysicianPerMonth}
- Work days per year: ${financials.assumptionsUsed.workDays}

Calculated:
- Annual labor productivity value: $${Math.round(financials.annualLaborValue).toLocaleString()}
- Annual revenue opportunity: $${Math.round(financials.annualRevenueUplift).toLocaleString()}
- Annual Suki cost: $${Math.round(financials.annualSukiCost).toLocaleString()}
- Annual total value: $${Math.round(financials.annualTotalValue).toLocaleString()}
- ROI multiple: ${financials.roiX ? financials.roiX.toFixed(1) + "x" : "N/A"}

Requested audiences:
${audiences.join(", ")}

OUTPUT REQUIREMENTS:
- Provide 1 narrative per requested audience key:
  clinical, operations, financial, executive
- Each narrative: 250–450 words, structured with short headers and bullets.
- Include "assumptions_and_caveats" (5-8 bullets).
- Include "clinical_validation_checklist" (5-8 bullets).
- Include "next_best_actions" (exactly 3 bullets).
`;

    // JSON Schema output for the Responses API (new format via text.format)
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        narratives: {
          type: "object",
          additionalProperties: false,
          properties: {
            clinical: { type: "string" },
            operations: { type: "string" },
            financial: { type: "string" },
            executive: { type: "string" }
          }
        },
        assumptions_and_caveats: {
          type: "array",
          minItems: 5,
          maxItems: 10,
          items: { type: "string" }
        },
        clinical_validation_checklist: {
          type: "array",
          minItems: 5,
          maxItems: 10,
          items: { type: "string" }
        },
        next_best_actions: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: { type: "string" }
        }
      },
      required: ["narratives", "assumptions_and_caveats", "clinical_validation_checklist", "next_best_actions"]
    };

    const response = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "suki_value_intelligence_output",
          schema,
          strict: true
        }
      }
    });

    const out = response.output_parsed; // parsed JSON when using json_schema format
    const latency_ms = Date.now() - t0;

    // Only return narratives the user asked for, but keep schema stable
    const filtered = { ...out };
    const keep = new Set(audiences);
    const narr = filtered.narratives || {};
    filtered.narratives = {
      clinical: keep.has("clinical") ? narr.clinical || "" : "",
      operations: keep.has("operations") ? narr.operations || "" : "",
      financial: keep.has("financial") ? narr.financial || "" : "",
      executive: keep.has("executive") ? narr.executive || "" : ""
    };

    res.json({
      ok: true,
      model: MODEL,
      latency_ms,
      financials,
      output: filtered
    });
  } catch (err) {
    console.error("❌ Suki Value Intelligence error:", err);
    res.status(500).json({
      ok: false,
      error: "Suki Value Intelligence failed",
      message: err?.message || "Unknown error"
    });
  }
});

/* ============================
   Health Check
============================ */
app.get("/health", (req, res) => res.json({ ok: true }));

/* ============================
   Start Server
============================ */
app.listen(PORT, () => {
  console.log(`🚀 Suki Value Intelligence running at http://localhost:${PORT}`);
});