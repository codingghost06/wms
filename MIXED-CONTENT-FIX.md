# 🚨 URGENT: Mixed Content Error Fix

## What's the Problem?

Your GitHub Pages site uses **HTTPS**, but your GeoServer uses **HTTP**. Browsers block this for security (Mixed Content Error).

## ✅ Quick Fixes (Choose One)

### Option 1: Test if GeoServer has HTTPS (30 seconds)

Open terminal and run:

```bash
curl -k https://35.183.38.140/geoserver/ows?service=WMS&version=1.3.0&request=GetCapabilities
```

**If you see XML** → Great! GeoServer has HTTPS. Just rebuild and deploy:

```bash
npm run build
# Deploy the dist/ folder to GitHub Pages
```

**If you see error** → GeoServer doesn't have HTTPS, use Option 2 or 3.

---

### Option 2: Use CORS Proxy (5 minutes - Quick Test)

Change line 51 in `src/locator-map.tsx`:

**FROM:**

```typescript
const WMS_URL =
  import.meta.env.VITE_WMS_URL ||
  (window.location.protocol === "https:"
    ? "https://35.183.38.140/geoserver/ows?"
    : "http://35.183.38.140/geoserver/ows?");
```

**TO:**

```typescript
const WMS_URL = "https://corsproxy.io/?url=http://35.183.38.140/geoserver/ows?";
```

Then rebuild:

```bash
npm run build
# Deploy
```

⚠️ **Note**: `corsproxy.io` is for testing only, not production!

---

### Option 3: Deploy on HTTP Instead (10 minutes)

If you can't use HTTPS GeoServer, deploy your app on HTTP:

1. Use Netlify/Vercel instead of GitHub Pages
2. Configure to serve over HTTP (or custom domain with HTTP)
3. Keep the original HTTP URL

---

### Option 4: Set up Your Own HTTPS Proxy (Best for Production)

**Using Cloudflare Workers (Free):**

1. Go to https://workers.cloudflare.com
2. Create new worker
3. Paste this code:

```javascript
export default {
  async fetch(request) {
    // Get the URL from query param
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("target");

    if (!targetUrl) {
      return new Response("Missing target URL", { status: 400 });
    }

    // Forward the request
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
    });

    // Add CORS headers
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    newResponse.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    newResponse.headers.set("Access-Control-Allow-Headers", "*");

    return newResponse;
  },
};
```

4. Deploy worker (e.g., `https://wms-proxy.your-name.workers.dev`)
5. Update your code:

```typescript
const PROXY_URL = "https://wms-proxy.your-name.workers.dev";
const GEOSERVER_URL = "http://35.183.38.140/geoserver/ows";
const WMS_URL = `${PROXY_URL}?target=${encodeURIComponent(GEOSERVER_URL)}?`;
```

---

## 🔍 How to Verify It's Fixed

After deploying, open browser console. You should see:

```
🗺️ WMS MAP VIEWER INITIALIZED
🌐 Protocol: https:
🔗 WMS URL: https://... (GREEN, not orange)
✅ SUCCESS: Water Mains
```

**NO red errors or "Mixed Content" warnings!**

---

## Current Status

Your code now:

- ✅ Auto-detects HTTPS vs HTTP
- ✅ Shows warnings in console
- ✅ Attempts HTTPS on GitHub Pages
- ✅ Uses HTTP for local development

Just choose a fix option and rebuild!
