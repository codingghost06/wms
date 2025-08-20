// src/LocatorMap.tsx
import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  WMSTileLayer,
  useMap,
  useMapEvents,
  Popup,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import "leaflet-draw"; // attaches draw controls to L

// Type assertion interfaces for leaflet-draw
interface LeafletDrawOptions {
  position?: string;
  draw?: {
    polygon?: boolean;
    polyline?: boolean;
    rectangle?: boolean;
    marker?: boolean;
    circle?: boolean;
    circlemarker?: boolean;
  };
  edit?: {
    featureGroup: L.FeatureGroup;
    remove?: boolean;
  };
}

interface LeafletDrawControl {
  new (options?: LeafletDrawOptions): L.Control;
}

interface LeafletDrawEvents {
  CREATED: string;
  EDITED: string;
  DELETED: string;
}

interface DrawEvent {
  layer: L.Layer & {
    toGeoJSON(): GeoJSON.Feature;
  };
}

// === YOUR GEOserver WMS base URL (no query params beyond '?') ===
const WMS_URL = "http://35.183.38.140/geoserver/ows?";

// === Configure the layers you want to expose (use exact <Name> from GetCapabilities) ===
const LAYERS = [
  { key: "rmw:RSW_Mains", title: "Storm Mains" },
  { key: "rmw:Water_Mains", title: "Water Mains" },
  { key: "rmw:RSW_Manholes", title: "Manholes" },
  { key: "rmw:Roads", title: "Roads" },
  { key: "rmw:Addresses", title: "Addresses" },
] as const;

type LayerKey = (typeof LAYERS)[number]["key"];

// Type for popup state
interface PopupState {
  latlng: L.LatLng;
  content: string;
}

// Type for URL parameters
interface UrlParams {
  lat?: number;
  lng?: number;
  radius?: number; // in meters, default 1000m
}

// Parse URL parameters
function getUrlParams(): UrlParams {
  const urlParams = new URLSearchParams(window.location.search);
  const lat = urlParams.get("lat");
  const lng = urlParams.get("lng");
  const radius = urlParams.get("radius");

  return {
    lat: lat ? parseFloat(lat) : undefined,
    lng: lng ? parseFloat(lng) : undefined,
    radius: radius ? parseFloat(radius) : 1000, // default 1km radius
  };
}

// Calculate bounding box around a point
function calculateBoundingBox(
  lat: number,
  lng: number,
  radiusMeters: number
): L.LatLngBounds {
  // Approximate degrees per meter (rough calculation)
  const latDegreePerMeter = 1 / 111320;
  const lngDegreePerMeter = 1 / (111320 * Math.cos((lat * Math.PI) / 180));

  const latOffset = radiusMeters * latDegreePerMeter;
  const lngOffset = radiusMeters * lngDegreePerMeter;

  const southwest = L.latLng(lat - latOffset, lng - lngOffset);
  const northeast = L.latLng(lat + latOffset, lng + lngOffset);

  return L.latLngBounds(southwest, northeast);
}

// --- Drawing controls hooked to the raw Leaflet map instance ---
function DrawControl() {
  const map = useMap();

  useEffect(() => {
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const DrawControl = (L.Control as unknown as { Draw: LeafletDrawControl })
      .Draw;
    const drawControl = new DrawControl({
      position: "topleft",
      draw: {
        polygon: true,
        polyline: true,
        rectangle: true,
        marker: true,
        circle: false,
        circlemarker: false,
      },
      edit: { featureGroup: drawnItems, remove: true },
    });

    map.addControl(drawControl);

    const drawEvents = (L as unknown as { Draw: { Event: LeafletDrawEvents } })
      .Draw.Event;

    function onCreated(e: DrawEvent) {
      drawnItems.addLayer(e.layer);
      const gj = e.layer.toGeoJSON();
      console.log("DRAWN GEOJSON:", gj);
      // TODO: send gj to your API for storage/spatial checks if needed
    }
    function onEdited(e: unknown) {
      console.log("EDITED:", e);
    }
    function onDeleted(e: unknown) {
      console.log("DELETED:", e);
    }

    map.on(drawEvents.CREATED, onCreated);
    map.on(drawEvents.EDITED, onEdited);
    map.on(drawEvents.DELETED, onDeleted);

    return () => {
      map.off(drawEvents.CREATED, onCreated);
      map.off(drawEvents.EDITED, onEdited);
      map.off(drawEvents.DELETED, onDeleted);
      map.removeControl(drawControl);
      map.removeLayer(drawnItems);
    };
  }, [map]);

  return null;
}

