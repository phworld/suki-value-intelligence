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

function money(n) {
  try {
    return `$${Math.round(n).toLocaleString()}`;
  } catch {
    return `$${Math.round(n)}`;
  }
}

function computeFinancials(input) {
  // Conservative defaults; illustrative unless telemetry validates
  const physicians = clamp(safeNum(input.physicianCount, 1), 1, 200000);
  const timeSaved = clamp(safeNum(input.timeSavedHrsPerDay, 0), 0, 8);
  const patientIncrease = clamp(safeNum(input.patientIncreasePerDay, 0), 0, 30);

  const fullyLoadedPhysicianRate = clamp(
    safeNum(input.assumptions?.physicianHourlyRate, 200),
    80,
    600
  );
  const reimbursementPerVisit = clamp(
    safeNum(input.assumptions?.reimbursementPerVisit, 150),
    40,
    1000
  );
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
   Robust parsing for Responses API
============================ */
function getResponseText(resp) {
  // Works across SDK versions
  return resp?.output_text || "";
}

function parseJsonSafely(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/* ============================
   HARD GUARDS (never let demo fail)
============================ */
function normalizeOutput(out) {
  const normalized = out && typeof out === "object" ? out : {};

  normalized.narratives =
    normalized.narratives && typeof normalized.narratives === "object"
      ? normalized.narratives
      : {};

  normalized.narratives.clinical =
    typeof normalized.narratives.clinical === "string" ? normalized.narratives.clinical : "";
  normalized.narratives.operations =
    typeof normalized.narratives.operations === "string" ? normalized.narratives.operations : "";
  normalized.narratives.financial =
    typeof normalized.narratives.financial === "string" ? normalized.narratives.financial : "";
  normalized.narratives.executive =
    typeof normalized.narratives.executive === "string" ? normalized.narratives.executive : "";

  normalized.assumptions_and_caveats = Array.isArray(normalized.assumptions_and_caveats)
    ? normalized.assumptions_and_caveats
    : [];

  normalized.clinical_validation_checklist = Array.isArray(normalized.clinical_validation_checklist)
    ? normalized.clinical_validation_checklist
    : [];

  normalized.next_best_actions = Array.isArray(normalized.next_best_actions)
    ? normalized.next_best_actions
    : [];

  normalized.next_best_actions = normalized.next_best_actions
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .slice(0, 3);

  while (normalized.next_best_actions.length < 3) {
    normalized.next_best_actions.push("Validate baseline + data provenance.");
  }

  normalized.assumptions_and_caveats = normalized.assumptions_and_caveats
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .slice(0, 10);

  normalized.clinical_validation_checklist = normalized.clinical_validation_checklist
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .slice(0, 10);

  return normalized;
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
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (customerName, specialty, audiences[])."
      });
    }

    const keep = new Set(audiences);

    const financials = computeFinancials({
      physicianCount,
      timeSavedHrsPerDay,
      patientIncreasePerDay,
      assumptions: payload.assumptions
    });

    const system = `
You are "Suki Value Intelligence" — a Customer Value & Clinical Impact narrative generator for a healthcare ambient documentation AI platform.

Rules:
- Be specific, executive-ready, and non-hype.
- Avoid medical claims. Do not claim improved clinical outcomes; focus on workflow/time/revenue-integrity mechanics.
- Clearly label any estimates as "illustrative unless validated by telemetry."
- If clinicalValidationMode=true, use conservative language and explicitly recommend validation steps.
- If telemetrySummary is present, treat it as higher-confidence evidence; still call out limitations.
- If epicMapping is present, reference it as provenance ("based on mapped fields from Epic exports") without revealing PHI.
- Output STRICT JSON ONLY that matches the schema provided. No markdown. No extra keys.

Constraints:
- If an audience is not requested, set that narrative to an empty string.
- Requested narratives should be 250–450 words with short headers + bullets.
- assumptions_and_caveats: 5–8 bullets
- clinical_validation_checklist: 5–8 bullets
- next_best_actions: EXACTLY 3 bullets
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

Requested audiences:
${audiences.join(", ")}

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

Calculated (illustrative):
- Annual labor productivity value: ${money(financials.annualLaborValue)}
- Annual revenue opportunity: ${money(financials.annualRevenueUplift)}
- Annual Suki cost: ${money(financials.annualSukiCost)}
- Annual total value: ${money(financials.annualTotalValue)}
- ROI multiple: ${financials.roiX ? financials.roiX.toFixed(1) + "x" : "N/A"}

IMPORTANT:
- Generate only requested audiences; set others to empty string.
- Return STRICT JSON only.
`;

    // ✅ JSON Schema for Responses API using text.format (NO response_format)
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
          },
          required: ["clinical", "operations", "financial", "executive"]
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

    // Parse (robust)
    let out = response.output_parsed;
    if (!out) {
      const txt = getResponseText(response);
      out = parseJsonSafely(txt);
    }

    // Normalize (never crash demo)
    out = normalizeOutput(out);

    // Enforce “only requested audiences populated”
    out.narratives = {
      clinical: keep.has("clinical") ? out.narratives.clinical : "",
      operations: keep.has("operations") ? out.narratives.operations : "",
      financial: keep.has("financial") ? out.narratives.financial : "",
      executive: keep.has("executive") ? out.narratives.executive : ""
    };

    const latency_ms = Date.now() - t0;

    res.json({
      ok: true,
      model: MODEL,
      latency_ms,
      financials,
      output: out
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