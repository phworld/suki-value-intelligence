const $ = (id) => document.getElementById(id);

const state = {
  audiences: new Set(["clinical", "operations", "financial", "executive"]),
  telemetry: {
    enabled: true,
    fileName: null,
    rawText: null,
    columns: [],
    sampleRows: [],
    summary: null
  },
  epicMapping: {},
  requiredFields: [
    { key: "provider_id", label: "Provider ID (or NPI hash)" },
    { key: "specialty", label: "Specialty" },
    { key: "encounters", label: "Encounter count" },
    { key: "doc_minutes_before", label: "Doc minutes (baseline)" },
    { key: "doc_minutes_after", label: "Doc minutes (post)" },
    { key: "after_hours_minutes_before", label: "After-hours minutes (baseline)" },
    { key: "after_hours_minutes_after", label: "After-hours minutes (post)" },
    { key: "adoption_rate", label: "Adoption rate (%)" },
    { key: "nps", label: "NPS" }
  ]
};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => (t.style.display = "none"), 2200);
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function readInputs() {
  const customerName = $("customerName").value.trim();
  const specialty = $("specialty").value;
  const physicianCount = Number($("physicianCount").value);
  const timeSavedHrsPerDay = Number($("timeSaved").value);
  const patientIncreasePerDay = Number($("patientIncrease").value);
  const adoptionRatePct = Number($("adoptionRate").value);
  const npsScore = Number($("npsScore").value);
  const burnoutImprovement = $("burnoutImprovement").value;
  const clinicalContext = $("clinicalContext").value.trim();

  const clinicalValidationMode = $("clinicalValidationMode").checked;

  const assumptions = {
    physicianHourlyRate: Number($("assumpRate").value),
    reimbursementPerVisit: Number($("assumpVisit").value),
    sukiCostPerPhysicianPerMonth: Number($("assumpCost").value),
    workDaysPerYear: Number($("assumpDays").value)
  };

  return {
    customerName,
    specialty,
    physicianCount,
    timeSavedHrsPerDay,
    patientIncreasePerDay,
    adoptionRatePct,
    npsScore,
    burnoutImprovement,
    clinicalContext,
    clinicalValidationMode,
    audiences: Array.from(state.audiences),
    assumptions
  };
}

function validateInputs(data) {
  if (!data.customerName) return "Customer name is required.";
  if (!data.specialty) return "Specialty is required.";
  if (!Number.isFinite(data.physicianCount) || data.physicianCount <= 0) return "Physician count must be > 0.";
  if (!Number.isFinite(data.timeSavedHrsPerDay) || data.timeSavedHrsPerDay < 0) return "Time saved must be >= 0.";
  if (!Number.isFinite(data.patientIncreasePerDay) || data.patientIncreasePerDay < 0) return "Patient capacity must be >= 0.";
  if (!Number.isFinite(data.adoptionRatePct) || data.adoptionRatePct < 50 || data.adoptionRatePct > 100) return "Adoption rate must be 50–100.";
  if (!Number.isFinite(data.npsScore) || data.npsScore < -100 || data.npsScore > 100) return "NPS must be -100–100.";
  if (data.audiences.length === 0) return "Select at least one audience.";
  return null;
}

function setupAudienceToggles() {
  document.querySelectorAll(".aopt").forEach((el) => {
    el.addEventListener("click", () => {
      const a = el.dataset.audience;
      if (state.audiences.has(a)) {
        state.audiences.delete(a);
        el.classList.remove("active");
      } else {
        state.audiences.add(a);
        el.classList.add("active");
      }
    });
  });
}

function setupAssumptionsToggle() {
  const box = $("assumptionsBox");
  const cb = $("showAssumptions");
  const apply = () => (box.style.display = cb.checked ? "block" : "none");
  cb.addEventListener("change", apply);
  apply();
}

function parseCSV(text) {
  // Minimal CSV parser (demo-safe). Expects header row.
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { columns: [], rows: [] };
  const columns = lines[0].split(",").map((s) => s.trim());
  const rows = lines.slice(1, 51).map((line) => {
    const parts = line.split(",").map((s) => s.trim());
    const obj = {};
    columns.forEach((c, i) => (obj[c] = parts[i] ?? ""));
    return obj;
  });
  return { columns, rows };
}

