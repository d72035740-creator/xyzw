"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Amount = { amountPaise: number; display: string };
type ViewReservation = {
  id: string; offerId: string; offerCode: string | null; offerName: string; merchantName: string;
  category: "CAKE" | "FLOWERS" | "RESTAURANT"; categoryLabel: string;
  status: "HELD" | "RELEASED" | "INVALID" | "COMMITTED" | "EXPIRED";
  reservedAmount: number; reservedDisplay: string; currentAmount: number; currentDisplay: string;
  priceDeltaAmount: number; readyAt: string; readyTimeDisplay: string; available: boolean;
  offerVersion: number; vegetarian: boolean | null; servesPeople: number | null; isCurrent: boolean;
};
export type MissionView = {
  mission: { id: string; goal: string; title: string; status: string; statusCopy: string; version: number; deadline: string; isProcessing: boolean };
  financialAuthority: { authorized: Amount; reserved: Amount; remaining: Amount; committed: Amount; potential: Amount; overAuthority: Amount };
  constraints: Array<{ key: string; label: string; satisfied: boolean }>;
  items: Array<{ category: string; label: string; reservation: ViewReservation | null }>;
  reservations: ViewReservation[];
  worldChange: { title: string; message: string } | null;
  operationIssue: { code: string; message: string } | null;
  latestPlan: { status: string; rationale: string | null; reasons: Array<{ category: string; reason: string }> } | null;
  latestRepair: { status: string; rationale: string | null; changedItems: number; preservedReservationIds: string[]; releasedReservationIds: string[]; replacementReservationIds: string[] } | null;
  timeline: Array<{ id: string; type: string; missionVersion: number; at: string; message: string }>;
  availableActions: { canPlan: boolean; canRepair: boolean; canSimulateMarketChange: boolean; canResetDemo: boolean; canProceedToPayment: boolean; canRetryPayment: boolean };
  payment: { status: string; paymentOrderId: string; providerOrderId: string | null; amount: Amount; currency: string; providerPaymentId: string | null; providerStatus: string | null } | null;
};

const sampleGoal = "Plan my birthday evening under ₹8,000. I need a cake, flowers and vegetarian dinner for four. Everything should be ready before 8 PM.";

declare global { interface Window { Razorpay?: new (options: Record<string, unknown>) => { open: () => void }; } }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body?.error;
    throw new Error(error?.message ? `${error.message}${error.code ? ` (${error.code})` : ""}` : "MissionPay could not complete that request.");
  }
  return body as T;
}

function Mark({ ok }: { ok: boolean }) {
  return <span className={`check ${ok ? "check-ok" : "check-off"}`} aria-hidden="true">{ok ? "✓" : "×"}</span>;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>;
}

function MissionGlyph() {
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 7 38 15v17L24 40 10 32V15Z"/><circle cx="24" cy="23" r="6"/><path d="M24 7v10M10 15l9 5m19-5-9 5M24 29v11"/></svg>;
}

