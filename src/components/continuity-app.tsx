"use client";

import Link from "next/link";
import { useState } from "react";

type Selection = {
  id: string; needId: string; status: string; title: string; merchantName: string;
  sourceProvider: string; externalId: string | null; sourceUrl: string | null;
  pricePaise: number; observedAt: string; attributes: Record<string, unknown>;
  evidence: { locationLabel?: string; deliveryText?: string; locationCompatibility?: "SUPPORTED_EVIDENCE" | "UNKNOWN" } | null;
};
type View = {
  mission: { id: string; goal: string; status: string; version: number; budgetPaise: number; reservedPaise: number; committedPaise: number; remainingPaise: number };
  spec: { location?: { source: "browser" | "manual" | "prompt"; label: string }; needs: Array<{ id: string; label: string; requiredAttributes: Record<string, unknown>; dependencies: string[] }> };
  marketMode: string; outcomeStatus: string; repairAllowancePaise: number;
  selections: Selection[]; events: Array<{ id: string; type: string; data: Record<string, unknown>; createdAt: string }>;
  repairs?: Array<{ id: string; affectedNeedId: string; replacementSnapshotId: string; replacementTitle: string; replacementMerchant: string; oldPricePaise: number; newPricePaise: number; additionalSpendPaise: number; authorizedAdditionalSpendPaise: number; refundRequiredPaise: number; status: string }>;
  payments?: { original: Array<{ id: string; amount: number; status: string }>; repairs: Array<{ id: string; repairAttemptId: string; amount: number; status: string }> };
};
declare global { interface Window { Razorpay?: new(options: Record<string, unknown>) => { open: () => void } } }