function parseJSON(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) {
    const columns = Object.keys(data[0] || {});
    const rows = data.slice(0, 50);
    return { columns, rows };
  }
  if (typeof data === "object" && data !== null) {
    // if it has "rows" array
    if (Array.isArray(data.rows)) {
      const columns = Object.keys(data.rows[0] || {});
      return { columns, rows: data.rows.slice(0, 50) };
    }
    const columns = Object.keys(data);
    return { columns, rows: [data] };
  }
  return { columns: [], rows: [] };
}

function computeTelemetrySummary(columns, rows, mapping) {
  // Build a tiny evidence summary: counts + simple deltas where possible
  const get = (row, key) => row[mapping[key]];

  const n = rows.length;
  let encountersTotal = 0;

  let docBeforeSum = 0;
  let docAfterSum = 0;
  let ahBeforeSum = 0;
  let ahAfterSum = 0;

  let adoptionVals = [];
  let npsVals = [];

  for (const r of rows) {
    const enc = Number(get(r, "encounters"));
    if (Number.isFinite(enc)) encountersTotal += enc;

    const db = Number(get(r, "doc_minutes_before"));
    const da = Number(get(r, "doc_minutes_after"));
    if (Number.isFinite(db)) docBeforeSum += db;
    if (Number.isFinite(da)) docAfterSum += da;

    const ab = Number(get(r, "after_hours_minutes_before"));
    const aa = Number(get(r, "after_hours_minutes_after"));
    if (Number.isFinite(ab)) ahBeforeSum += ab;
    if (Number.isFinite(aa)) ahAfterSum += aa;

    const ad = Number(get(r, "adoption_rate"));
    if (Number.isFinite(ad)) adoptionVals.push(ad);

    const nps = Number(get(r, "nps"));
    if (Number.isFinite(nps)) npsVals.push(nps);
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const summary = {
    loaded_rows: n,
    columns_detected: columns.slice(0, 40),
    mapping_used: mapping,
    encounter_total_sample: encountersTotal || null,
    doc_minutes_baseline_avg_sample: n ? docBeforeSum / n : null,
    doc_minutes_post_avg_sample: n ? docAfterSum / n : null,
    after_hours_minutes_baseline_avg_sample: n ? ahBeforeSum / n : null,
    after_hours_minutes_post_avg_sample: n ? ahAfterSum / n : null,
    adoption_rate_avg_sample: avg(adoptionVals),
    nps_avg_sample: avg(npsVals),
    notes: [
      "Telemetry summary is derived from uploaded sample rows only.",
      "All values are demo-safe; do not upload PHI."
    ]
  };

  return summary;
}

function setupTelemetry() {
  $("telemetryEnabled").addEventListener("change", (e) => {
    state.telemetry.enabled = e.target.checked;
    toast(state.telemetry.enabled ? "Telemetry enabled" : "Telemetry disabled");
  });

  $("telemetryFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    state.telemetry.fileName = file.name;
    state.telemetry.rawText = text;

    try {
      let parsed;
      if (file.name.toLowerCase().endsWith(".csv")) parsed = parseCSV(text);
      else parsed = parseJSON(text);

      state.telemetry.columns = parsed.columns || [];
      state.telemetry.sampleRows = parsed.rows || [];

      $("telemetryStatus").textContent =
        `Loaded: ${state.telemetry.fileName} · Columns: ${state.telemetry.columns.length} · Sample rows: ${state.telemetry.sampleRows.length}`;

      // Initialize default mapping if not set
      if (Object.keys(state.epicMapping).length === 0) {
        const guess = {};
        for (const f of state.requiredFields) {
          const found = state.telemetry.columns.find((c) => c.toLowerCase().includes(f.key.replaceAll("_", "")));
          guess[f.key] = found || "";
        }
        state.epicMapping = guess;
      }

      // Build summary if mapping is complete enough
      state.telemetry.summary = computeTelemetrySummary(
        state.telemetry.columns,
        state.telemetry.sampleRows,
        state.epicMapping
      );

      toast("Telemetry loaded");
    } catch (err) {
      console.error(err);
      $("telemetryStatus").textContent = "Failed to parse telemetry file.";
      toast("Telemetry parse error");
    }
  });
}

function openModal() {
  $("modalOverlay").style.display = "block";
  renderMapper();
}
function closeModal() {
  $("modalOverlay").style.display = "none";
}