export function MissionDemo() {
  const [view, setView] = useState<MissionView | null>(null);
  const [goal, setGoal] = useState(sampleGoal);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (id = missionId) => {
    if (!id) return;
    try {
      const result = await api<{ view: MissionView }>(`/api/missions/${id}/view`, { cache: "no-store" });
      setView(result.view);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to refresh mission state.");
    }
  }, [missionId]);

  const missionStatus = view?.mission.status;
  useEffect(() => {
    if (!missionId) return;
    const delay = view?.mission.isProcessing ? 750 : 4000;
    const timer = window.setInterval(() => void refresh(missionId), delay);
    return () => window.clearInterval(timer);
  }, [missionId, missionStatus, refresh, view?.mission.isProcessing]);

  async function run(label: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(null);
    try { await operation(); } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The request failed safely.");
    } finally { setBusy(null); }
  }

  async function createAndPlan() {
    await run("authorizing", async () => {
      await fetch("/api/dev/demo/reset-world", { method: "POST" }).catch(() => undefined);
      const created = await api<{ mission: { id: string; version: number } }>("/api/missions", {
        method: "POST",
        body: JSON.stringify({ goal, budgetAmount: 800000, deadline: "2030-01-01T20:00:00+05:30", constraints: { people: 4, vegetarian: true }, requiredCategories: ["CAKE", "FLOWERS", "RESTAURANT"] }),
      });
      setMissionId(created.mission.id);
      await refresh(created.mission.id);
      await api(`/api/missions/${created.mission.id}/plan`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: created.mission.version }) });
      await refresh(created.mission.id);
    });
  }

  async function simulateChange() {
    const r1 = view?.reservations.find((reservation) => reservation.isCurrent && reservation.offerCode === "R1");
    if (!r1) return;
    await run("changing", async () => {
      await api(`/api/dev/offers/${r1.offerId}/simulate-change`, { method: "POST", body: JSON.stringify({ expectedOfferVersion: r1.offerVersion, amount: 635000 }) });
      await refresh();
    });
  }

  async function repair() {
    if (!view) return;
    await run("repairing", async () => {
      await api(`/api/missions/${view.mission.id}/repair`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: view.mission.version }) });
      await refresh();
    });
  }

  async function pay() {
    if (!view) return;
    await run("paying", async () => {
      const order = await api<{ paymentOrderId: string; providerOrderId: string; amount: number; currency: string; publicKeyId: string }>(`/api/missions/${view.mission.id}/payment-order`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: view.mission.version }) });
      if (!order.providerOrderId || !order.publicKeyId) throw new Error("Payment checkout is not configured.");
      await new Promise<void>((resolve, reject) => {
        const openCheckout = () => {
          if (!window.Razorpay) { reject(new Error("Razorpay Checkout could not load.")); return; }
          const checkout = new window.Razorpay({ key: order.publicKeyId, amount: order.amount, currency: order.currency, order_id: order.providerOrderId, name: "MissionPay", description: "Mission authority payment", handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => { try { await api(`/api/missions/${view.mission.id}/payment-callback`, { method: "POST", body: JSON.stringify(response) }); await refresh(); resolve(); } catch (nextError) { reject(nextError); } }, modal: { ondismiss: () => reject(new Error("Checkout closed before payment was captured.")) } });
          checkout.open();
        };
        if (window.Razorpay) openCheckout(); else { const script = document.createElement("script"); script.src = "https://checkout.razorpay.com/v1/checkout.js"; script.onload = openCheckout; script.onerror = () => reject(new Error("Razorpay Checkout could not load.")); document.body.appendChild(script); }
      });
    });
  }

  async function reset() {
    await run("resetting", async () => {
      if (view?.availableActions.canResetDemo) await api("/api/dev/demo/reset-world", { method: "POST" });
      setMissionId(null); setView(null);
    });
  }

  if (!view) return <CreationScreen goal={goal} setGoal={setGoal} onCreate={createAndPlan} busy={busy} error={error} />;
  return <MissionControl view={view} busy={busy} error={error} onSimulate={simulateChange} onRepair={repair} onPay={pay} onReset={reset} />;
}

function CreationScreen({ goal, setGoal, onCreate, busy, error }: { goal: string; setGoal: (value: string) => void; onCreate: () => void; busy: string | null; error: string | null }) {
  return <main className="creation-shell">
    <nav className="topbar"><Link className="brand" href="/"><BrandMark />MISSIONPAY</Link><span className="demo-pill">LIVE DEMO · NO PAYMENT</span></nav>
    <section className="hero">
      <div className="eyebrow"><span /> MISSION AUTHORITY</div>
      <h1>One goal.<br />One authorization.<br /><em>Many merchants.</em></h1>
      <p className="hero-copy">Describe the outcome. MissionPay plans the moving parts, reserves authority across merchants, and validates the whole mission before money can move.</p>
      <div className="mission-composer">
        <label htmlFor="mission-goal">YOUR MISSION</label>
        <textarea id="mission-goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={4} />
        <div className="composer-footer"><div><small>MAXIMUM AUTHORITY</small><strong>₹8,000</strong></div><button className="primary-button" onClick={onCreate} disabled={Boolean(busy) || !goal.trim()}>{busy ? "BUILDING MISSION…" : "AUTHORIZE MISSION"}<span>→</span></button></div>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <p className="trust-line"><span>AI</span> may plan. <span>MISSIONPAY</span> controls the money.</p>
    </section>
    <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
  </main>;
}

