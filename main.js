// --- Tegel-lagen ---
const minuutplansTiles = L.tileLayer('https://tileserver.huc.knaw.nl/{z}/{x}/{y}', {
    attribution: '<a href="https://hisgis.nl/">HisGIS</a>',
    maxZoom: 22,         // tot maximaal 22 inzoomen
    minZoom: 11,
    maxNativeZoom: 22,   // alleen z=13 is echt aanwezig, lager/hoger wordt 
    minNativeZoom: 13
});
const osmTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
});

// --- Map met minuutplans als standaard ---
const map = L.map('map', {
    center: [52.1326, 5.2913],
    zoom: 8,
    minZoom: 6,
    maxZoom: 22,
    zoomSnap: 1,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 60,
    layers: [minuutplansTiles] // standaard deze tegel-laag
});

// --- Provincie filter ---
const allowedProvinces = [
  "Drenthe", "Friesland", "Gelderland", "Groningen", "Limburg",
  "Noord-Brabant", "Noord-Holland", "Overijssel", "Utrecht", "Zeeland", "Zuid-Holland"
];

// --- Overpass-query: filter direct op kad:provincie ---
const overpassUrl = 'https://overpass.huc.knaw.nl/api/interpreter?data=' +
    encodeURIComponent(
        `[out:json][timeout:60];
        relation
          [gebiedstype="kadastrale gemeente"]
          ["kad:provincie"~"^(Drenthe|Friesland|Gelderland|Groningen|Limburg|Noord-Brabant|Noord-Holland|Overijssel|Utrecht|Zeeland|Zuid-Holland)$"];
        out geom;`
    );

