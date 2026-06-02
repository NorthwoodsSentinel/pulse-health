// pulse-health PWA boot.
// - Registers service worker
// - Asks for notification permission
// - Subscribes to Web Push and POSTs the subscription to /api/subscribe

const logEl = document.getElementById("log");
const btn = document.getElementById("subscribe-btn");
const permPill = document.getElementById("perm-pill");
const swPill = document.getElementById("sw-pill");
const subPill = document.getElementById("sub-pill");

const lines = [];
function log(msg) {
  const stamp = new Date().toLocaleTimeString();
  lines.push(`${stamp}  ${msg}`);
  while (lines.length > 40) lines.shift();
  logEl.textContent = lines.join("\n");
}

function pill(el, state, text) {
  el.className = `pill ${state}`;
  el.textContent = text;
}

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

async function boot() {
  if (!("serviceWorker" in navigator)) {
    pill(swPill, "bad", "unsupported");
    log("Service workers not supported in this browser.");
    btn.textContent = "Unsupported browser";
    return;
  }
  if (!("PushManager" in window)) {
    pill(swPill, "bad", "no push");
    log("Push API not supported in this browser.");
    btn.textContent = "Push not supported";
    return;
  }

  // 1. Register service worker.
  log("Registering service worker…");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  pill(swPill, "good", "registered");
  log("Service worker ready.");

  // 2. Check permission.
  const perm = Notification.permission;
  pill(
    permPill,
    perm === "granted" ? "good" : perm === "denied" ? "bad" : "warn",
    perm,
  );

  // 3. Check existing subscription.
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    pill(subPill, "good", "subscribed");
    btn.textContent = "Subscribed — re-subscribe";
    log("Existing subscription found. Endpoint: " + sub.endpoint.slice(0, 60) + "…");
  } else {
    pill(subPill, "warn", "not yet");
    btn.textContent = perm === "granted" ? "Subscribe to push" : "Allow notifications + subscribe";
  }
  btn.disabled = false;

  btn.addEventListener("click", () => subscribe(reg));
}

async function subscribe(reg) {
  btn.disabled = true;
  btn.textContent = "Working…";
  try {
    // 1. Ensure permission.
    if (Notification.permission !== "granted") {
      log("Requesting notification permission…");
      const result = await Notification.requestPermission();
      pill(
        permPill,
        result === "granted" ? "good" : result === "denied" ? "bad" : "warn",
        result,
      );
      if (result !== "granted") {
        log("Permission " + result + " — cannot subscribe.");
        btn.disabled = false;
        btn.textContent = "Permission denied";
        return;
      }
    }

    // 2. Fetch VAPID public key.
    log("Fetching VAPID public key…");
    const r = await fetch("/api/vapid-public-key");
    const { key: vapidPublic } = await r.json();
    if (!vapidPublic) {
      log("Server did not return a VAPID public key.");
      btn.disabled = false;
      btn.textContent = "Server error";
      return;
    }

    // 3. Subscribe.
    log("Calling pushManager.subscribe()…");
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToUint8(vapidPublic),
    });

    // 4. POST to server.
    const p256dh = bufToB64url(sub.getKey("p256dh"));
    const auth = bufToB64url(sub.getKey("auth"));
    log("Registering subscription with backend…");
    const post = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: { p256dh, auth },
        userAgent: navigator.userAgent,
      }),
    });
    if (!post.ok) {
      const t = await post.text().catch(() => "");
      log("Backend rejected subscribe: " + post.status + " " + t.slice(0, 200));
      btn.disabled = false;
      btn.textContent = "Retry subscribe";
      return;
    }
    pill(subPill, "good", "subscribed");
    log("Subscribed. Ask Margin to fire a test push.");
    btn.textContent = "Subscribed — re-subscribe";
    btn.disabled = false;
  } catch (e) {
    log("Error: " + (e && e.message ? e.message : String(e)));
    btn.disabled = false;
    btn.textContent = "Retry subscribe";
  }
}

boot().catch((e) => log("boot failed: " + e.message));
