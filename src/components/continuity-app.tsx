"use client";

import Link from "next/link";
import { useState } from "react";

type Selection = {
  id: string; snapshotId: string; needId: string; status: string; title: string; merchantName: string;
  sourceProvider: string; externalId: string | null; sourceUrl: string | null;
  pricePaise: number; observedAt: string; attributes: Record<string, unknown>;
  evidence: { locationLabel?: string; deliveryText?: string; locationCompatibility?: "SUPPORTED_EVIDENCE" | "UNKNOWN" } | null;
};
type View = {
  mission: { id: string; goal: string; status: string; version: number; budgetPaise: number; reservedPaise: number; committedPaise: number; remainingPaise: number };
  spec: { location?: { source: "browser" | "manual" | "prompt"; label: string }; deadline?: string; deadlineText?: string; optimizationIntent?: string; preferences?: string[]; globalConstraints: Array<{ id: string; description: string; hard?: boolean }>; participants: Array<{ label: string; count?: number; role?: string }>; needs: Array<{ id: string; label: string; kind: string; required?: boolean; grounding?: { explicit: boolean; inferred: boolean; sourcePhrase: string | null }; rationale?: string; constraints?: string[]; requiredAttributes: Record<string, unknown>; dependencies: string[] }> };
  marketMode: string; outcomeStatus: string; repairAllowancePaise: number;
  selections: Selection[]; events: Array<{ id: string; type: string; data: Record<string, unknown>; createdAt: string }>;
  repairs?: Array<{ id: string; affectedNeedId: string; replacementSnapshotId: string; replacementTitle: string; replacementMerchant: string; oldPricePaise: number; newPricePaise: number; additionalSpendPaise: number; authorizedAdditionalSpendPaise: number; refundRequiredPaise: number; status: string }>;
  payments?: { original: Array<{ id: string; amount: number; status: string }>; repairs: Array<{ id: string; repairAttemptId: string; amount: number; status: string }> };
  decision: null | { profile: string; selectedPortfolio: string; requiresRevalidation: boolean; weights: Record<string, number>; portfolios: Array<{ type: string; label: string; itemSnapshotIds: string[]; totalPricePaise: number; missionUtility: number; marginalValue: number; tradeOff: string }> };
  assessments: Array<{ offerSnapshotId: string; title: string; identityConfidence: string; hardConstraints: { satisfied: boolean; failures: string[]; unknowns: string[] }; capabilityChecks?: Array<{ capability: string; operator: string; value: string | number | boolean; unit?: string; hard: boolean; provenance: string; observedValue: string | number | boolean | null; status: "VALID" | "MISMATCH" | "CAPABILITY_UNKNOWN"; evidenceSource: string | null }>; scores: { requirementFit: number; productQuality: number; communityReliability: number; evidenceConfidence: number; priceEfficiency: number; utility: number }; evidenceCounts: { officialSources: number; professionalSources: number; communityDiscussions: number; merchantSources: number }; recurringPositives: string[]; recurringNegatives: string[]; riskFlags: string[] }>;
  evidence: Array<{ id: string; offerSnapshotId: string; type: string; sourceName: string; sourceUrl: string | null; title: string; snippet: string | null; evidenceMode: string; productIdentityConfidence: string }>;
};
type Understanding = View["spec"] & { missionId: string; missionVersion: number; goal: string; budgetPaise: number };
declare global { interface Window { Razorpay?: new(options: Record<string, unknown>) => { open: () => void } } }

const money = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
class MissionRequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: { affectedNeedIds?: string[] }) { super(message); }
}
async function request<T>(url: string, options?: RequestInit) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = await response.json();
  if (!response.ok) throw new MissionRequestError(body?.error?.code ?? "MISSION_ERROR", body?.error?.message ?? "Mission operation failed", body?.error?.details);
  return body as T;
}
async function checkoutScript() {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout could not load"));
    document.head.appendChild(script);
  });
}