function renderMapper() {
  const grid = $("mapgrid");
  grid.innerHTML = "";

  const columns = state.telemetry.columns.length ? state.telemetry.columns : [
    "provider_id", "specialty", "encounters",
    "doc_minutes_before", "doc_minutes_after",
    "after_hours_minutes_before", "after_hours_minutes_after",
    "adoption_rate", "nps"
  ];

  state.requiredFields.forEach((f) => {
    const row = document.createElement("div");
    row.className = "maprow";
    row.innerHTML = `
      <label>${f.label}</label>
      <select data-mapkey="${f.key}">
        <option value="">— not mapped —</option>
        ${columns.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
      </select>
    `;
    grid.appendChild(row);

    const sel = row.querySelector("select");
    sel.value = state.epicMapping[f.key] || "";
  });
}

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}

function setupModal() {
  $("openMapperBtn").addEventListener("click", openModal);
  $("closeModalBtn").addEventListener("click", closeModal);
  $("modalOverlay").addEventListener("click", (e) => {
    if (e.target === $("modalOverlay")) closeModal();
  });

  $("saveMappingBtn").addEventListener("click", () => {
    const mapping = {};
    document.querySelectorAll("[data-mapkey]").forEach((sel) => {
      mapping[sel.dataset.mapkey] = sel.value;
    });
    state.epicMapping = mapping;

    // Recompute summary if telemetry exists
    if (state.telemetry.sampleRows.length) {
      state.telemetry.summary = computeTelemetrySummary(
        state.telemetry.columns,
        state.telemetry.sampleRows,
        state.epicMapping
      );
      toast("Mapping saved + telemetry summary refreshed");
    } else {
      toast("Mapping saved");
    }

    closeModal();
  });

  $("resetMappingBtn").addEventListener("click", () => {
    state.epicMapping = {};
    renderMapper();
    toast("Mapping reset");
  });
}

function renderResults(resp) {
  $("results").style.display = "block";

  $("modelName").textContent = resp.model || "—";
  $("latency").textContent = resp.latency_ms != null ? `${resp.latency_ms} ms` : "—";

  const roiX = resp.financials?.roiX;
  $("roiX").textContent = roiX ? `${roiX.toFixed(1)}x` : "—";

  const annualValue = resp.financials?.annualTotalValue;
  $("annualValue").textContent = Number.isFinite(annualValue) ? fmtMoney(annualValue) : "—";

  const out = resp.output || {};
  const narratives = out.narratives || {};
  const grid = $("rgrid");
  grid.innerHTML = "";

  const cfg = {
    clinical: { title: "Clinical", sub: "Physicians / clinical leadership", icon: "🩺" },
    operations: { title: "Operations", sub: "COO / administrators", icon: "⚙️" },
    financial: { title: "Financial", sub: "CFO / board ROI", icon: "💰" },
    executive: { title: "Executive Summary", sub: "CEO/Board synthesis", icon: "📊" }
  };

  for (const key of ["clinical", "operations", "financial", "executive"]) {
    if (!state.audiences.has(key)) continue;
    const card = document.createElement("div");
    card.className = "rcard";
    card.innerHTML = `
      <div class="rhead">
        <div class="badge">${cfg[key].icon}</div>
        <div>
          <h4>${cfg[key].title}</h4>
          <p>${cfg[key].sub}</p>
        </div>
      </div>
      <div class="rbody">${narratives[key] || "—"}</div>
    `;
    grid.appendChild(card);
  }

  const caveats = $("caveats");
  caveats.innerHTML = "";
  (out.assumptions_and_caveats || []).forEach((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    caveats.appendChild(li);
  });

  const validation = $("validation");
  validation.innerHTML = "";
  (out.clinical_validation_checklist || []).forEach((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    validation.appendChild(li);
  });

  const actions = $("actions");
  actions.innerHTML = "";
  (out.next_best_actions || []).forEach((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    actions.appendChild(li);
  });

  toast("Narratives generated");
}

async function generate() {
  const data = readInputs();
  const err = validateInputs(data);
  if (err) {
    toast(err);
    return;
  }

  const btn = $("generateBtn");
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const payload = {
      ...data,
      telemetrySummary: state.telemetry.enabled ? state.telemetry.summary : null,
      epicMapping: state.telemetry.enabled ? state.epicMapping : null
    };

    const res = await fetch("/api/suki-value-intelligence/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    if (!json.ok) {
      console.error(json);
      toast(json.message || "Generation failed");
      return;
    }

    renderResults(json);
  } catch (e) {
    console.error(e);
    toast("Network/server error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate narratives with OpenAI";
  }
}

function init() {
  setupAudienceToggles();
  setupAssumptionsToggle();
  setupTelemetry();
  setupModal();
  $("generateBtn").addEventListener("click", generate);
}

init();