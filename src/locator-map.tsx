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
  visibleLayerKeys: string[]
): string | null {
  if (!visibleLayerKeys.length) return null;

  const point = map.latLngToContainerPoint(latlng);
  const size = map.getSize();
  const bounds = map.getBounds();

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
    feature_count: "10",
  });

  return `${WMS_URL}${WMS_URL.endsWith("?") ? "" : "?"}${params.toString()}`;
}

// Handle map clicks: send GetFeatureInfo and show results in a popup
function MapClickInfo({
  visibleLayerKeys,
  setPopup,
}: {
  visibleLayerKeys: string[];
  setPopup: (popup: PopupState | null) => void;
}) {
  const map = useMap();

  useMapEvents({
    async click(e) {
      const url = buildGetFeatureInfoUrl(map, e.latlng, visibleLayerKeys);
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
          const f = (json.features && json.features[0]) || null;
          if (!f) {
            html = "<b>No features at this point.</b>";
          } else {
            const props = f.properties || {};
            html =
              '<div><b>Feature Info</b><table style="margin-top:6px;">' +
              Object.entries(props)
                .map(
                  ([k, v]) =>
                    `<tr><td style="padding-right:8px;font-weight:600;">${k}</td><td>${String(
                      v
                    )}</td></tr>`
                )
                .join("") +
              "</table></div>";
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

export default function LocatorMap() {
  const [visible, setVisible] = useState(
    () => new Set<LayerKey>([LAYERS[0].key])
  ); // default: first layer on
  const [popup, setPopup] = useState<PopupState | null>(null);

  const visibleLayerKeys = useMemo(() => Array.from(visible), [visible]);

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
        <h3 style={{ margin: "4px 0 12px" }}>Layers</h3>
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
            <code style={{ marginLeft: "auto", opacity: 0.6, fontSize: 12 }}>
              {l.key}
            </code>
          </label>
        ))}
        <p style={{ fontSize: 12, opacity: 0.8, marginTop: 12 }}>
          Tip: Click the map to see feature info for all <em>selected</em>{" "}
          layers.
        </p>
      </div>

      {/* Map container */}
      <MapContainer
        center={[43.7, -79.4]} // Toronto-ish
        zoom={12}
        style={{ height: "100%", width: "100%" }}
      >
        {/* Basemap */}
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* WMS overlays for each visible layer */}
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
            />
          ) : null
        )}

        {/* Drawing tools */}
        <DrawControl />

        {/* Click → GetFeatureInfo */}
        <MapClickInfo visibleLayerKeys={visibleLayerKeys} setPopup={setPopup} />

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
