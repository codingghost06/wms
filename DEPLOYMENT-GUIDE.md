# Deployment Guide - GitHub Pages Mixed Content Fix

## Problem

GitHub Pages serves content over HTTPS, but the GeoServer at `http://35.183.38.140` uses HTTP. Browsers block HTTP requests from HTTPS pages (Mixed Content Error).

## Solutions

### Solution 1: Enable HTTPS on GeoServer (Recommended)

If you have access to the GeoServer configuration:

1. Set up SSL certificate on the GeoServer (port 443)
2. Configure reverse proxy (nginx/Apache) with SSL
3. The code will automatically use HTTPS when deployed to GitHub Pages

### Solution 2: Use CORS Proxy (Quick Fix)

If you cannot modify GeoServer, use a CORS proxy:

**Option A: Use a public CORS proxy (NOT for production)**

```typescript
// In src/locator-map.tsx, change WMS_URL to:
const WMS_URL = "https://corsproxy.io/?http://35.183.38.140/geoserver/ows?";
```

**Option B: Deploy your own CORS proxy**

1. Deploy a simple proxy server on Heroku/Vercel/Cloudflare Workers
2. Forward requests to your GeoServer
3. Update WMS_URL to point to your proxy

Example Cloudflare Worker:

```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
    });

    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    return newResponse;
  },
};
```

### Solution 3: Deploy on HTTP (Not Recommended)

Deploy your app on a custom domain with HTTP instead of GitHub Pages. **Not recommended for security reasons.**

### Solution 4: Use Different Port

Check if GeoServer has HTTPS on a different port:

- https://35.183.38.140:8443/geoserver/ows?
- https://35.183.38.140:443/geoserver/ows?

## Current Configuration

The app now automatically detects the protocol:

- **Local development (http://localhost)**: Uses HTTP GeoServer
- **Production (https://...)**: Attempts HTTPS GeoServer

## Testing

### Test if GeoServer supports HTTPS:

```bash
curl -k https://35.183.38.140/geoserver/ows?service=WMS&version=1.3.0&request=GetCapabilities
```

If you get XML response → HTTPS works! ✅
If you get connection error → HTTPS not configured ❌

## Recommended Action Plan

1. **First**, try building and deploying with current code (attempts HTTPS)
2. **If that fails**, test GeoServer HTTPS manually (curl command above)
3. **If HTTPS not available**, set up a CORS proxy
4. **Best long-term solution**: Enable HTTPS on GeoServer

## Quick Deploy

```bash
npm run build
git add dist/DAY9VtfS.js         435.80 kB │ gzip: 126.55 kB
✓ built in 5.61s
git commit -m "Build for deployment"
git push
```

## Environment Variables (Optional)

You can override the WMS URL:

```bash
# .env.production
VITE_WMS_URL=https://your-geoserver-url/ows?
```

Then build:

```bash
npm run build
```
