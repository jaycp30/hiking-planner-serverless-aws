import { useState } from "react";

const API_URL = import.meta.env.VITE_API_URL;
const INITIAL_TRAIL_LIMIT = 10;
const MAX_TRAIL_LIMIT = 20;

const DIFF = {
  easy:     { bg: "#eef5eb", text: "#4f8a42", dot: "#7ead66", border: "#7ead66" },
  moderate: { bg: "#eef6fb", text: "#2e82c0", dot: "#5399cf", border: "#5399cf" },
  hard:     { bg: "#fff0ec", text: "#ce5139", dot: "#ce5139", border: "#ce5139" },
};

const STEPS = [
  { n: "1", ico: "⌖", lines: ["Choose a", "trail area"] },
  { n: "2", ico: "▣", lines: ["Enter your", "starting point"] },
  { n: "3", ico: "☷", lines: ["Filter by difficulty", "and preferences"] },
  { n: "4", ico: "△", lines: ["Browse trails", "and compare"] },
  { n: "5", ico: "↬", lines: ["Get transit directions", "and go hike"] },
];

function fmtDuration(mins) {
  if (!mins) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}–${h + 1} h`;
  if (h > 0) return `${h} h`;
  return `${m} m`;
}

function PhotoStrip({ photos, name }) {
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState({});
  const valid = (photos || []).filter((u, i) => u && !failed[i]);
  if (!valid.length) return <div style={{ height: 180, background: "#cfe4dc" }} />;
  return (
    <div style={{ position: "relative", height: 180, overflow: "hidden", flexShrink: 0 }}>
      <img key={valid[idx]} src={valid[idx]} alt={name}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        onError={() => setFailed(f => ({ ...f, [idx]: true }))} />
      {valid.length > 1 && (<>
        <button onClick={() => setIdx((idx - 1 + valid.length) % valid.length)} style={navBtn("left")}>‹</button>
        <button onClick={() => setIdx((idx + 1) % valid.length)} style={navBtn("right")}>›</button>
        <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 4 }}>
          {valid.map((_, i) => (
            <div key={i} onClick={() => setIdx(i)} style={{ width: 6, height: 6, borderRadius: "50%",
              background: i === idx ? "#fff" : "rgba(255,255,255,.5)", cursor: "pointer" }} />
          ))}
        </div>
      </>)}
    </div>
  );
}

function navBtn(side) {
  return { position: "absolute", top: "50%", transform: "translateY(-50%)", [side]: 8,
    background: "rgba(0,0,0,.45)", border: "none", color: "#fff", fontSize: 20,
    cursor: "pointer", borderRadius: 4, padding: "2px 8px", zIndex: 2 };
}

function SourceBadge({ source }) {
  if (!source) return null;
  const isAT = source === "alltrails" || source === "both";
  const isYM = source === "yamap"     || source === "both";
  return (
    <span style={{ color: "#2f3e33", fontSize: 13 }}>
      {isAT && isYM ? "▲ AllTrails + ▲ YAMAP" : isAT ? "▲ AllTrails" : "▲ YAMAP"}
    </span>
  );
}

function MapPreview({ trail }) {
  const [open, setOpen] = useState(false);
  if (!trail.latitude || !trail.longitude) return null;
  const { latitude: lat, longitude: lng } = trail;
  const d = 0.025;
  const osmUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`;
  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  return (
    <div style={{ marginBottom: 10 }}>
      <a onClick={() => setOpen(o => !o)} style={{ height: 42, display: "flex", alignItems: "center",
        justifyContent: "center", border: "1px solid #ddd6cb", borderRadius: 8, background: "#fff",
        color: "#4e5d54", fontSize: 14, fontWeight: 500, cursor: "pointer", textDecoration: "none" }}>
        ▱ {open ? "Hide Map" : "Preview Map"}
      </a>
      {open && (
        <div style={{ marginTop: 6, borderRadius: 6, overflow: "hidden", border: "1px solid #ddd6cb" }}>
          <iframe title={trail.name}
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${lng-d},${lat-d},${lng+d},${lat+d}&layer=mapnik&marker=${lat},${lng}`}
            style={{ width: "100%", height: 180, border: "none", display: "block" }} scrolling="no" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderTop: "1px solid #ddd6cb",
            background: "#f5f0e8" }}>
            <a href={osmUrl} target="_blank" rel="noopener noreferrer"
              style={{ display: "block", textAlign: "center", fontSize: 11, color: "#6b785f",
                padding: "7px 8px", textDecoration: "none", borderRight: "1px solid #ddd6cb" }}>
              Open in OSM ↗
            </a>
            <a href={googleMapsUrl} target="_blank" rel="noopener noreferrer"
              style={{ display: "block", textAlign: "center", fontSize: 11, color: "#2c7f45",
                padding: "7px 8px", textDecoration: "none" }}>
              Google Maps ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function TrailCard({ trail, startingPoint }) {
  const dc = DIFF[trail.difficulty] || DIFF.moderate;
  const atUrl = trail.alltrails_url?.startsWith("http")
    ? trail.alltrails_url
    : `https://www.alltrails.com/search?q=${encodeURIComponent(trail.name)}`;
  const ymUrl = trail.yamap_url?.startsWith("http") ? trail.yamap_url : null;
  const dest = trail.latitude && trail.longitude
    ? `${trail.latitude},${trail.longitude}`
    : encodeURIComponent(trail.name + " trailhead");
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(startingPoint)}&destination=${dest}&travelmode=transit`;

  return (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden",
      border: "1px solid #e4ded2", borderRadius: 12, background: "#fff",
      boxShadow: "0 14px 36px rgba(41,58,46,.08)",
      transition: "transform .2s, box-shadow .2s" }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = "0 20px 48px rgba(41,58,46,.14)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = "0 14px 36px rgba(41,58,46,.08)"; }}>

      {/* Difficulty bar */}
      <div style={{ height: 7, background: dc.dot }} />

      <PhotoStrip photos={trail.photos} name={trail.name} />

      <div style={{ padding: 22, display: "flex", flexDirection: "column", flex: 1 }}>
        {/* Card head */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, marginBottom: 12 }}>
          <h2 style={{ margin: 0, color: "#2f3e33", fontFamily: '"Cormorant Garamond", Georgia, serif',
            fontSize: 28, fontWeight: 400, lineHeight: 1.05 }}>{trail.name}</h2>
        </div>

        {/* Badges */}
        <div style={{ marginBottom: 16, display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ height: 25, padding: "0 10px", display: "inline-flex", alignItems: "center",
            borderRadius: 7, fontSize: 12, fontWeight: 500,
            background: dc.bg, color: dc.text }}>
            {(trail.difficulty || "moderate").charAt(0).toUpperCase() + (trail.difficulty || "moderate").slice(1)}
          </span>
          <SourceBadge source={trail.source} />
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10,
          paddingBottom: 16, marginBottom: 14, borderBottom: "1px solid #e4ded2" }}>
          {[
            { label: "Length",     value: trail.length_km != null ? `${Number(trail.length_km).toFixed(1)} km` : "—" },
            { label: "Elev. Gain", value: trail.elevation_gain_m != null ? `${Math.round(trail.elevation_gain_m)} m` : "—" },
            { label: "Duration",   value: fmtDuration(trail.duration_minutes) },
            { label: "Rating",     value: trail.rating ? `★ ${Number(trail.rating).toFixed(1)}` : "—" },
          ].map(s => (
            <span key={s.label}>
              <b style={{ display: "block", color: "#2f3e33", fontSize: 13, fontWeight: 500 }}>{s.value}</b>
              <small style={{ display: "block", marginTop: 3, color: "#7e877f", fontSize: 10,
                letterSpacing: ".08em", textTransform: "uppercase", fontFamily: '"Space Mono", monospace' }}>{s.label}</small>
            </span>
          ))}
        </div>

        {trail.description && (
          <p style={{ margin: "0 0 16px", color: "#526158", fontSize: 14, lineHeight: 1.55 }}>
            {trail.description}
          </p>
        )}

        <div style={{ marginTop: "auto", display: "grid", gap: 9 }}>
          <MapPreview trail={trail} />

          <div style={{ display: "grid", gridTemplateColumns: atUrl && ymUrl ? "1fr 1fr" : "1fr", gap: 9 }}>
            <a href={atUrl} target="_blank" rel="noopener noreferrer"
              style={{ height: 42, display: "flex", alignItems: "center", justifyContent: "center",
                border: "1px solid #ddd6cb", borderRadius: 8, background: "#fff",
                color: "#2c7f45", fontSize: 14, fontWeight: 500, textDecoration: "none" }}>
              AllTrails ↗
            </a>
            {ymUrl && (
              <a href={ymUrl} target="_blank" rel="noopener noreferrer"
                style={{ height: 42, display: "flex", alignItems: "center", justifyContent: "center",
                  border: "1px solid #ddd6cb", borderRadius: 8, background: "#fff",
                  color: "#d73727", fontSize: 14, fontWeight: 500, textDecoration: "none" }}>
                YAMAP ↗
              </a>
            )}
          </div>

          {startingPoint.trim() ? (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
              style={{ height: 42, display: "flex", alignItems: "center", justifyContent: "center",
                border: "none", borderRadius: 8, background: "linear-gradient(#668462,#466747)",
                color: "#fff", fontSize: 14, fontWeight: 500, textDecoration: "none" }}>
              ▣ Get Transit Directions
            </a>
          ) : (
            <div style={{ height: 42, display: "flex", alignItems: "center", justifyContent: "center",
              background: "#f5f0e8", color: "#9aa099", borderRadius: 8, fontSize: 13 }}>
              Enter starting point for transit
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function HikingDashboard() {
  const [location, setLocation]     = useState("");
  const [startingPoint, setStart]   = useState("");
  const [trails, setTrails]         = useState([]);
  const [loading, setLoading]       = useState(false);
  const [progress, setProgress]     = useState(null);
  const [error, setError]           = useState(null);
  const [model, setModel]           = useState("haiku");
  const [difficulty, setDifficulty] = useState("all");
  const [sortBy, setSortBy]         = useState("default");
  const [searched, setSearched]     = useState(false);
  const [requestedLimit, setLimit]   = useState(INITIAL_TRAIL_LIMIT);

  const searchTrails = async (limit = INITIAL_TRAIL_LIMIT, options = {}) => {
    if (!location.trim() || loading) return;
    const nextLimit = Math.min(MAX_TRAIL_LIMIT, Math.max(INITIAL_TRAIL_LIMIT, limit));
    const keepResults = options.keepResults && trails.length > 0;
    let nextTrails = [];
    setLoading(true); setError(null); setSearched(false); setProgress(null); setLimit(nextLimit);
    if (!keepResults) setTrails([]);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: location.trim(), model, limit: nextLimit }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type === "progress") {
            setProgress({
              found: event.found,
              total: event.total,
              message: event.message,
              cached: event.cached,
            });
          }
          else if (event.type === "batch") {
            nextTrails = [...nextTrails, ...event.trails];
            setTrails(nextTrails);
            setProgress({
              found: event.found,
              total: event.total,
              message: event.message,
              cached: event.cached,
            });
          }
          else if (event.type === "complete") setSearched(true);
          else if (event.type === "error") throw new Error(event.error);
        }
      }
      setSearched(true);
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false); setProgress(null);
    }
  };

  const filtered = trails
    .filter(t => difficulty === "all" || t.difficulty === difficulty)
    .sort((a, b) => {
      if (sortBy === "length")    return (a.length_km || 0) - (b.length_km || 0);
      if (sortBy === "elevation") return (b.elevation_gain_m || 0) - (a.elevation_gain_m || 0);
      if (sortBy === "duration")  return (a.duration_minutes || 0) - (b.duration_minutes || 0);
      if (sortBy === "rating")    return (b.rating || 0) - (a.rating || 0);
      return 0;
    });

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&family=Jost:wght@300;400;500;600&family=Space+Mono&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body, #root { background: #fbfaf6; font-family: Jost, system-ui, sans-serif; min-height: 100vh; color: #26392f; }
        input, select, button, a { font-family: inherit; }
        input:focus { outline: none; border-color: #5d7c60 !important; }
        .hero-banner {
          position: relative;
          min-height: 315px;
          padding: 72px 78px 48px;
          overflow: hidden;
          border-bottom: 1px solid #e7e1d7;
          background: #fff;
        }
        .hero-banner::after {
          content: "";
          position: absolute;
          inset: 0 0 0 auto;
          width: 58%;
          height: 100%;
          background:
            linear-gradient(90deg,#fff 0%,rgba(255,255,255,.86) 16%,rgba(255,255,255,.18) 45%,rgba(255,255,255,0) 100%),
            url("/hero.png");
          background-size: cover;
          background-position: center;
          opacity: .96;
        }
        .hero-copy {
          position: relative;
          z-index: 1;
        }
        .hero-kicker {
          margin-bottom: 22px;
          color: #496b4f;
          font: 13px "Space Mono", monospace;
          letter-spacing: .26em;
          text-transform: uppercase;
        }
        .hero-title {
          margin: 0;
          color: #26392f;
          font-family: "Cormorant Garamond", Georgia, serif;
          font-size: clamp(48px,6vw,76px);
          font-weight: 300;
          line-height: .92;
          letter-spacing: -.035em;
        }
        .hero-title em {
          color: #c55a3f;
          font-style: italic;
          font-weight: 300;
        }
        .hero-subtitle {
          max-width: 640px;
          margin: 22px 0 0;
          color: #5e6c62;
          font-size: 17px;
          line-height: 1.65;
        }
        .steps-rail {
          position: relative;
          z-index: 3;
          margin: -28px 48px 26px;
          display: grid;
          grid-template-columns: repeat(5,1fr);
          overflow: hidden;
          border: 1px solid #e4ded2;
          border-radius: 14px;
          background: rgba(255,255,255,.88);
          box-shadow: 0 10px 28px rgba(42,55,44,.08);
          backdrop-filter: blur(12px);
        }
        .step-tile {
          min-height: 88px;
          padding: 22px 24px;
          display: flex;
          gap: 16px;
          align-items: center;
          border-right: 1px solid #e4ded2;
        }
        .step-tile:last-child {
          border-right: 0;
        }
        .step-num {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #5d7c60;
          color: #fff;
          display: grid;
          place-items: center;
          font: 10px "Space Mono", monospace;
          flex: 0 0 auto;
        }
        .step-icon {
          color: #5d7c60;
          font-size: 24px;
          line-height: 1;
          flex: 0 0 auto;
        }
        .step-text {
          color: #435448;
          font-size: 12px;
          line-height: 1.45;
        }
        @media (max-width: 1100px) {
          .hero-banner {
            padding: 56px 32px 88px;
          }
          .hero-banner::after {
            width: 100%;
            opacity: .36;
          }
          .steps-rail {
            grid-template-columns: repeat(2,1fr);
            margin-inline: 28px;
          }
          .step-tile:nth-child(2n) {
            border-right: 0;
          }
        }
        @media (max-width: 760px) {
          .hero-banner {
            padding: 42px 20px 72px;
          }
          .hero-title {
            font-size: 48px;
          }
          .steps-rail {
            grid-template-columns: 1fr;
            margin: -24px 16px 20px;
          }
          .step-tile {
            border-right: 0;
            border-bottom: 1px solid #e4ded2;
          }
          .step-tile:last-child {
            border-bottom: 0;
          }
        }
        @keyframes bounce { 0%,80%,100%{transform:scale(.7);opacity:.4} 40%{transform:scale(1);opacity:1} }
      `}</style>

      {/* ── HERO ── */}
      <header className="hero-banner">
        <div className="hero-copy">
          <div className="hero-kicker">Trail Planner // Global</div>
          <h1 className="hero-title">
            Explore <em>Hiking</em> Dashboard
          </h1>
          <p className="hero-subtitle">
            Discover scenic trails powered by AllTrails and YAMAP with transit directions to the trailhead.
          </p>
        </div>
      </header>

      {/* ── STEPS — floats over hero ── */}
      <div className="steps-rail">
        {STEPS.map(s => (
          <div key={s.n} className="step-tile">
            <div className="step-num">{s.n}</div>
            <span className="step-icon">{s.ico}</span>
            <span className="step-text">
              {s.lines.map((line, index) => (
                <span key={line}>
                  {index > 0 && <br />}
                  {line}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>

      {/* ── SEARCH ── */}
      <div style={{ margin: "0 48px", padding: 26, display: "grid",
        gridTemplateColumns: "1fr 1fr auto", gap: 26, alignItems: "end",
        border: "1px solid #e4ded2", borderRadius: 14, background: "rgba(255,255,255,.9)",
        boxShadow: "0 8px 24px rgba(42,55,44,.06)" }}>
        <div>
          <label style={{ display: "block", marginBottom: 10, color: "#527056",
            font: '11px "Space Mono", monospace', letterSpacing: ".16em", textTransform: "uppercase" }}>
            Trail area
          </label>
            <input value={location} onChange={e => setLocation(e.target.value)}
            onKeyDown={e => e.key === "Enter" && searchTrails(INITIAL_TRAIL_LIMIT)}
            placeholder="⌖  e.g., Taipei, Kamikochi, Banff, Kinabalu Park"
            style={{ width: "100%", height: 58, padding: "0 18px", display: "flex", alignItems: "center",
              border: "1px solid #ddd6cb", borderRadius: 8, background: "#fff",
              color: "#26392f", fontSize: 15 }} />
        </div>
        <div>
          <label style={{ display: "block", marginBottom: 10, color: "#527056",
            font: '11px "Space Mono", monospace', letterSpacing: ".16em", textTransform: "uppercase" }}>
            Your starting point (for transit)
          </label>
          <input value={startingPoint} onChange={e => setStart(e.target.value)}
            onKeyDown={e => e.key === "Enter" && searchTrails(INITIAL_TRAIL_LIMIT)}
            placeholder="▣  e.g., Shinjuku Station, London, Edmonton, Rifugio Auronzo"
            style={{ width: "100%", height: 58, padding: "0 18px",
              border: "1px solid #ddd6cb", borderRadius: 8, background: "#fff",
              color: "#26392f", fontSize: 15 }} />
        </div>
        <button onClick={() => searchTrails(INITIAL_TRAIL_LIMIT)} disabled={loading || !location.trim()}
          style={{ height: 58, padding: "0 36px", border: "none", borderRadius: 8,
            background: loading || !location.trim() ? "#8aaa90" : "linear-gradient(#668462,#466747)",
            color: "#fff", fontSize: 16, fontWeight: 500,
            boxShadow: loading || !location.trim() ? "none" : "0 12px 22px rgba(70,103,71,.18)",
            cursor: loading || !location.trim() ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
          ⌕ {loading ? "Searching..." : "Find Trails"}
        </button>
      </div>

      {/* ── TOOLBAR ── */}
      <div style={{ margin: "32px 48px 0", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>

        {/* AI Model */}
        <span style={monoLabel}>AI Model</span>
        {[{ id: "haiku", label: "Claude Haiku 4.5" }, { id: "gpt54", label: "GPT-5.4 Mini" }].map(m => (
          <button key={m.id} onClick={() => setModel(m.id)} disabled={loading}
            style={{ height: 39, padding: "0 18px", display: "inline-flex", alignItems: "center",
              border: `1px solid ${model === m.id ? "#557356" : "#ddd6cb"}`,
              borderRadius: 999, background: model === m.id ? "#557356" : "#fff",
              color: model === m.id ? "#fff" : "#58645c",
              fontSize: 13, fontWeight: 500, cursor: "pointer",
              boxShadow: "0 6px 16px rgba(42,55,44,.04)" }}>
            {m.label}
          </button>
        ))}
        <span style={{ flexBasis: "100%", marginTop: -4, marginLeft: 1, color: "#7a857d",
          fontSize: 12, lineHeight: 1.45 }}>
          Claude and OpenAI models consume API credits. If a search returns a token limit error, it probably means the credits ran out ૮(◞ ‸ ◟ )ა
          I show 10 trails first to reduce the chance of hitting limits, then you can load more up to 20 trails. (˶ᵔ ᵕ ᵔ˶) ‹3
        </span>

        <div style={{ width: 1, height: 20, background: "#ddd6cb" }} />

        {/* Difficulty */}
        <span style={monoLabel}>Difficulty</span>
        {["all", "easy", "moderate", "hard"].map(d => {
          const dc = d === "all" ? null : DIFF[d];
          const active = difficulty === d;
          return (
            <button key={d} onClick={() => setDifficulty(d)}
              style={{ height: 39, padding: "0 18px", display: "inline-flex", alignItems: "center", gap: 9,
                border: `1px solid ${active ? (dc?.dot || "#557356") : "#ddd6cb"}`,
                borderRadius: 999, background: active ? (dc?.bg || "#eef5eb") : "#fff",
                color: active ? (dc?.text || "#4f8a42") : "#58645c",
                fontSize: 13, fontWeight: 500, cursor: "pointer",
                boxShadow: "0 6px 16px rgba(42,55,44,.04)" }}>
              {dc && <i style={{ width: 11, height: 11, borderRadius: "50%", background: dc.dot, display: "inline-block" }} />}
              {d === "all" ? "All" : d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          );
        })}

        <div style={{ flex: 1 }} />

        {/* Sort */}
        <span style={monoLabel}>Sort by</span>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ height: 42, minWidth: 170, padding: "0 14px",
            border: "1px solid #ddd6cb", borderRadius: 8, background: "#fff",
            color: "#5c655e", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
          <option value="default">Recommended</option>
          <option value="rating">Rating</option>
          <option value="length">Length</option>
          <option value="elevation">Elevation</option>
          <option value="duration">Duration</option>
        </select>

        {filtered.length > 0 && (
          <span style={{ color: "#527056", font: '12px "Space Mono", monospace',
            letterSpacing: ".13em", textTransform: "uppercase" }}>
            {filtered.length} trails found
          </span>
        )}
      </div>

      {/* ── MAIN CONTENT ── */}
      <main style={{ padding: "32px 48px 40px" }}>
        {error && (
          <div style={{ background: "#fff0ec", border: "1px solid #f5c2be", borderRadius: 8,
            color: "#ce5139", padding: "14px 18px", marginBottom: 24, fontSize: 14,
            display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center",
            flexWrap: "wrap" }}>
            <span>{error}</span>
            {location.trim() && (
              <button onClick={() => searchTrails(requestedLimit, { keepResults: trails.length > 0 })} disabled={loading}
                style={{ height: 36, padding: "0 15px", border: "1px solid #ce5139",
                  borderRadius: 8, background: "#fff", color: "#ce5139", fontSize: 13,
                  fontWeight: 600, cursor: loading ? "not-allowed" : "pointer" }}>
                Retry same search
              </button>
            )}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div style={{ display: "flex", gap: 7, justifyContent: "center", marginBottom: 20 }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: "#5d7c60",
                  animation: "bounce 1.4s ease-in-out infinite", animationDelay: `${i * 0.2}s` }} />
              ))}
            </div>
            <div style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 24,
              fontStyle: "italic", fontWeight: 300, color: "#435448" }}>
              {progress?.message || "Searching trails…"}
            </div>
            {progress && (
              <div style={{ marginTop: 8, color: "#7e877f", fontSize: 13 }}>
                {progress.cached
                  ? "Using cached results to save API credits."
                  : `Found ${progress.found || 0} / ${progress.total || 20} trails so far.`}
              </div>
            )}
            <div style={{ marginTop: 8, color: "#9aa099", fontSize: 12 }}>
              Live web search can take a moment. I will retry once when the provider comes back empty.
            </div>
          </div>
        )}

        {!loading && !error && !searched && trails.length === 0 && (
          <div style={{ textAlign: "center", padding: "100px 0" }}>
            <div style={{ fontSize: 56, marginBottom: 20 }}>⛰️</div>
            <div style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 30,
              fontStyle: "italic", fontWeight: 300, color: "#526158", marginBottom: 10 }}>
              Search for your next trail
            </div>
            <div style={{ fontSize: 15, color: "#7e877f" }}>Enter any city, region, or park worldwide</div>
          </div>
        )}

        {!loading && searched && trails.length === 0 && (
          <div style={{ textAlign: "center", padding: "100px 0" }}>
            <div style={{ fontSize: 56, marginBottom: 20 }}>🔍</div>
            <div style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 30,
              fontStyle: "italic", fontWeight: 300, color: "#526158", marginBottom: 10 }}>
              No trails found
            </div>
            <div style={{ fontSize: 15, color: "#7e877f" }}>
              Live web search can miss on the first try. Retry once, or try a nearby area.
            </div>
          </div>
        )}

        {filtered.length > 0 && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 22 }}>
              {filtered.map((trail, i) => (
                <TrailCard key={trail.id || i} trail={trail} startingPoint={startingPoint} />
              ))}
            </div>
            {searched && requestedLimit < MAX_TRAIL_LIMIT && trails.length >= requestedLimit && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 28 }}>
                <button onClick={() => searchTrails(MAX_TRAIL_LIMIT, { keepResults: true })} disabled={loading}
                  style={{ height: 46, padding: "0 22px", border: "1px solid #557356",
                    borderRadius: 8, background: loading ? "#eef5eb" : "#fff",
                    color: "#557356", fontSize: 14, fontWeight: 600,
                    cursor: loading ? "not-allowed" : "pointer",
                    boxShadow: "0 8px 20px rgba(42,55,44,.06)" }}>
                  Load more trails
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── FOOTER ── */}
      <footer style={{ margin: "0 48px", padding: "20px 0 30px", display: "flex", gap: 20,
        alignItems: "center", borderTop: "1px solid #e4ded2", color: "#69756e", flexWrap: "wrap" }}>
        <span style={monoLabel}>Difficulty key:</span>
        {["easy", "moderate", "hard"].map(d => (
          <span key={d} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <i style={{ width: 11, height: 11, borderRadius: "50%", background: DIFF[d].dot, display: "inline-block" }} />
            <span style={{ textTransform: "capitalize", fontSize: 13 }}>{d}</span>
          </span>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 13 }}>
          Powered by <strong style={{ color: "#4a8c42" }}>AllTrails</strong> &amp; <strong style={{ color: "#4a8c42" }}>YAMAP</strong> via <strong style={{ color: "#4a8c42" }}>Claude AI</strong> &amp; <strong style={{ color: "#4a8c42" }}>OpenAI</strong>
        </span>
        <div style={{ width: "100%", fontSize: 11, color: "#9aa099", fontStyle: "italic", textAlign: "right" }}>
          Trail photos sourced from Wikimedia Commons and may not accurately represent each trail.
        </div>
      </footer>
    </>
  );
}

const monoLabel = {
  color: "#527056",
  font: '11px "Space Mono", monospace',
  letterSpacing: ".14em",
  textTransform: "uppercase",
};