export function MissionControl({ view, busy, error, onSimulate, onRepair, onPay, onReset }: { view: MissionView; busy: string | null; error: string | null; onSimulate: () => void; onRepair: () => void; onPay: () => void; onReset: () => void }) {
  const isInvalid = view.mission.status === "INVALIDATED";
  const repaired = Boolean(view.latestRepair?.status === "SUCCEEDED");
  const reasonTitle = repaired ? "Why this repair?" : "Why this plan?";
  return <main className={`control-shell state-${view.mission.status.toLowerCase()}`}>
    <nav className="topbar control-nav"><Link className="brand" href="/"><BrandMark />MISSIONPAY</Link><div className="nav-right"><span className="live-dot">LIVE AUTHORITY</span><button className="text-button" onClick={onReset} disabled={Boolean(busy)}>Reset demo</button></div></nav>
    <header className="mission-header">
      <div><div className="eyebrow"><span /> MISSION CONTROL / {view.mission.id.slice(0, 8).toUpperCase()}</div><h1>{view.mission.title}</h1><p>{view.mission.goal}</p></div>
      <div className={`status-badge status-${view.mission.status.toLowerCase()}`}><i /><div><small>MISSION STATUS</small><strong>{view.mission.status.replaceAll("_", " ")}</strong><span>{view.mission.statusCopy}</span></div></div>
    </header>
    {view.worldChange && <section className="world-alert" role="status"><div className="alert-icon">!</div><div><small>{view.worldChange.title}</small><strong>{view.worldChange.message}</strong></div><div className="authority-breach"><span>Potential total <b>{view.financialAuthority.potential.display}</b></span><span>Over authority <b>+{view.financialAuthority.overAuthority.display}</b></span></div></section>}
    {repaired && <section className="restored-banner"><span>✓</span><div><small>MISSION RESTORED</small><strong>Only {view.latestRepair?.changedItems} component changed. The rest of the mission stayed intact.</strong></div></section>}
    {view.payment?.status === "CAPTURED" && <section className="payment-captured"><span>✓</span><div><small>PAYMENT CAPTURED</small><strong>{view.payment.amount.display}</strong><p>Customer payment captured. Merchant distribution is next.</p></div></section>}
    {(error || view.operationIssue) && <div className="error-banner" role="alert"><strong>Mission remains safe.</strong> {error ?? view.operationIssue?.message}<button onClick={() => location.reload()}>Refresh state</button></div>}
    <section className="authority-strip" aria-label="Financial authority"><AuthorityStat label="Authorized" amount={view.financialAuthority.authorized} /><AuthorityStat label="Reserved" amount={view.financialAuthority.reserved} accent /><AuthorityStat label="Remaining" amount={view.financialAuthority.remaining} /><AuthorityStat label="Committed" amount={view.financialAuthority.committed} muted note="No money moved" /></section>
    <div className="control-grid">
      <section className="mission-graph panel">
        <div className="panel-heading"><div><small>LIVE MISSION GRAPH</small><h2>One outcome, three reservations</h2></div><span className="persisted-chip">PERSISTED STATE</span></div>
        <div className="graph-canvas"><div className={`mission-node ${isInvalid ? "node-invalid" : ""}`}><MissionGlyph /><small>MISSION</small><strong>{view.mission.title}</strong><span>{view.mission.status.replaceAll("_", " ")}</span></div><div className="graph-line line-cake"/><div className="graph-line line-flowers"/><div className={`graph-line line-dinner ${isInvalid ? "line-broken" : ""}`}/>{view.items.map((item, index) => <MerchantNode key={item.category} item={item} index={index} repaired={repaired} invalid={isInvalid} />)}</div>
        <div className="mission-actions"><div className="safety-copy"><span className="shield">◇</span><div><strong>{isInvalid ? "Commit authority blocked" : view.mission.status === "PAID" ? "Customer payment captured" : "Whole-mission validation active"}</strong><small>{isInvalid ? "The AI did not blindly spend. ₹0 remains committed." : view.mission.status === "PAID" ? "Merchant distribution is next." : "Every component must remain valid before payment can begin."}</small></div></div>{view.availableActions.canSimulateMarketChange && <button className="danger-button" onClick={onSimulate} disabled={Boolean(busy)}>{busy === "changing" ? "CHANGING MARKET…" : "SIMULATE MARKET CHANGE"}</button>}{view.availableActions.canRepair && <button className="repair-button" onClick={onRepair} disabled={Boolean(busy)}>{busy === "repairing" ? "REPAIRING SMALLEST PART…" : "REPAIR MISSION"}<span>↗</span></button>}{view.availableActions.canProceedToPayment && <button className="pay-button" onClick={onPay} disabled={Boolean(busy)}>{busy === "paying" ? "VERIFYING PAYMENT…" : `PAY ${view.financialAuthority.reserved.display} WITH RAZORPAY`}<span>↗</span></button>}{view.payment?.status === "ACTIVE" && !view.availableActions.canProceedToPayment && <button className="disabled-button" disabled>PAYMENT PENDING · VERIFYING</button>}{view.mission.status === "PAID" && <button className="paid-button" disabled>PAYMENT CAPTURED · {view.payment?.amount.display ?? view.financialAuthority.committed.display}</button>}{!view.availableActions.canSimulateMarketChange && !view.availableActions.canRepair && !view.availableActions.canProceedToPayment && !view.payment && view.mission.status !== "PAID" && <button className="disabled-button" disabled>PROCEED TO PAYMENT · UPCOMING</button>}</div>
      </section>
      <aside className="side-stack"><section className="panel constraint-panel"><div className="panel-heading"><div><small>MISSION CONSTRAINTS</small><h2>Validated as a whole</h2></div><span>{view.constraints.filter((c) => c.satisfied).length}/{view.constraints.length}</span></div><ul>{view.constraints.map((constraint) => <li key={constraint.key}><Mark ok={constraint.satisfied} /><span>{constraint.label}</span><b>{constraint.satisfied ? "VALID" : "BLOCKED"}</b></li>)}</ul></section><section className="panel reason-panel"><small>{reasonTitle}</small><p>{repaired ? (view.latestRepair?.rationale ?? "Only the restaurant became invalid. Cake and flowers remain preserved; R2 is the lowest-change valid repair.") : (view.latestPlan?.rationale ?? "Every selection satisfies the persisted mission constraints and remains inside authorized budget.")}</p>{!repaired && view.latestPlan?.reasons.slice(0, 3).map((reason) => <div key={reason.category}><b>{reason.category}</b><span>{reason.reason}</span></div>)}</section></aside>
    </div>
    {repaired && <RepairDelta reservations={view.reservations} repair={view.latestRepair!} />}
    <Timeline events={view.timeline} />
  </main>;
}