function MissionUnderstanding({ understanding }: { understanding: Understanding }) {
  const constraints = understanding.globalConstraints.filter((constraint) => constraint.hard !== false).map((constraint) => constraint.description);
  return <section className="mission-understanding">
    <small>UNDERSTANDING YOUR MISSION</small>
    <dl>
      <dt>Goal</dt><dd>{understanding.goal}</dd>
      <dt>People</dt><dd>{understanding.participants.length ? understanding.participants.map((participant) => participant.count ?? participant.label).join(", ") : "Not specified"}</dd>
      <dt>Location</dt><dd>{understanding.location?.label ?? "Not specified"}</dd>
      {(understanding.deadlineText || understanding.deadline) && <><dt>Deadline</dt><dd>{understanding.deadlineText ?? new Date(understanding.deadline!).toLocaleString()}</dd></>}
      <dt>Budget</dt><dd>{money(understanding.budgetPaise)}</dd>
      <dt>Optimization</dt><dd>{(understanding.optimizationIntent ?? "BEST_VALUE").replaceAll("_", " ")}</dd>
      <dt>Needs</dt><dd>{understanding.needs.map((need) => `${need.label} · ${need.kind.replaceAll("_", " ")} · ${need.grounding?.inferred ? "INFERRED FOR MISSION" : "REQUESTED"}`).join(", ")}</dd>
      <dt>Important constraints</dt><dd>{constraints.length ? constraints.join("; ") : "None specified"}</dd>
    </dl>
  </section>;
}

