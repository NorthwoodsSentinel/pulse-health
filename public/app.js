// pulse-health PWA: dashboard + push subscription.

const $ = (id) => document.getElementById(id);

function pill(el, state, text) {
  el.className = `pill ${state}`;
  el.textContent = text;
}

function fmtAgo(ms) {
  if (!ms) return "—";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86400_000)}d ago`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function fmtDuration(s) {
  if (!s) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function scoreClass(n) {
  if (n == null) return "idle";
  if (n >= 80) return "good";
  if (n >= 60) return "warn";
  return "bad";
}

function fmtDistanceMi(m) {
  if (!m) return "—";
  return `${(m / 1609.344).toFixed(2)} mi`;
}

function fmtSpeedMph(mps) {
  if (!mps) return "—";
  return `${(mps * 2.23694).toFixed(1)} mph`;
}

// ---------- dashboard render ----------

async function loadDigest() {
  try {
    const res = await fetch("/api/digest");
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    renderOura(data.oura);
    renderStrava(data.strava);
    $("last-updated").textContent = `updated ${fmtAgo(data.generated_at)}`;
  } catch (e) {
    $("oura-content").innerHTML = `<div class="skeleton">load failed: ${e.message}</div>`;
    $("strava-content").innerHTML = "";
  }
}

function renderOura(o) {
  if (!o || (o.sleep_score == null && o.readiness_score == null)) {
    $("oura-content").innerHTML = `<div class="skeleton">no Oura data yet</div>`;
    $("oura-stamp").textContent = "";
    return;
  }
  $("oura-stamp").textContent = o.day || "";

  const html = `
    <div class="scores">
      <div class="score-box">
        <div class="score-label">Sleep</div>
        <div class="score-value score-${scoreClass(o.sleep_score)}">${o.sleep_score ?? "—"}</div>
      </div>
      <div class="score-box">
        <div class="score-label">Readiness</div>
        <div class="score-value score-${scoreClass(o.readiness_score)}">${o.readiness_score ?? "—"}</div>
      </div>
    </div>
    <div class="row"><span class="key">Avg HRV</span><span class="val">${o.avg_hrv ?? "—"}${o.avg_hrv ? " ms" : ""}</span></div>
    <div class="row"><span class="key">Avg HR</span><span class="val">${o.avg_hr ? o.avg_hr.toFixed(1) : "—"}${o.avg_hr ? " bpm" : ""}</span></div>
    <div class="row"><span class="key">Total sleep</span><span class="val">${fmtDuration(o.total_sleep_seconds)}</span></div>
    <div class="row"><span class="key">Time in bed</span><span class="val">${fmtDuration(o.time_in_bed_seconds)}</span></div>
    <div class="row"><span class="key">Bedtime</span><span class="val">${fmtDate(o.bedtime_start)}</span></div>
    <div class="row"><span class="key">Body temp deviation</span><span class="val">${o.temperature_deviation != null ? o.temperature_deviation.toFixed(2) + " °C" : "—"}</span></div>
    ${o.readiness_contributors ? renderContributors(o.readiness_contributors, "Readiness contributors") : ""}
    ${o.sleep_contributors ? renderContributors(o.sleep_contributors, "Sleep contributors") : ""}
  `;
  $("oura-content").innerHTML = html;
}

function renderContributors(c, label) {
  const entries = Object.entries(c).sort((a, b) => a[1] - b[1]);
  const pills = entries
    .map(([k, v]) => `<span class="ch">${k.replaceAll("_", " ")}<b>${v}</b></span>`)
    .join("");
  return `
    <details style="margin-top:8px;">
      <summary>${label}</summary>
      <div class="ch-row">${pills}</div>
    </details>`;
}

function renderStrava(s) {
  if (!s) {
    $("strava-content").innerHTML = `<div class="skeleton">no Strava activity yet</div>`;
    $("strava-stamp").textContent = "";
    return;
  }
  $("strava-stamp").textContent = s.type;
  const html = `
    <div class="activity-name">${escapeHtml(s.name)}</div>
    <div class="activity-sub">${fmtDate(s.start_date_local)}</div>
    <div class="row"><span class="key">Distance</span><span class="val">${fmtDistanceMi(s.distance_m)}</span></div>
    <div class="row"><span class="key">Moving time</span><span class="val">${fmtDuration(s.moving_time_s)}</span></div>
    <div class="row"><span class="key">Elevation gain</span><span class="val">${s.total_elevation_gain_m ? Math.round(s.total_elevation_gain_m) + " m" : "—"}</span></div>
    <div class="row"><span class="key">Avg speed</span><span class="val">${fmtSpeedMph(s.average_speed_mps)}</span></div>
    ${s.average_heartrate ? `<div class="row"><span class="key">Avg HR / Max</span><span class="val">${Math.round(s.average_heartrate)} / ${Math.round(s.max_heartrate)} bpm</span></div>` : ""}
    ${s.average_watts ? `<div class="row"><span class="key">Avg power</span><span class="val">${Math.round(s.average_watts)} W</span></div>` : ""}
    <div class="row"><span class="key">Kudos</span><span class="val">${s.kudos_count ?? 0}</span></div>
  `;
  $("strava-content").innerHTML = html;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// ---------- push subscription ----------

function b64urlToUint8(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function bootPush() {
  const permEl = $("perm-pill"), swEl = $("sw-pill"), subEl = $("sub-pill"), btn = $("subscribe-btn");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    pill(swEl, "bad", "unsupported");
    btn.textContent = "Push not supported";
    return;
  }
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  pill(swEl, "good", "registered");
  pill(permEl, Notification.permission === "granted" ? "good" : Notification.permission === "denied" ? "bad" : "warn", Notification.permission);
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    pill(subEl, "good", "subscribed");
    btn.textContent = "Re-subscribe";
  } else {
    pill(subEl, "warn", "not yet");
    btn.textContent = Notification.permission === "granted" ? "Subscribe" : "Allow + subscribe";
  }
  btn.disabled = false;
  btn.addEventListener("click", () => subscribe(reg));
}

async function subscribe(reg) {
  const btn = $("subscribe-btn"), permEl = $("perm-pill"), subEl = $("sub-pill");
  btn.disabled = true; btn.textContent = "Working…";
  try {
    if (Notification.permission !== "granted") {
      const result = await Notification.requestPermission();
      pill(permEl, result === "granted" ? "good" : result === "denied" ? "bad" : "warn", result);
      if (result !== "granted") { btn.textContent = "Permission denied"; btn.disabled = false; return; }
    }
    const r = await fetch("/api/vapid-public-key");
    const { key } = await r.json();
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToUint8(key),
    });
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: { p256dh: bufToB64url(sub.getKey("p256dh")), auth: bufToB64url(sub.getKey("auth")) },
        userAgent: navigator.userAgent,
      }),
    });
    pill(subEl, "good", "subscribed");
    btn.textContent = "Re-subscribe";
    btn.disabled = false;
  } catch (e) {
    btn.textContent = "Retry";
    btn.disabled = false;
  }
}

loadDigest();
bootPush();