// Build a WMS 1.3.0 GetFeatureInfo URL for all currently visible layers
function buildGetFeatureInfoUrl(
  map: L.Map,
  latlng: L.LatLng,
  visibleLayerKeys: string[],
  spatialFilter?: L.LatLngBounds
): string | null {
  if (!visibleLayerKeys.length) return null;

  const point = map.latLngToContainerPoint(latlng);
  const size = map.getSize();

  // Use spatial filter bounds if provided, otherwise use current map bounds
  const bounds = spatialFilter || map.getBounds();

  // Use EPSG:3857 to avoid axis-order confusion; project bounds to meters.
  const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
  const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
  const bbox = [sw.x, sw.y, ne.x, ne.y].join(",");

  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetFeatureInfo",
    layers: visibleLayerKeys.join(","), // which layers are drawn
    query_layers: visibleLayerKeys.join(","), // which layers to query
    info_format: "application/json", // try JSON first
    crs: "EPSG:3857",
    bbox,
    width: String(size.x),
    height: String(size.y),
    i: String(Math.round(point.x)), // WMS 1.3.0 uses i/j
    j: String(Math.round(point.y)),
    feature_count: "50", // Increased from 10 since we're filtering spatially
  });

  return `${WMS_URL}${WMS_URL.endsWith("?") ? "" : "?"}${params.toString()}`;
}