export function ContinuityApp() {
  const [goal, setGoal] = useState("Build me a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair.");
  const [authority, setAuthority] = useState("55000");
  const [repair, setRepair] = useState("1000");
  const [manualLocation, setManualLocation] = useState("");
  const [browserLocation, setBrowserLocation] = useState<{ source: "browser"; label: string; latitude: number; longitude: number; accuracyMeters?: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<"idle" | "finding" | "ready" | "denied" | "unavailable" | "unsupported">("idle");
  const [locationRequested, setLocationRequested] = useState(false);
  const [manualLocationOpen, setManualLocationOpen] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [understanding, setUnderstanding] = useState<Understanding | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function run(label: string, work: () => Promise<void>) { setBusy(label); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Mission failed"); } finally { setBusy(""); } }
  async function refresh(id = view?.mission.id) { if (id) setView(await request<View>(`/api/continuity/missions/${id}`)); }
  async function mutateView(work: (current: View) => Promise<View>) {
    const initial = view; if (!initial) return null;
    try { const next = await work(initial); setView(next); setError(""); return next; }
    catch (cause) {
      if (!(cause instanceof MissionRequestError) || !["STALE_PLAN", "MISSION_VERSION_MISMATCH"].includes(cause.code)) throw cause;
      const current = await request<View>(`/api/continuity/missions/${initial.mission.id}`); setView(current); setError("");
      const next = await work(current); setView(next); return next;
    }
  }
  function missionInput() {
    const location = manualLocation.trim() || browserLocation ? { manualLabel: manualLocation.trim() || undefined, browser: browserLocation ?? undefined } : undefined;
    return { goal, maximumAuthorityPaise: Math.round(Number(authority) * 100), repairAllowancePaise: Math.round(Number(repair) * 100), location };
  }
  async function understand() {
    await run("UNDERSTANDING YOUR MISSION", async () => setUnderstanding(await request<Understanding>("/api/continuity/compile", { method: "POST", body: JSON.stringify(missionInput()) })));
  }
  async function build() {
    if (!understanding) return;
    await run("SEARCHING MARKET · RESEARCHING EVIDENCE · OPTIMIZING AUTHORITY", async () => setView(await request<View>(`/api/continuity/missions/${understanding.missionId}/market`, { method: "POST", body: JSON.stringify({ missionVersion: understanding.missionVersion }) })));
  }
  function useCurrentLocation() {
    if (locationRequested) return;
    setLocationRequested(true);
    setLocationStatus("finding");
    if (!("geolocation" in navigator)) { setLocationStatus("unsupported"); setManualLocationOpen(true); return; }
    navigator.geolocation.getCurrentPosition(async (position) => {
      const coordinates = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      let label = "Current location";
      try { label = (await request<{ label: string }>("/api/location/reverse-geocode", { method: "POST", body: JSON.stringify(coordinates) })).label || label; } catch { /* Coordinates remain usable without a fabricated label. */ }
      setBrowserLocation({ source: "browser", label, ...coordinates, accuracyMeters: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : undefined });
      setLocationStatus("ready");
    }, (locationError) => {
      setLocationStatus(locationError.code === locationError.PERMISSION_DENIED ? "denied" : "unavailable");
      setManualLocationOpen(true);
    }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 });
  }
  async function replace(needId: string) { if (view) await run(view.marketMode === "live" ? `SEARCHING LIVE MARKET FOR REPLACEMENT… · PRESERVING ${view.spec.needs.length - 1} OF ${view.spec.needs.length} COMPONENTS` : "REPAIRING 1 COMPONENT", async () => { await mutateView(current => request<View>(`/api/continuity/missions/${current.mission.id}/replace`, { method: "POST", body: JSON.stringify({ needId, expectedVersion: current.mission.version }) })); }); }
  async function revalidate() { await run("REVALIDATING LIVE MARKET", async () => { await mutateView(current => request<View>(`/api/continuity/missions/${current.mission.id}/revalidate`, { method: "POST", body: JSON.stringify({ expectedVersion: current.mission.version }) })); }); }
  async function selectPortfolio(type: string) { await run("APPLYING PORTFOLIO", async () => { await mutateView(current => request<View>(`/api/continuity/missions/${current.mission.id}/portfolio`, { method: "POST", body: JSON.stringify({ type, expectedVersion: current.mission.version }) })); }); }
  async function report(needId: string) { await run("RECORDING OUTCOME ISSUE", async () => { await mutateView(current => request<View>(`/api/continuity/missions/${current.mission.id}/issues`, { method: "POST", body: JSON.stringify({ needId, issue: "Item unavailable" }) })); }); }
  async function pay() {
    if (!view) return;
    setBusy("REVALIDATING LIVE MARKET… · Checking prices and availability before money moves.");
    setError("");
    try {
      const current = view;
      const order = await request<{ providerOrderId: string; amount: number; currency: string; publicKeyId: string; marketRevalidated: boolean; view: View }>(`/api/missions/${current.mission.id}/payment-order`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: current.mission.version }) });
      if (order.view) { setView(order.view); setError(""); }
      setBusy(order.marketRevalidated ? "MARKET VERIFIED ✓ · OPENING RAZORPAY…" : "OPENING RAZORPAY TEST MODE…");
      await checkoutScript();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error("Razorpay Checkout could not load");
      await new Promise<void>((resolve, reject) => new Razorpay({ key: order.publicKeyId, amount: order.amount, currency: order.currency, order_id: order.providerOrderId, name: "MissionPay Continuity", description: "Razorpay Test Mode", handler: async (response: unknown) => { try { await request(`/api/missions/${view.mission.id}/payment-callback`, { method: "POST", body: JSON.stringify(response) }); await refresh(); resolve(); } catch (cause) { reject(cause); } }, modal: { ondismiss: () => reject(new Error("Test checkout closed")) } }).open());
    } catch (cause) {
      if (cause instanceof MissionRequestError && ["MARKET_CHANGED", "MISSION_OVER_AUTHORITY", "REVALIDATION_UNCERTAIN"].includes(cause.code)) {
        await refresh();
        setError(cause.code === "MARKET_CHANGED" ? "MARKET CHANGED · PAYMENT BLOCKED · Repair the highlighted component." : cause.code === "MISSION_OVER_AUTHORITY" ? "MARKET CHANGED · MISSION OVER AUTHORITY · Repair the highlighted component." : "MARKET VERIFICATION UNCERTAIN · PAYMENT BLOCKED · Repair the highlighted component.");
      } else setError(cause instanceof Error ? cause.message : "Payment preparation failed");
    } finally { setBusy(""); }
  }
  async function authorizeRepair(repairAttemptId: string) {
    if (!view) return;
    await run("AUTHORIZING ADDITIONAL REPAIR AUTHORITY", async () => {
      await request(`/api/continuity/missions/${view.mission.id}/repairs/${repairAttemptId}/authorize`, { method: "POST", body: JSON.stringify({ expectedVersion: view.mission.version }) });
      await refresh();
    });
  }
  async function payRepair(repairAttemptId: string) {
    if (!view) return;
    await run("OPENING RAZORPAY REPAIR PAYMENT", async () => {
      const order = await request<{ providerOrderId: string; amount: number; currency: string; publicKeyId: string }>(`/api/continuity/missions/${view.mission.id}/repair-payment-order`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ repairAttemptId, expectedVersion: view.mission.version }) });
      await checkoutScript();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error("Razorpay Checkout could not load");
      await new Promise<void>((resolve, reject) => new Razorpay({ key: order.publicKeyId, amount: order.amount, currency: order.currency, order_id: order.providerOrderId, name: "MissionPay Continuity Repair", description: "Razorpay Test Mode · Repair Payment", handler: async (response: unknown) => { try { await request(`/api/continuity/missions/${view.mission.id}/repair-payment-callback`, { method: "POST", body: JSON.stringify(response) }); await refresh(); resolve(); } catch (cause) { reject(cause); } }, modal: { ondismiss: () => reject(new Error("Repair checkout closed")) } }).open());
    });
  }

  if (!view) return <main className="continuity-hero"><nav><b>MISSIONPAY</b><Link href="/demo">SANDBOX DEMO ↗</Link></nav><section><div className="continuity-kicker">CONTINUITY TRANSACTION LAYER</div><h1>Payments authorize purchases.<br /><em>MissionPay authorizes missions.</em></h1><p>Describe the outcome. MissionPay compiles the requirements, observes the market, bounds financial authority, and keeps working after checkout.</p><div className="continuity-form"><label>WHAT DO YOU WANT ACCOMPLISHED?<textarea value={goal} onChange={event => { setGoal(event.target.value); setUnderstanding(null); }} /></label><div className="location-control"><small>LOCATION</small>{manualLocation ? <div><b>📍 {manualLocation}</b><button type="button" onClick={() => setManualLocationOpen(true)}>CHANGE</button></div> : browserLocation ? <div><b>📍 {browserLocation.label}</b><button type="button" onClick={() => setManualLocationOpen(true)}>CHANGE</button></div> : <div><button type="button" onClick={useCurrentLocation} disabled={locationRequested}>{locationStatus === "finding" ? "Finding your location..." : "USE MY CURRENT LOCATION"}</button><button type="button" onClick={() => setManualLocationOpen(true)}>ENTER MANUALLY</button></div>}{locationStatus === "ready" && !manualLocation && <span>Using your current location</span>}{locationStatus === "denied" && <span>Location permission was not granted. Enter a location to get location-aware results.</span>}{locationStatus === "unavailable" && <span>Your location is unavailable. Enter it manually to continue with location-aware results.</span>}{locationStatus === "unsupported" && <span>This browser does not support location. Enter it manually.</span>}{manualLocationOpen && <label>MANUAL LOCATION<input autoFocus value={manualLocation} placeholder="Varanasi, Delhi, Bengaluru, IIT BHU…" onChange={event => { setManualLocation(event.target.value); setUnderstanding(null); }} /></label>}</div><div className="continuity-fields"><label>MAXIMUM AUTHORITY ₹<input type="number" value={authority} onChange={event => { setAuthority(event.target.value); setUnderstanding(null); }} /></label><label>AUTO REPAIR ALLOWANCE ₹<input type="number" value={repair} onChange={event => { setRepair(event.target.value); setUnderstanding(null); }} /></label></div>{understanding && <MissionUnderstanding understanding={understanding} />}<button onClick={understanding ? build : understand} disabled={!!busy}>{busy || (understanding ? "SEARCH LIVE MARKET" : "UNDERSTAND MY MISSION")} <span>→</span></button>{error && <div className="continuity-error">{error}</div>}</div><div className="continuity-trust">AI proposes. <b>MissionPay authorizes.</b> Razorpay executes.</div></section></main>;

  const active = view.selections.filter(selection => selection.status !== "REPLACED");
  const paid = view.mission.status === "PAID";
  const repairRequired = ["REPAIR_PAYMENT_REQUIRED", "HUMAN_REAUTH_REQUIRED"].includes(view.outcomeStatus);
  const pendingRepair = view.repairs?.[0];
  const originalPayment = view.payments?.original.find(payment => payment.status === "CAPTURED");
  const latestRepairPayment = pendingRepair ? view.payments?.repairs.find(payment => payment.repairAttemptId === pendingRepair.id) : undefined;
  return <main className="continuity-control">
    <nav><b>MISSIONPAY / CONTINUITY</b><div><span className={`mode ${view.marketMode}`}>{view.marketMode === "live" ? "● LIVE MARKET" : "◇ SANDBOX MODE"}</span><button onClick={() => setView(null)}>NEW MISSION</button><Link href="/demo">SANDBOX DEMO</Link></div></nav>
    <header><div><small>MISSION GRAPH · {view.mission.id.slice(0, 8)}{view.spec.location ? ` · 📍 ${view.spec.location.label}` : ""}</small><h1>{view.mission.goal}</h1></div><div className="dual-status"><span>PAYMENT <b>{view.mission.status}</b></span><span>OUTCOME <b>{view.outcomeStatus}{paid ? " / UNVERIFIED" : ""}</b></span></div></header>
    {error && <div className="continuity-error wide">{error}</div>}
    <section className="continuity-authority"><div><small>INITIAL AUTHORITY</small><b>{money(view.mission.budgetPaise)}</b></div><div><small>AUTHORITY RESERVED</small><b>{money(view.mission.reservedPaise)}</b></div><div><small>COMMITTED</small><b>{money(view.mission.committedPaise)}</b></div><div><small>REPAIR AUTHORITY</small><b>{money(view.repairAllowancePaise)}</b></div></section>
    {view.decision && <section className="decision-panel"><header><div><small>MISSION OPTIMIZER</small><h2>Optimization: {view.decision.selectedPortfolio.replaceAll("_", " ")}</h2></div><span>{view.decision.requiresRevalidation ? "Selected portfolio requires live revalidation before payment." : "Selected portfolio is synchronized with mission authority."}</span></header><div>{view.decision.portfolios.map(portfolio => <article key={portfolio.type} className={view.decision?.selectedPortfolio === portfolio.type ? "selected" : ""}><small>{portfolio.label.toUpperCase()}{portfolio.type === "BEST_VALUE" ? " ★" : ""}</small><b>{money(portfolio.totalPricePaise)}</b><span>Mission utility {portfolio.missionUtility}/100</span><p>{portfolio.tradeOff}</p><button onClick={() => selectPortfolio(portfolio.type)} disabled={!!busy || paid || view.decision?.selectedPortfolio === portfolio.type}>{view.decision?.selectedPortfolio === portfolio.type ? "SELECTED" : "SELECT PORTFOLIO"}</button></article>)}</div></section>}
    {paid && view.outcomeStatus === "DEGRADED" && <div className="continuity-alert"><b>PAYMENT SUCCEEDED. MISSION DEGRADED.</b><span>Repairing the outcome, not restarting the cart.</span></div>}
    {paid && repairRequired && <div className="continuity-alert"><b>{view.outcomeStatus.replaceAll("_", " ")}</b><span>The captured payment is unchanged. New authority must be explicit before additional execution.</span></div>}
    {paid && pendingRepair?.status === "HUMAN_REAUTH_REQUIRED" && <div className="continuity-alert"><span>Repair requires {money(pendingRepair.additionalSpendPaise)} additional spend. Automatic repair authority: {money(pendingRepair.authorizedAdditionalSpendPaise)}.</span><button onClick={() => authorizeRepair(pendingRepair.id)} disabled={!!busy}>AUTHORIZE ADDITIONAL {money(pendingRepair.additionalSpendPaise - pendingRepair.authorizedAdditionalSpendPaise)}</button></div>}
    {paid && pendingRepair?.status === "REPAIR_AUTHORIZED" && <div className="continuity-alert"><span>Repair is within explicit authority. The original captured payment remains immutable.</span><button onClick={() => payRepair(pendingRepair.id)} disabled={!!busy}>PAY REPAIR {money(pendingRepair.additionalSpendPaise)} · RAZORPAY TEST MODE</button></div>}
    {paid && pendingRepair && pendingRepair.refundRequiredPaise > 0 && <div className="continuity-alert"><b>REFUND ACTION REQUIRED</b><span>{money(pendingRepair.refundRequiredPaise)} — no refund has been claimed or fabricated.</span></div>}
    <section className="continuity-graph"><div className="graph-root"><span>MISSION</span><b>{active.length} components</b><small>{money(view.mission.budgetPaise)} bounded authority{view.spec.location ? ` · ${view.spec.location.label}` : ""}</small></div><div className="continuity-nodes">{active.map((selection, index) => { const need = view.spec.needs.find(candidate => candidate.id === selection.needId); const supportedLocation = selection.evidence?.locationCompatibility === "SUPPORTED_EVIDENCE" && selection.evidence.locationLabel && selection.evidence.deliveryText; return <article key={selection.id} className={selection.status === "DEGRADED" ? "degraded" : ""}><div className="node-index">0{index + 1}</div><div className="node-state">{selection.status === "DEGRADED" ? "DEGRADED" : paid ? "OUTCOME ACTIVE" : "AUTHORITY RESERVED"}</div><h3>{need?.label}</h3><strong>{selection.title}</strong><p>{selection.merchantName} · {money(selection.pricePaise)}</p><div className="evidence"><span>Source: {selection.sourceProvider}</span>{view.spec.location && (supportedLocation ? <span>Delivery shown for {selection.evidence!.locationLabel}: {selection.evidence!.deliveryText}</span> : <span>Location compatibility: UNKNOWN</span>)}<span>Observed: {new Date(selection.observedAt).toLocaleTimeString()}</span>{selection.sourceUrl ? <a href={selection.sourceUrl} target="_blank" rel="noreferrer">View source ↗</a> : <span>Source URL unavailable</span>}</div><div className="node-actions">{!paid && <button onClick={() => replace(selection.needId)} disabled={!!busy}>REPLACE THIS</button>}{paid && selection.status !== "DEGRADED" && <button onClick={() => report(selection.needId)} disabled={!!busy}>REPORT ISSUE</button>}{paid && selection.status === "DEGRADED" && <button onClick={() => replace(selection.needId)} disabled={!!busy}>FIND REPLACEMENT</button>}</div></article>; })}</div></section>
    {view.assessments.length > 0 && <section className="why-panel"><header><small>EVIDENCE & DECISIONS</small><h2>Why these products?</h2></header>{active.map(selection => { const assessment = view.assessments.find(item => item.offerSnapshotId === selection.snapshotId); if (!assessment) return null; const sources = view.evidence.filter(item => item.offerSnapshotId === selection.snapshotId); return <details key={selection.snapshotId}><summary><span>{selection.title}</span><b>{assessment.scores.utility}/100 · {assessment.identityConfidence} confidence</b></summary><div className="why-grid"><section><h3>WHY VALID</h3><p>Verified requirement fit: {assessment.scores.requirementFit}/100</p><p>Product quality rank: {assessment.scores.productQuality}/100</p><p>Community reliability rank: {assessment.scores.communityReliability}/100</p><p>Price efficiency: {assessment.scores.priceEfficiency}/100</p>{(assessment.capabilityChecks ?? []).filter(check => check.hard).map(check => <p key={`${check.capability}-${check.provenance}`}><b>{check.capability.replaceAll("_", " ")}</b><br />Required: {String(check.value)}{check.unit ? ` ${check.unit}` : ""}<br />Observed: {check.observedValue === null ? "UNKNOWN" : String(check.observedValue)}<br />Capability: {check.status === "VALID" ? "VALID ✓" : check.status.replaceAll("_", " ")}{check.evidenceSource && <> · <a href={check.evidenceSource} target="_blank" rel="noreferrer">Evidence source ↗</a></>}</p>)}{assessment.recurringPositives.map(item => <p key={item}>✓ {item}</p>)}{assessment.recurringNegatives.map(item => <p key={item}>△ Recurring complaint: {item}</p>)}</section><section><h3>EVIDENCE</h3><p>Official specs: {assessment.evidenceCounts.officialSources}</p><p>Professional reviews: {assessment.evidenceCounts.professionalSources}</p><p>Community discussions: {assessment.evidenceCounts.communityDiscussions}</p><p>Confidence: {assessment.identityConfidence}</p>{sources.map(source => source.sourceUrl ? <a key={source.id} href={source.sourceUrl} target="_blank" rel="noreferrer">{source.type.replaceAll("_", " ")} · {source.evidenceMode.replaceAll("_", " ")} ↗</a> : <span key={source.id}>{source.type.replaceAll("_", " ")} · search evidence</span>)}</section></div></details>; })}</section>}
    <section className="continuity-actions"><div><small>{busy || (!paid ? view.decision?.requiresRevalidation ? "MARKET CHECK WILL RUN BEFORE PAYMENT" : "MISSION READY" : "PAYMENT CAPTURED · OUTCOME TRACKING ACTIVE")}</small><b>{!paid ? "Checkout ends at payment. MissionPay ends at outcome." : "Payment succeeded. MissionPay is still tracking the outcome."}</b></div>{!paid && <><button onClick={revalidate} disabled={!!busy}>LIVE REVALIDATE</button><button className="pay" onClick={pay} disabled={!!busy || view.mission.status !== "READY_TO_COMMIT"}>PAY WITH RAZORPAY TEST MODE</button></>}</section>
    <section className="continuity-receipt"><h2>MISSION RECEIPT</h2><div><span>Human goal</span><b>{view.mission.goal}</b><span>Components</span><b>{active.length}</b><span>Preserved components</span><b>{pendingRepair ? Math.max(0, active.length - 1) : active.length}</b><span>Replaced components</span><b>{view.selections.filter(selection => selection.status === "REPLACED").length}</b><span>Market sources</span><b>{[...new Set(active.map(selection => selection.sourceProvider))].join(", ")}</b>{originalPayment && <><span>Original payment</span><b>{money(originalPayment.amount)} · CAPTURED — Razorpay Test Mode</b></>}{pendingRepair && <><span>Continuity repair</span><b>{view.spec.needs.find(need => need.id === pendingRepair.affectedNeedId)?.label} → {pendingRepair.replacementTitle} · {pendingRepair.replacementMerchant} · +{money(pendingRepair.additionalSpendPaise)}</b><span>Repair payment</span><b>{latestRepairPayment ? `${money(latestRepairPayment.amount)} · ${latestRepairPayment.status} — Razorpay Test Mode` : "NOT YET CREATED"}</b></>}<span>Outcome</span><b>{view.outcomeStatus}{paid ? " / UNVERIFIED" : ""}</b></div></section>
  </main>;
}