const money = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
async function request<T>(url: string, options?: RequestInit) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "Mission operation failed");
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
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function run(label: string, work: () => Promise<void>) { setBusy(label); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Mission failed"); } finally { setBusy(""); } }
  async function refresh(id = view?.mission.id) { if (id) setView(await request<View>(`/api/continuity/missions/${id}`)); }
  async function build() {
    const location = manualLocation.trim() || browserLocation ? { manualLabel: manualLocation.trim() || undefined, browser: browserLocation ?? undefined } : undefined;
    await run("UNDERSTANDING MISSION", async () => setView(await request<View>("/api/continuity/missions", { method: "POST", body: JSON.stringify({ goal, maximumAuthorityPaise: Math.round(Number(authority) * 100), repairAllowancePaise: Math.round(Number(repair) * 100), location }) })));
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
  async function replace(needId: string) { if (view) await run(view.marketMode === "live" ? `SEARCHING LIVE MARKET FOR REPLACEMENT… · PRESERVING ${view.spec.needs.length - 1} OF ${view.spec.needs.length} COMPONENTS` : "REPAIRING 1 COMPONENT", async () => setView(await request<View>(`/api/continuity/missions/${view.mission.id}/replace`, { method: "POST", body: JSON.stringify({ needId, expectedVersion: view.mission.version }) }))); }
  async function revalidate() { if (view) await run("REVALIDATING LIVE MARKET", async () => setView(await request<View>(`/api/continuity/missions/${view.mission.id}/revalidate`, { method: "POST", body: JSON.stringify({ expectedVersion: view.mission.version }) }))); }
  async function report(needId: string) { if (view) await run("RECORDING OUTCOME ISSUE", async () => setView(await request<View>(`/api/continuity/missions/${view.mission.id}/issues`, { method: "POST", body: JSON.stringify({ needId, issue: "Item unavailable" }) }))); }
  async function pay() {
    if (!view) return;
    await run("OPENING RAZORPAY TEST MODE", async () => {
      const order = await request<{ providerOrderId: string; amount: number; currency: string; publicKeyId: string }>(`/api/missions/${view.mission.id}/payment-order`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: view.mission.version }) });
      await checkoutScript();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error("Razorpay Checkout could not load");
      await new Promise<void>((resolve, reject) => new Razorpay({ key: order.publicKeyId, amount: order.amount, currency: order.currency, order_id: order.providerOrderId, name: "MissionPay Continuity", description: "Razorpay Test Mode", handler: async (response: unknown) => { try { await request(`/api/missions/${view.mission.id}/payment-callback`, { method: "POST", body: JSON.stringify(response) }); await refresh(); resolve(); } catch (cause) { reject(cause); } }, modal: { ondismiss: () => reject(new Error("Test checkout closed")) } }).open());
    });
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

  if (!view) return <main className="continuity-hero"><nav><b>MISSIONPAY</b><Link href="/demo">SANDBOX DEMO ↗</Link></nav><section><div className="continuity-kicker">CONTINUITY TRANSACTION LAYER</div><h1>Payments authorize purchases.<br /><em>MissionPay authorizes missions.</em></h1><p>Describe the outcome. MissionPay compiles the requirements, observes the market, bounds financial authority, and keeps working after checkout.</p><div className="continuity-form"><label>WHAT DO YOU WANT ACCOMPLISHED?<textarea value={goal} onChange={event => setGoal(event.target.value)} /></label><div className="location-control"><small>LOCATION</small>{manualLocation ? <div><b>📍 {manualLocation}</b><button type="button" onClick={() => setManualLocationOpen(true)}>CHANGE</button></div> : browserLocation ? <div><b>📍 {browserLocation.label}</b><button type="button" onClick={() => setManualLocationOpen(true)}>CHANGE</button></div> : <div><button type="button" onClick={useCurrentLocation} disabled={locationRequested}>{locationStatus === "finding" ? "Finding your location..." : "USE MY CURRENT LOCATION"}</button><button type="button" onClick={() => setManualLocationOpen(true)}>ENTER MANUALLY</button></div>}{locationStatus === "ready" && !manualLocation && <span>Using your current location</span>}{locationStatus === "denied" && <span>Location permission was not granted. Enter a location to get location-aware results.</span>}{locationStatus === "unavailable" && <span>Your location is unavailable. Enter it manually to continue with location-aware results.</span>}{locationStatus === "unsupported" && <span>This browser does not support location. Enter it manually.</span>}{manualLocationOpen && <label>MANUAL LOCATION<input autoFocus value={manualLocation} placeholder="Varanasi, Delhi, Bengaluru, IIT BHU…" onChange={event => setManualLocation(event.target.value)} /></label>}</div><div className="continuity-fields"><label>MAXIMUM AUTHORITY ₹<input type="number" value={authority} onChange={event => setAuthority(event.target.value)} /></label><label>AUTO REPAIR ALLOWANCE ₹<input type="number" value={repair} onChange={event => setRepair(event.target.value)} /></label></div><button onClick={build} disabled={!!busy}>{busy || "BUILD MY MISSION"} <span>→</span></button>{error && <div className="continuity-error">{error}</div>}</div><div className="continuity-trust">AI proposes. <b>MissionPay authorizes.</b> Razorpay executes.</div></section></main>;

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
    {paid && view.outcomeStatus === "DEGRADED" && <div className="continuity-alert"><b>PAYMENT SUCCEEDED. MISSION DEGRADED.</b><span>Repairing the outcome, not restarting the cart.</span></div>}
    {paid && repairRequired && <div className="continuity-alert"><b>{view.outcomeStatus.replaceAll("_", " ")}</b><span>The captured payment is unchanged. New authority must be explicit before additional execution.</span></div>}
    {paid && pendingRepair?.status === "HUMAN_REAUTH_REQUIRED" && <div className="continuity-alert"><span>Repair requires {money(pendingRepair.additionalSpendPaise)} additional spend. Automatic repair authority: {money(pendingRepair.authorizedAdditionalSpendPaise)}.</span><button onClick={() => authorizeRepair(pendingRepair.id)} disabled={!!busy}>AUTHORIZE ADDITIONAL {money(pendingRepair.additionalSpendPaise - pendingRepair.authorizedAdditionalSpendPaise)}</button></div>}
    {paid && pendingRepair?.status === "REPAIR_AUTHORIZED" && <div className="continuity-alert"><span>Repair is within explicit authority. The original captured payment remains immutable.</span><button onClick={() => payRepair(pendingRepair.id)} disabled={!!busy}>PAY REPAIR {money(pendingRepair.additionalSpendPaise)} · RAZORPAY TEST MODE</button></div>}
    {paid && pendingRepair && pendingRepair.refundRequiredPaise > 0 && <div className="continuity-alert"><b>REFUND ACTION REQUIRED</b><span>{money(pendingRepair.refundRequiredPaise)} — no refund has been claimed or fabricated.</span></div>}
    <section className="continuity-graph"><div className="graph-root"><span>MISSION</span><b>{active.length} components</b><small>{money(view.mission.budgetPaise)} bounded authority{view.spec.location ? ` · ${view.spec.location.label}` : ""}</small></div><div className="continuity-nodes">{active.map((selection, index) => { const need = view.spec.needs.find(candidate => candidate.id === selection.needId); const supportedLocation = selection.evidence?.locationCompatibility === "SUPPORTED_EVIDENCE" && selection.evidence.locationLabel && selection.evidence.deliveryText; return <article key={selection.id} className={selection.status === "DEGRADED" ? "degraded" : ""}><div className="node-index">0{index + 1}</div><div className="node-state">{selection.status === "DEGRADED" ? "DEGRADED" : paid ? "OUTCOME ACTIVE" : "AUTHORITY RESERVED"}</div><h3>{need?.label}</h3><strong>{selection.title}</strong><p>{selection.merchantName} · {money(selection.pricePaise)}</p><div className="evidence"><span>Source: {selection.sourceProvider}</span>{view.spec.location && (supportedLocation ? <span>Delivery shown for {selection.evidence!.locationLabel}: {selection.evidence!.deliveryText}</span> : <span>Location compatibility: UNKNOWN</span>)}<span>Observed: {new Date(selection.observedAt).toLocaleTimeString()}</span>{selection.sourceUrl ? <a href={selection.sourceUrl} target="_blank" rel="noreferrer">View source ↗</a> : <span>Source URL unavailable</span>}</div><div className="node-actions">{!paid && <button onClick={() => replace(selection.needId)} disabled={!!busy}>REPLACE THIS</button>}{paid && selection.status !== "DEGRADED" && <button onClick={() => report(selection.needId)} disabled={!!busy}>REPORT ISSUE</button>}{paid && selection.status === "DEGRADED" && <button onClick={() => replace(selection.needId)} disabled={!!busy}>FIND REPLACEMENT</button>}</div></article>; })}</div></section>
    <section className="continuity-actions"><div><small>{busy || (!paid ? "MISSION READY" : "PAYMENT CAPTURED · OUTCOME TRACKING ACTIVE")}</small><b>{!paid ? "Checkout ends at payment. MissionPay ends at outcome." : "Payment succeeded. MissionPay is still tracking the outcome."}</b></div>{!paid && <><button onClick={revalidate} disabled={!!busy}>LIVE REVALIDATE</button><button className="pay" onClick={pay} disabled={!!busy || view.mission.status !== "READY_TO_COMMIT"}>PAY WITH RAZORPAY TEST MODE</button></>}</section>
    <section className="continuity-receipt"><h2>MISSION RECEIPT</h2><div><span>Human goal</span><b>{view.mission.goal}</b><span>Components</span><b>{active.length}</b><span>Preserved components</span><b>{pendingRepair ? Math.max(0, active.length - 1) : active.length}</b><span>Replaced components</span><b>{view.selections.filter(selection => selection.status === "REPLACED").length}</b><span>Market sources</span><b>{[...new Set(active.map(selection => selection.sourceProvider))].join(", ")}</b>{originalPayment && <><span>Original payment</span><b>{money(originalPayment.amount)} · CAPTURED — Razorpay Test Mode</b></>}{pendingRepair && <><span>Continuity repair</span><b>{view.spec.needs.find(need => need.id === pendingRepair.affectedNeedId)?.label} → {pendingRepair.replacementTitle} · {pendingRepair.replacementMerchant} · +{money(pendingRepair.additionalSpendPaise)}</b><span>Repair payment</span><b>{latestRepairPayment ? `${money(latestRepairPayment.amount)} · ${latestRepairPayment.status} — Razorpay Test Mode` : "NOT YET CREATED"}</b></>}<span>Outcome</span><b>{view.outcomeStatus}{paid ? " / UNVERIFIED" : ""}</b></div></section>
  </main>;
}