// Handle map clicks: send GetFeatureInfo and show results in a popup
function MapClickInfo({
  visibleLayerKeys,
  setPopup,
  spatialFilter,
}: {
  visibleLayerKeys: string[];
  setPopup: (popup: PopupState | null) => void;
  spatialFilter?: L.LatLngBounds;
}) {
  const map = useMap();

  useMapEvents({
    async click(e) {
      const url = buildGetFeatureInfoUrl(
        map,
        e.latlng,
        visibleLayerKeys,
        spatialFilter
      );
      if (!url) {
        setPopup({ latlng: e.latlng, content: "No layers selected." });
        return;
      }

      try {
        const resp = await fetch(url);
        const ct = resp.headers.get("content-type") || "";
        let html = "";

        if (ct.includes("application/json")) {
          const json = await resp.json();
          const features = json.features || [];
          if (features.length === 0) {
            html = "<b>No features at this point.</b>";
          } else {
            // Show all features found, not just the first one
            html = "<div><b>Feature Info</b>";
            features.forEach((f: any, index: number) => {
              const props = f.properties || {};
              const layerName = f.id
                ? f.id.split(".")[0]
                : `Feature ${index + 1}`;
              html += `<div style="margin-top:${
                index > 0 ? "12px" : "6px"
              };"><strong>${layerName}</strong><table style="margin-top:4px;">`;
              html += Object.entries(props)
                .map(
                  ([k, v]) =>
                    `<tr><td style="padding-right:8px;font-weight:600;">${k}</td><td>${String(
                      v
                    )}</td></tr>`
                )
                .join("");
              html += "</table></div>";
            });
            html += "</div>";
          }
        } else {
          // Fallback: many GeoServer setups return HTML/text
          const text = await resp.text();
          html = text || "<b>No info returned.</b>";
        }

        setPopup({ latlng: e.latlng, content: html });
      } catch (err) {
        console.error(err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        setPopup({
          latlng: e.latlng,
          content: `<b>Error</b><div>${errorMessage}</div>`,
        });
      }
    },
  });

  return null;
}

// Component to handle URL-based center and spatial filtering
function UrlBasedMapController({
  urlParams,
  spatialFilter,
}: {
  urlParams: UrlParams;
  spatialFilter?: L.LatLngBounds;
}) {
  const map = useMap();

  useEffect(() => {
    if (urlParams.lat && urlParams.lng) {
      // Center map on URL coordinates
      map.setView([urlParams.lat, urlParams.lng], 15);

      // Add a marker for the target location
      const marker = L.marker([urlParams.lat, urlParams.lng])
        .addTo(map)
        .bindPopup(
          `Target Location<br/>Lat: ${urlParams.lat}<br/>Lng: ${urlParams.lng}`
        );

      // Show the spatial filter area if provided
      if (spatialFilter) {
        const rectangle = L.rectangle(spatialFilter, {
          color: "#ff7800",
          weight: 2,
          fillOpacity: 0.1,
        }).addTo(map);

        rectangle.bindPopup(`Search Area<br/>Radius: ${urlParams.radius}m`);
      }

      return () => {
        map.removeLayer(marker);
        if (spatialFilter) {
          map.eachLayer((layer) => {
            if (layer instanceof L.Rectangle) {
              map.removeLayer(layer);
            }
          });
        }
      };
    }
  }, [map, urlParams, spatialFilter]);

  return null;
}

export default function LocatorMap() {
  const [visible, setVisible] = useState(
    () => new Set<LayerKey>([LAYERS[0].key])
  ); // default: first layer on
  const [popup, setPopup] = useState<PopupState | null>(null);

  const urlParams = useMemo(() => getUrlParams(), []);
  const spatialFilter = useMemo(() => {
    if (urlParams.lat && urlParams.lng && urlParams.radius) {
      return calculateBoundingBox(
        urlParams.lat,
        urlParams.lng,
        urlParams.radius
      );
    }
    return undefined;
  }, [urlParams]);

  const visibleLayerKeys = useMemo(() => Array.from(visible), [visible]);

  // Default center - use URL params if available, otherwise Toronto
  const defaultCenter: [number, number] =
    urlParams.lat && urlParams.lng
      ? [urlParams.lat, urlParams.lng]
      : [43.7, -79.4];

  const defaultZoom = urlParams.lat && urlParams.lng ? 15 : 12;

  function toggleLayer(key: LayerKey) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Fix default marker icon paths when bundling
  useEffect(() => {
    // @ts-expect-error - This is a known workaround for Leaflet + bundlers
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl:
        "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl:
        "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  }, []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "280px 1fr",
        height: "100vh",
      }}
    >
      {/* Sidebar: layer toggles */}
      <div
        style={{ padding: 12, borderRight: "1px solid #eee", overflow: "auto" }}
      >
        <h3 style={{ margin: "4px 0 12px" }}>WMS Map Viewer</h3>

        {/* URL Parameters Info */}
        {urlParams.lat && urlParams.lng && (
          <div
            style={{
              marginBottom: 16,
              padding: 8,
              backgroundColor: "#f0f8ff",
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <strong>Target Location:</strong>
            <br />
            Lat: {urlParams.lat.toFixed(6)}
            <br />
            Lng: {urlParams.lng.toFixed(6)}
            <br />
            Radius: {urlParams.radius}m
          </div>
        )}

        <h4 style={{ margin: "8px 0 8px", fontSize: 14 }}>Layers</h4>
        {LAYERS.map((l) => (
          <label
            key={l.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={visible.has(l.key)}
              onChange={() => toggleLayer(l.key)}
            />
            <span>{l.title}</span>
            <code style={{ marginLeft: "auto", opacity: 0.6, fontSize: 11 }}>
              {l.key}
            </code>
          </label>
        ))}

        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.8 }}>
          <p>
            <strong>Usage:</strong>
            <br />
            • Click map for feature info
            <br />• Add ?lat=43.7&lng=-79.4&radius=500 to URL for spatial
            filtering
          </p>
          {spatialFilter && (
            <p style={{ marginTop: 8, color: "#ff7800" }}>
              🎯 <strong>Spatial filtering active!</strong>
              <br />
              Only showing data within {urlParams.radius}m of target.
            </p>
          )}
        </div>
      </div>

      {/* Map container */}
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        style={{ height: "100%", width: "100%" }}
      >
        {/* Basemap */}
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* WMS overlays for each visible layer with spatial filtering */}
        {LAYERS.map((l, idx) =>
          visible.has(l.key) ? (
            <WMSTileLayer
              key={l.key}
              url={WMS_URL}
              layers={l.key}
              format="image/png"
              transparent={true}
              version="1.3.0"
              // @ts-expect-error - tiled is not in the type definition but is valid
              tiled={true}
              styles=""
              zIndex={200 + idx} // keep overlays above base
              // Add spatial filtering if bounds are provided
              {...(spatialFilter && {
                // Add CQL_FILTER for spatial filtering (if your GeoServer supports it)
                cql_filter: spatialFilter
                  ? `BBOX(the_geom,${spatialFilter.getWest()},${spatialFilter.getSouth()},${spatialFilter.getEast()},${spatialFilter.getNorth()},'EPSG:4326')`
                  : undefined,
              })}
            />
          ) : null
        )}

        {/* URL-based map controller */}
        <UrlBasedMapController
          urlParams={urlParams}
          spatialFilter={spatialFilter}
        />

        {/* Drawing tools */}
        <DrawControl />

        {/* Click → GetFeatureInfo with spatial filtering */}
        <MapClickInfo
          visibleLayerKeys={visibleLayerKeys}
          setPopup={setPopup}
          spatialFilter={spatialFilter}
        />

        {/* Info popup */}
        {popup && (
          <Popup
            position={popup.latlng}
            eventHandlers={{
              remove: () => setPopup(null),
            }}
          >
            <div dangerouslySetInnerHTML={{ __html: popup.content }} />
          </Popup>
        )}
      </MapContainer>
    </div>
  );
}