// --- GeoJSON conversie helpers ---
function isClosed(coords) {
    if (coords.length < 2) return false;
    const first = coords[0], last = coords[coords.length - 1];
    return first[0] === last[0] && first[1] === last[1];
}
function reverseRing(ring) {
    return [...ring].reverse();
}
function joinWays(ways) {
    let rings = ways.map(way => way.geometry.map(pt => [pt.lon, pt.lat]));
    let result = [];
    while (rings.length > 0) {
        let ring = rings.shift();
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < rings.length; i++) {
                let candidate = rings[i];
                if (ring[ring.length - 1][0] === candidate[0][0] && ring[ring.length - 1][1] === candidate[0][1]) {
                    ring = ring.concat(candidate.slice(1));
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
                if (ring[0][0] === candidate[candidate.length - 1][0] && ring[0][1] === candidate[candidate.length - 1][1]) {
                    ring = candidate.slice(0, -1).concat(ring);
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
                if (ring[ring.length - 1][0] === candidate[candidate.length - 1][0] && ring[ring.length - 1][1] === candidate[candidate.length - 1][1]) {
                    ring = ring.concat(reverseRing(candidate).slice(1));
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
                if (ring[0][0] === candidate[0][0] && ring[0][1] === candidate[0][1]) {
                    ring = reverseRing(candidate).slice(0, -1).concat(ring);
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
        if (!isClosed(ring)) {
            ring.push(ring[0]);
        }
        result.push(ring);
    }
    return result;
}
function overpassToGeoJSON(overpassJson) {
    const features = [];
    overpassJson.elements.forEach(el => {
        if (
            el.type === "relation" &&
            el.members &&
            el.tags &&
            allowedProvinces.includes(el.tags["kad:provincie"])
        ) {
            const outers = [];
            const inners = [];
            el.members.forEach(member => {
                if (member.type === "way" && member.geometry) {
                    if (member.role === "outer") {
                        outers.push(member);
                    } else if (member.role === "inner") {
                        inners.push(member);
                    }
                }
            });
            if (outers.length === 0) return;
            const outerRings = joinWays(outers);
            const innerRings = inners.length > 0 ? joinWays(inners) : [];
            if (outerRings.length === 1) {
                const coords = [outerRings[0]];
                innerRings.forEach(ring => coords.push(ring));
                features.push({
                    type: "Feature",
                    geometry: {
                        type: "Polygon",
                        coordinates: coords
                    },
                    properties: el.tags || {},
                    id: el.id
                });
            } else {
                const coords = outerRings.map(ring => [ring]);
                features.push({
                    type: "Feature",
                    geometry: {
                        type: "MultiPolygon",
                        coordinates: coords
                    },
                    properties: el.tags || {},
                    id: el.id
                });
            }
        }
    });
    return {
        type: "FeatureCollection",
        features: features
    };
}

// --- Vectorlaag (gemeenten) ---
let gemeenteLayer = null;
let featuresByName = {};
let featuresById = {};
let featuresByProv = {};

async function loadAndShow() {
    try {
        const response = await fetch(overpassUrl);
        if (!response.ok) throw new Error('Network response was not ok');
        const overpassJson = await response.json();
        const geojson = overpassToGeoJSON(overpassJson);
        if (geojson.features.length === 0) {
            alert('Geen polygonen gevonden in laag.');
            return;
        }
        if (gemeenteLayer) {
            map.removeLayer(gemeenteLayer);
        }
        gemeenteLayer = L.geoJSON(geojson, {
            style: {
                color: '#e31a1c',
                weight: 2,
                fillOpacity: 0.1
            },
            onEachFeature: function(feature, layer) {
                if (feature.properties && feature.properties.name) {
                    layer.bindPopup(feature.properties.name);
                }
            }
        });
        featuresByName = {};
        featuresById = {};
        featuresByProv = {};
        geojson.features.forEach(f => {
            if (f.properties && f.properties.name) {
                featuresByName[f.properties.name.toLowerCase()] = f;
            }
            featuresById[f.id] = f;
            const prov = (f.properties && f.properties["kad:provincie"]) || "Onbekend";
            if (!featuresByProv[prov]) featuresByProv[prov] = [];
            featuresByProv[prov].push(f);
        });
        document.getElementById('searchBtn').disabled = false;
        map.addLayer(gemeenteLayer); // standaard aan
        renderTable();
        drawLabels();
    } catch (err) {
        alert('Fout bij laden of verwerken van Overpass-data: ' + err);
        console.error(err);
    }
}
loadAndShow();

// --- Laagmenu met custom namen en overlay toggle ---
const baseMaps = {
    "minuutplans 1832": minuutplansTiles,
    "OpenStreetMap": osmTiles
};
const overlayMaps = {
    "Gemeentegrenzen": {
        // Leaflet 1.9.3+ ondersteunt object met 'layer' property
        layer: null // placeholder, wordt later gezet
    }
};
const layersControl = L.control.layers(baseMaps, {}, {collapsed: false}).addTo(map);

// Voeg overlay toe als gemeenteLayer geladen is
function updateOverlayControl() {
    if (gemeenteLayer) {
        // Verwijder bestaande overlay indien nodig
        layersControl.removeLayer(gemeenteLayer);
        // Voeg opnieuw toe
        layersControl.addOverlay(gemeenteLayer, "Gemeentegrenzen");
    }
}

// --- Zoekfunctionaliteit en tabel ---
document.getElementById('searchForm').addEventListener('submit', function(e) {
    e.preventDefault();
    const input = document.getElementById('searchInput').value.trim().toLowerCase();
    if (!input) return;
    if (!featuresByName[input]) {
        alert('Gemeente niet gevonden: ' + input);
        return;
    }
    panToFeature(featuresByName[input]);
});
document.getElementById('searchInput').addEventListener('input', function() {
    document.getElementById('searchBtn').disabled = !this.value.trim();
});

// --- SVG labels in kaart-eenheden ---
const svgLayer = L.svg().addTo(map);
const svg = d3.select(svgLayer._container);

function polygonCentroid(coords) {
    let area = 0, x = 0, y = 0;
    for (let i = 0, len = coords.length, j = len - 1; i < len; j = i++) {
        const xi = coords[i][0], yi = coords[i][1];
        const xj = coords[j][0], yj = coords[j][1];
        const f = xi * yj - xj * yi;
        area += f;
        x += (xi + xj) * f;
        y += (yi + yj) * f;
    }
    area = area / 2;
    if (area === 0) return coords[0];
    x = x / (6 * area);
    y = y / (6 * area);
    return [x, y];
}
function breakLines(name, maxLen = 14) {
    const words = name.split(' ');
    let lines = [], line = '';
    for (let w of words) {
        if ((line + ' ' + w).trim().length > maxLen && line.length > 0) {
            lines.push(line.trim());
            line = w;
        } else {
            line += ' ' + w;
        }
    }
    if (line) lines.push(line.trim());
    return lines;
}
function drawLabels() {
    svg.selectAll('g.gemeente-label').remove();
    if (!gemeenteLayer) return;
    if (map.getZoom() < 13) return;
    gemeenteLayer.eachLayer(function(layer) {
        if (!layer.feature || !layer.feature.geometry) return;
        const name = layer.feature.properties && layer.feature.properties.name;
        if (!name) return;
        let rings = [];
        if (layer.feature.geometry.type === "Polygon") {
            rings = [layer.feature.geometry.coordinates[0]];
        } else if (layer.feature.geometry.type === "MultiPolygon") {
            rings = layer.feature.geometry.coordinates.map(poly => poly[0]);
        }
        let biggest = rings[0];
        let maxLen = 0;
        for (let ring of rings) {
            let len = 0;
            for (let i = 1; i < ring.length; i++) {
                len += Math.hypot(ring[i][0] - ring[i-1][0], ring[i][1] - ring[i-1][1]);
            }
            if (len > maxLen) {
                maxLen = len;
                biggest = ring;
            }
        }
        const centroid = polygonCentroid(biggest);
        const point = map.latLngToLayerPoint([centroid[1], centroid[0]]);
        const lines = breakLines(name, 14);

        const g = svg.append('g')
            .attr('class', 'gemeente-label')
            .attr('transform', `translate(${point.x},${point.y})`);
        lines.forEach((line, i) => {
            g.append('text')
                .text(line)
                .attr('y', i * 10 * 1.1)
                .attr('text-anchor', 'middle')
                .attr('font-size', '10pt')
                .attr('font-family', 'sans-serif')
                .attr('font-weight', 'bold');
        });
    });
}
map.on('zoomend moveend', drawLabels);

// --- Tabel met provincie-groepen ---
function renderTable() {
    const tableDiv = document.getElementById('gemeenteTable');
    tableDiv.innerHTML = '';
    const sortedProvs = Object.keys(featuresByProv).sort();
    sortedProvs.forEach(prov => {
        const provDiv = document.createElement('div');
        provDiv.className = 'province-group';
        const header = document.createElement('div');
        header.className = 'province-header';
        header.textContent = prov;
        provDiv.appendChild(header);
        const table = document.createElement('table');
        table.className = 'gemeente-table';
        featuresByProv[prov].sort((a, b) => (a.properties.name || '').localeCompare(b.properties.name || '')).forEach(feature => {
            const tr = document.createElement('tr');
            tr.className = 'gemeente-row';
            tr.setAttribute('data-id', feature.id);
            const td = document.createElement('td');
            td.className = 'gemeente-cell';
            td.textContent = feature.properties.name || '';
            tr.appendChild(td);
            tr.addEventListener('click', () => {
                panToFeature(feature);
                document.querySelectorAll('.gemeente-row.selected').forEach(row => row.classList.remove('selected'));
                tr.classList.add('selected');
            });
            table.appendChild(tr);
        });
        provDiv.appendChild(table);
        tableDiv.appendChild(provDiv);
    });
    updateOverlayControl();
}

// --- Pan/zoom naar gemeente ---
function panToFeature(feature) {
    if (!feature) return;
    gemeenteLayer.eachLayer(function(layer) {
        if (layer.feature && layer.feature.id === feature.id) {
            map.fitBounds(layer.getBounds(), {maxZoom: 13});
            layer.openPopup();
        }
    });
}

// --- URL live bijwerken met zoom en center ---
function updateUrlFromMap() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const lat = center.lat.toFixed(5);
    const lng = center.lng.toFixed(5);
    window.history.replaceState(null, '', `#${zoom}/${lat}/${lng}`);
}
map.on('moveend zoomend', updateUrlFromMap);

// --- Bij laden: center en zoom uit URL (indien aanwezig) ---
window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash;
    if (hash && /^#([\d.]+)\/([\d\-.]+)\/([\d\-.]+)$/.test(hash)) {
        const [, zoom, lat, lng] = hash.match(/^#([\d.]+)\/([\d\-.]+)\/([\d\-.]+)$/);
        map.setView([parseFloat(lat), parseFloat(lng)], parseFloat(zoom));
    }
});