function AuthorityStat({ label, amount, accent, muted, note }: { label: string; amount: Amount; accent?: boolean; muted?: boolean; note?: string }) { return <div className={`authority-stat ${accent ? "authority-accent" : ""} ${muted ? "authority-muted" : ""}`}><small>{label}</small><strong>{amount.display}</strong>{note && <span>{note}</span>}</div>; }

function MerchantNode({ item, index, repaired, invalid }: { item: MissionView["items"][number]; index: number; repaired: boolean; invalid: boolean }) {
  const reservation = item.reservation; const broken = reservation?.status === "INVALID"; const preserved = repaired && reservation && reservation.offerCode !== "R2";
  return <article className={`merchant-node node-${index} ${broken ? "merchant-broken" : ""}`}><div className="node-top"><span className="category-icon">{item.category === "CAKE" ? "◒" : item.category === "FLOWERS" ? "✣" : "⌁"}</span><span className={`reservation-state state-${reservation?.status.toLowerCase()}`}>{preserved ? "PRESERVED" : reservation?.offerCode === "R2" ? "REPAIRED" : reservation?.status ?? "PENDING"}</span></div><small>{item.label.toUpperCase()}</small><h3>{reservation?.offerName ?? "Finding a valid offer…"}</h3><p>{reservation?.merchantName ?? "Merchant search"}</p>{reservation && <div className="node-details"><strong>{broken ? reservation.currentDisplay : reservation.reservedDisplay}</strong><span>{reservation.readyTimeDisplay}</span></div>}{broken && <div className="price-change"><s>{reservation?.reservedDisplay}</s><span>+₹800 change</span></div>}{invalid && !broken && <div className="preserved-line">✓ Still valid · untouched</div>}</article>;
}

function RepairDelta({ reservations, repair }: { reservations: ViewReservation[]; repair: NonNullable<MissionView["latestRepair"]> }) { const released = reservations.find((r) => repair.releasedReservationIds.includes(r.id)); const replacement = reservations.find((r) => repair.replacementReservationIds.includes(r.id)); return <section className="repair-delta panel"><div><small>MINIMAL MISSION REPAIR</small><h2>Dinner changed. Everything else stayed.</h2></div><div className="delta-flow"><span><b>{released?.offerCode ?? "R1"}</b><small>{released?.reservedDisplay} · RELEASED</small></span><i>→</i><span className="delta-new"><b>{replacement?.offerCode ?? "R2"}</b><small>{replacement?.reservedDisplay} · HELD</small></span></div><div className="changed-count"><strong>{repair.changedItems}</strong><span>CHANGED<br/>ITEM</span></div></section>; }

function Timeline({ events }: { events: MissionView["timeline"] }) { return <section className="timeline panel"><div className="panel-heading"><div><small>IMMUTABLE AUDIT TRAIL</small><h2>How this mission became safe</h2></div><span>{events.length} EVENTS</span></div><div className="timeline-scroll">{events.map((event, index) => <article key={event.id}><div className="timeline-index">{String(index + 1).padStart(2, "0")}</div><i /><div><small>{new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.at))} · V{event.missionVersion}</small><strong>{event.type.replaceAll("_", " ")}</strong><p>{event.message}</p></div></article>)}</div></section>; }
