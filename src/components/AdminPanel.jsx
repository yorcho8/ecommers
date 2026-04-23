// src/components/AdminPanel.jsx
// ACCESOS:
//   Ctrl + 9  |  ADMIN (todo):        JUANPA
//   Ctrl + 9  |  RH (reclutamiento):  RH2025
//   Ctrl + 9  |  Distribuidor:        DIST2025

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DownloadReportButton } from './ReportGenerator';
import RecruitmentTab from './RecruitmentTab';
import EmpresasTab from './EmpresasTab';

// -- Roles --------------------------------------------------------------------
const ROLES = [
  { password: 'GOSUPER2026',  name: 'SuperAdmin',   color: '#A855F7', tabs: ['empresas','overview','activity','products','keywords','messages','distribuidores','recruitment','ai'], canDownload: true, isSuperAdmin: true },
  { password: 'JCADMIN2847', name: 'Admin',        color: '#7A2532', tabs: ['overview','activity','products','keywords','messages','distribuidores','recruitment','ai'], canDownload: true  },
  { password: 'RH5931',      name: 'RH',           color: '#8B5CF6', tabs: ['recruitment'],                                                                             canDownload: false },
  { password: 'Dist7462',    name: 'Distribuidor', color: '#22C55E', tabs: ['distribuidores'],                                                                          canDownload: false },
];

function getRoleByPassword(pw) {
  return ROLES.find(r => r.password === pw) || null;
}

// -- Logo del Bot -------------------------------------------------------------
const RobotIcon = ({ size = 36, style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="none" style={style}>
    <defs>
      <linearGradient id="adminHeadGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#F24F13"/>
        <stop offset="100%" stopColor="#F24F13"/>
      </linearGradient>
    </defs>
    <line x1="20" y1="35" x2="15" y2="20" stroke="#F24F13" strokeWidth="4" strokeLinecap="round"/>
    <circle cx="15" cy="20" r="4" fill="#F24F13"/>
    <line x1="80" y1="35" x2="85" y2="20" stroke="#F24F13" strokeWidth="4" strokeLinecap="round"/>
    <circle cx="85" cy="20" r="4" fill="#F24F13"/>
    <circle cx="50" cy="55" r="40" fill="url(#adminHeadGrad)"/>
    <ellipse cx="50" cy="58" rx="32" ry="30" fill="#FFF5E6"/>
    <rect x="25" y="45" width="50" height="22" rx="10" fill="#F24F13"/>
    <circle cx="38" cy="56" r="5" fill="#FFD700"/>
    <circle cx="62" cy="56" r="5" fill="#FFD700"/>
    <ellipse cx="50" cy="78" rx="6" ry="2" fill="#D35400" opacity="0.8"/>
  </svg>
);

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&family=DM+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .admin-overlay {
    position: fixed; inset: 0; z-index: 999990;
    background: rgba(0,0,0,0.7);
    backdrop-filter: blur(24px) saturate(120%);
    -webkit-backdrop-filter: blur(24px) saturate(120%);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; opacity: 0; transition: opacity 0.3s ease;
  }
  .admin-overlay.visible { opacity: 1; }

  .admin-panel-root,
  .admin-panel-root * { font-family: 'DM Sans', system-ui, -apple-system, sans-serif !important; }
  .admin-panel-root input,
  .admin-panel-root button,
  .admin-panel-root select,
  .admin-panel-root textarea { font-family: 'DM Sans', system-ui, -apple-system, sans-serif !important; }
  .admin-panel-root .stat-num,
  .admin-panel-root .mono,
  .admin-panel-root code,
  .admin-panel-root pre { font-family: 'DM Mono', 'Fira Mono', monospace !important; }

  .admin-dash { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.06) transparent; }
  .admin-dash::-webkit-scrollbar { width: 3px; }
  .admin-dash::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 2px; }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes barGrow { from { width: 0; } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .panel-enter { animation: fadeUp 0.32s cubic-bezier(0.16,1,0.3,1) both; }
  .card-enter  { animation: fadeUp 0.28s cubic-bezier(0.16,1,0.3,1) both; }
  .card-enter:nth-child(1) { animation-delay: 0.03s; }
  .card-enter:nth-child(2) { animation-delay: 0.07s; }
  .card-enter:nth-child(3) { animation-delay: 0.11s; }
  .card-enter:nth-child(4) { animation-delay: 0.15s; }
  .bar-fill { animation: barGrow 0.7s cubic-bezier(0.16,1,0.3,1) both; }
  .tab-content { animation: fadeUp 0.22s ease both; }

  .card-hover { transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease; }
  .card-hover:hover {
    background: rgba(255,255,255,0.025) !important;
    border-color: rgba(255,255,255,0.1) !important;
    transform: translateY(-1px);
  }

  .tab-btn { position: relative; transition: color 0.15s ease, background 0.15s ease; border-radius: 6px; }
  .tab-btn:hover { background: rgba(255,255,255,0.04); }
  .tab-btn.active { background: rgba(255,255,255,0.06); }
  .tab-btn.active::after {
    content: ''; position: absolute; bottom: -1px; left: 12px; right: 12px;
    height: 1.5px; background: #fff; border-radius: 2px;
  }

  .btn-base { transition: opacity 0.15s ease, background 0.15s ease, transform 0.12s ease; cursor: pointer; }
  .btn-base:hover:not(:disabled) { opacity: 0.85; }
  .btn-base:active:not(:disabled) { transform: scale(0.97); }

  .row-hover { transition: background 0.1s ease; }
  .row-hover:hover { background: rgba(255,255,255,0.03) !important; }

  .period-btn {
    padding: 4px 11px; border-radius: 6px; font-size: 11px; font-weight: 500;
    cursor: pointer; transition: all 0.13s ease; white-space: nowrap;
    font-family: 'DM Sans', system-ui, sans-serif; border: 1px solid transparent;
    background: transparent; color: rgba(255,255,255,0.35); letter-spacing: 0.01em;
  }
  .period-btn:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.05); }
  .period-btn.active { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.12); color: rgba(255,255,255,0.9); }

  .period-date-input {
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px; padding: 4px 8px; color: rgba(255,255,255,0.8);
    font-size: 11px; font-family: 'DM Sans', system-ui, sans-serif;
    outline: none; cursor: pointer; transition: border-color 0.13s ease; color-scheme: dark;
  }
  .period-date-input:focus { border-color: rgba(255,255,255,0.25); }

  .period-apply {
    padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 600;
    cursor: pointer; background: rgba(255,255,255,0.9); color: #0a0a0a; border: none;
    transition: all 0.13s ease; font-family: 'DM Sans', system-ui, sans-serif;
  }
  .period-apply:disabled { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.2); cursor: not-allowed; }
  .period-apply:hover:not(:disabled) { background: #fff; }

  input:-webkit-autofill {
    -webkit-box-shadow: 0 0 0 100px #0d0d0d inset !important;
    -webkit-text-fill-color: rgba(255,255,255,0.9) !important;
  }
  .stat-num { font-family: 'DM Mono', monospace; font-weight: 500; letter-spacing: -0.03em; line-height: 1; }
`;

// -- Paleta -------------------------------------------------------------------
const C = {
  bg:         '#080808',
  surface:    '#111111',
  surface2:   '#161616',
  border:     'rgba(255,255,255,0.07)',
  border2:    'rgba(255,255,255,0.04)',
  text:       'rgba(255,255,255,0.92)',
  textSub:    'rgba(255,255,255,0.45)',
  textDim:    'rgba(255,255,255,0.22)',
  orange:     '#7A2532',
  orangeDim:  'rgba(122,37,50,0.10)',
  orangeGlow: 'rgba(122,37,50,0.15)',
  green:      '#22C55E',
  greenDim:   'rgba(34,197,94,0.08)',
  blue:       '#3B82F6',
  blueDim:    'rgba(59,130,246,0.08)',
  purple:     '#8B5CF6',
  purpleDim:  'rgba(139,92,246,0.08)',
  amber:      '#F59E0B',
  amberDim:   'rgba(245,158,11,0.08)',
  red:        '#EF4444',
  redDim:     'rgba(239,68,68,0.08)',
};

const T = {
  sans: "'DM Sans', system-ui, sans-serif",
  mono: "'DM Mono', monospace",
};

// -- Date helpers --------------------------------------------------------------
function toYMD(d) { return d.toISOString().split('T')[0]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

const PERIOD_PRESETS = [
  { id:'today', label:'Hoy',      getRange: () => { const t=toYMD(new Date()); return {from:t,to:t}; } },
  { id:'7d',    label:'7D',       getRange: () => ({ from:toYMD(addDays(new Date(),-6)), to:toYMD(new Date()) }) },
  { id:'30d',   label:'30D',      getRange: () => ({ from:toYMD(addDays(new Date(),-29)), to:toYMD(new Date()) }) },
  { id:'month', label:'Este mes', getRange: () => ({ from:toYMD(new Date(new Date().getFullYear(),new Date().getMonth(),1)), to:toYMD(new Date()) }) },
  { id:'all',   label:'Todo',     getRange: () => ({ from:null, to:null }) },
  { id:'custom',label:'Rango',    getRange: () => null },
];

// -- Period Selector -----------------------------------------------------------
function PeriodSelector({ activeId, onSelect, customFrom, customTo, setCustomFrom, setCustomTo, onApplyCustom }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:2, flexWrap:'wrap' }}>
      <span style={{ color:C.textDim, fontSize:10, fontFamily:T.sans, marginRight:6, letterSpacing:'0.06em', textTransform:'uppercase', fontWeight:500 }}>Periodo</span>
      {PERIOD_PRESETS.filter(p => p.id !== 'custom').map(p => (
        <button key={p.id} className={`period-btn ${activeId===p.id?'active':''}`} onClick={() => onSelect(p)}>{p.label}</button>
      ))}
      <div style={{ width:1, height:14, background:C.border, margin:'0 4px' }}/>
      <button className={`period-btn ${activeId==='custom'?'active':''}`} onClick={() => onSelect(PERIOD_PRESETS.find(p=>p.id==='custom'))}>
        Personalizado
      </button>
      {activeId==='custom' && (
        <div style={{ display:'flex', alignItems:'center', gap:6, animation:'fadeIn 0.18s ease' }}>
          <input type="date" className="period-date-input" value={customFrom} max={customTo||toYMD(new Date())} onChange={e=>setCustomFrom(e.target.value)}/>
          <span style={{ color:C.textDim, fontSize:10 }}>-</span>
          <input type="date" className="period-date-input" value={customTo} min={customFrom} max={toYMD(new Date())} onChange={e=>setCustomTo(e.target.value)}/>
          <button className="period-apply" disabled={!customFrom||!customTo} onClick={onApplyCustom}>Aplicar</button>
        </div>
      )}
    </div>
  );
}

// -- Small components ----------------------------------------------------------
function Dot({ active, color = C.green }) {
  return (
    <span style={{
      width:5, height:5, borderRadius:'50%',
      background: active ? color : C.textDim,
      display:'inline-block', flexShrink:0,
      boxShadow: active ? `0 0 5px ${color}` : 'none',
      animation: active ? 'pulse 2.4s infinite' : 'none',
    }}/>
  );
}

function Tag({ children, color = C.orange }) {
  return (
    <span style={{
      display:'inline-flex', alignItems:'center',
      padding:'2px 8px', borderRadius:4,
      fontSize:10, fontWeight:500, letterSpacing:'0.04em',
      background: color + '15', color,
      border: `1px solid ${color}22`,
      fontFamily:T.sans, lineHeight:1.5,
    }}>{children}</span>
  );
}

function Spinner() {
  return (
    <div style={{ display:'flex', justifyContent:'center', alignItems:'center', padding:'80px 0', flexDirection:'column', gap:12 }}>
      <div style={{ width:24, height:24, borderRadius:'50%', border:`1.5px solid ${C.border}`, borderTop:`1.5px solid ${C.textSub}`, animation:'spin 0.7s linear infinite' }}/>
      <span style={{ color:C.textDim, fontSize:11, fontFamily:T.sans, letterSpacing:'0.06em' }}>Cargando</span>
      <style>{GLOBAL_CSS}</style>
    </div>
  );
}

// -- Bar Chart ----------------------------------------------------------------
function BarChart({ data = [], color = C.orange, max = 8 }) {
  const sorted = [...data].sort((a,b) => b.value - a.value).slice(0, max);
  const mv = sorted[0]?.value || 1;
  if (!sorted.length) return (
    <div style={{ textAlign:'center', padding:'40px 0', color:C.textDim, fontSize:11, fontFamily:T.sans }}>Sin datos disponibles</div>
  );
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
      {sorted.map((item, i) => {
        const pct = Math.round((item.value / mv) * 100);
        return (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'6px 0' }}>
            <span style={{ color:C.textDim, fontSize:10, fontFamily:T.mono, width:16, textAlign:'right', flexShrink:0 }}>{i+1}</span>
            <span style={{ color:C.textSub, fontSize:12, width:110, textAlign:'right', flexShrink:0, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', fontFamily:T.sans }}>{item.label}</span>
            <div style={{ flex:1, position:'relative', height:6, background:'rgba(255,255,255,0.04)', borderRadius:3, overflow:'hidden' }}>
              <div className="bar-fill" style={{ width:`${pct}%`, height:'100%', borderRadius:3, background: i===0 ? color : `linear-gradient(90deg,${color}55,${color}88)`, animationDelay:`${i*0.05}s` }}/>
            </div>
            <span style={{ color:C.text, fontSize:12, fontFamily:T.mono, fontWeight:500, width:32, textAlign:'right', flexShrink:0 }}>{item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

// -- Line Chart ---------------------------------------------------------------
function LineChart({ daily }) {
  const entries = Object.entries(daily || {}).sort(([a],[b]) => a.localeCompare(b)).slice(-14);
  if (entries.length < 2) return (
    <div style={{ textAlign:'center', padding:'40px 0', color:C.textDim, fontSize:11, fontFamily:T.sans }}>Se necesitan al menos 2 dias de datos</div>
  );
  const vals = entries.map(([,v]) => v.messages || 0);
  const mv = Math.max(...vals, 1), mn = Math.min(...vals);
  const W = 440, H = 80, step = W / (vals.length - 1);
  const pts = vals.map((v, i) => ({ x: i*step, y: H - ((v-mn)/Math.max(mv-mn,1))*(H-16) - 8 }));
  const pathD = pts.map((p,i) => `${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L${W},${H+4} L0,${H+4} Z`;
  return (
    <svg width="100%" viewBox={`-4 -4 ${W+8} ${H+48}`} style={{ display:'block', overflow:'visible' }}>
      <defs>
        <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.orange} stopOpacity="0.15"/>
          <stop offset="100%" stopColor={C.orange} stopOpacity="0"/>
        </linearGradient>
        <filter id="line-glow">
          <feGaussianBlur stdDeviation="1.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      {[0.25,0.5,0.75,1].map(p => (
        <line key={p} x1={0} y1={H-p*(H-16)-8} x2={W} y2={H-p*(H-16)-8} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>
      ))}
      <path d={areaD} fill="url(#area-grad)"/>
      <path d={pathD} fill="none" stroke={C.orange} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" filter="url(#line-glow)"/>
      {pts.map((p,i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="2.5" fill={C.bg} stroke={C.orange} strokeWidth="1.5"/>
          <text x={p.x} y={H+32} textAnchor="middle" fill="rgba(255,255,255,0.25)" fontSize="9" fontFamily="DM Sans, system-ui">{entries[i][0].slice(5)}</text>
        </g>
      ))}
    </svg>
  );
}

// -- Donut Chart --------------------------------------------------------------
function DonutChart({ intents }) {
  const COLORS = { compra:C.green, pdf:C.blue, info:C.amber, reclutamiento:C.purple, otro:'rgba(255,255,255,0.15)' };
  const LABELS = { compra:'Compra', pdf:'PDF', info:'Info', reclutamiento:'Empleo', otro:'Otro' };
  const ents = Object.entries(intents || {}).filter(([,v]) => v > 0);
  const total = ents.reduce((s,[,v]) => s+v, 0) || 1;
  let cumul = 0;
  const R=42, CX=54, CY=54;
  const polar = (pct) => { const a=pct*2*Math.PI-Math.PI/2; return [CX+R*Math.cos(a), CY+R*Math.sin(a)]; };
  const slices = ents.map(([key,val]) => { const pct=val/total, start=cumul; cumul+=pct; return {key,val,pct,start}; });
  return (
    <div style={{ display:'flex', alignItems:'center', gap:24, flexWrap:'wrap' }}>
      <svg width={108} height={108} viewBox="0 0 108 108" style={{ flexShrink:0 }}>
        {slices.length===0
          ? <circle cx={CX} cy={CY} r={R} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
          : slices.map(({key,pct,start}) => {
              const [x1,y1]=polar(start+0.004), [x2,y2]=polar(start+pct-0.004);
              return <path key={key} d={`M${CX},${CY} L${x1},${y1} A${R},${R} 0 ${pct>.5?1:0},1 ${x2},${y2} Z`} fill={COLORS[key]||C.textSub} opacity="0.85"/>;
            })
        }
        <circle cx={CX} cy={CY} r={30} fill={C.bg}/>
        <circle cx={CX} cy={CY} r={30} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>
        <text x={CX} y={CY-7} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="8.5" fontFamily="DM Sans, system-ui" letterSpacing="0.08em">TOTAL</text>
        <text x={CX} y={CY+13} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize="22" fontFamily="DM Mono, monospace" fontWeight="500">{total}</text>
      </svg>
      <div style={{ display:'flex', flexDirection:'column', gap:7, flex:1 }}>
        {ents.map(([key,val]) => {
          const color=COLORS[key]||C.textSub, pct=Math.round((val/total)*100);
          return (
            <div key={key} style={{ display:'flex', alignItems:'center', gap:9 }}>
              <div style={{ width:3, height:3, borderRadius:'50%', background:color, flexShrink:0 }}/>
              <span style={{ color:C.textSub, fontSize:11, flex:1, fontFamily:T.sans }}>{LABELS[key]||key}</span>
              <span style={{ color:C.text, fontSize:11, fontFamily:T.mono, fontWeight:500 }}>{val}</span>
              <span style={{ color:C.textDim, fontSize:10, fontFamily:T.mono, width:30, textAlign:'right' }}>{pct}%</span>
            </div>
          );
        })}
        {!ents.length && <span style={{ color:C.textDim, fontSize:11, fontFamily:T.sans }}>Sin datos</span>}
      </div>
    </div>
  );
}

// -- Leads Mini Chart -------------------------------------------------------
function LeadsLineChart({ leads }) {
  if (!leads.length) return null;
  const byDay = {};
  leads.forEach(l => {
    const d = (l.ts || '').split('T')[0] || (l.ts || '').split(' ')[0];
    if (d) byDay[d] = (byDay[d] || 0) + 1;
  });
  const entries = Object.entries(byDay).sort(([a],[b]) => a.localeCompare(b)).slice(-14);
  if (entries.length < 2) return null;
  const vals = entries.map(([,v]) => v);
  const mv = Math.max(...vals, 1), mn = Math.min(...vals);
  const W = 440, H = 60, step = W / (vals.length - 1);
  const pts = vals.map((v,i) => ({ x:i*step, y:H-((v-mn)/Math.max(mv-mn,1))*(H-12)-6 }));
  const pathD = pts.map((p,i) => `${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L${W},${H+4} L0,${H+4} Z`;
  return (
    <svg width="100%" viewBox={`-4 -4 ${W+8} ${H+40}`} style={{ display:'block', overflow:'visible' }}>
      <defs>
        <linearGradient id="leads-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.green} stopOpacity="0.18"/>
          <stop offset="100%" stopColor={C.green} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#leads-grad)"/>
      <path d={pathD} fill="none" stroke={C.green} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      {pts.map((p,i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="2.5" fill={C.bg} stroke={C.green} strokeWidth="1.5"/>
          <text x={p.x} y={H+28} textAnchor="middle" fill="rgba(255,255,255,0.22)" fontSize="9" fontFamily="DM Sans, system-ui">{entries[i][0].slice(5)}</text>
        </g>
      ))}
    </svg>
  );
}

// -- Stat Card --------------------------------------------------------------
function StatCard({ label, value, sub, color = C.orange, icon, trend }) {
  const [disp, setDisp] = useState(0);
  const target = typeof value === 'number' ? value : 0;
  useEffect(() => {
    if (!target) { setDisp(0); return; }
    const dur=800, t0=Date.now();
    const tick = () => {
      const p=Math.min((Date.now()-t0)/dur,1), e=1-Math.pow(1-p,3);
      setDisp(Math.round(target*e));
      if (p<1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [target]);
  return (
    <div className="card-enter card-hover" style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:'18px 20px', position:'relative', overflow:'hidden' }}>
      <div style={{ position:'absolute', top:0, left:0, right:0, height:1, background:color, opacity:0.35 }}/>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:12 }}>
        <span style={{ color:C.textDim, fontSize:10, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.08em', fontFamily:T.sans }}>{label}</span>
        {icon && <span style={{ fontSize:14, opacity:0.18 }}>{icon}</span>}
      </div>
      <p className="stat-num" style={{ color:C.text, fontSize:36, marginBottom:8 }}>
        {typeof value === 'number' ? disp.toLocaleString('es-MX') : (value ?? '-')}
      </p>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        {sub && <span style={{ color:C.textDim, fontSize:11, fontFamily:T.sans }}>{sub}</span>}
        {trend !== undefined && (
          <span style={{ fontSize:10, fontWeight:500, padding:'1px 6px', borderRadius:4, fontFamily:T.mono,
            background: trend>0?C.greenDim:trend<0?C.redDim:'rgba(255,255,255,0.03)',
            color: trend>0?C.green:trend<0?C.red:C.textDim,
            border: `1px solid ${trend>0?C.green+'22':trend<0?C.red+'22':'rgba(255,255,255,0.05)'}`,
          }}>{trend>0?'+':''}{trend}</span>
        )}
      </div>
    </div>
  );
}

// -- Section Label ----------------------------------------------------------
function SectionLabel({ children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
      <span style={{ color:C.textSub, fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.1em', fontFamily:T.sans, flexShrink:0 }}>{children}</span>
      <div style={{ flex:1, height:1, background:`linear-gradient(90deg,${C.border},transparent)` }}/>
    </div>
  );
}

// -- Login ------------------------------------------------------------------
function Login({ onLogin }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const cardRef  = useRef(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 250); }, []);
  const shake = () => {
    const el = cardRef.current; if (!el) return;
    [-7,7,-4,4,-2,2,0].forEach((x,i) => setTimeout(() => { el.style.transform=`translateX(${x}px)`; }, i*50));
  };
  const go = async (e) => {
    e.preventDefault(); setLoading(true);
    await new Promise(r => setTimeout(r, 380));
    const role = getRoleByPassword(pw);
    if (role) { onLogin(pw, role); }
    else { setErr(true); shake(); setTimeout(() => setErr(false), 2500); }
    setLoading(false);
  };
  return (
    <div ref={cardRef} style={{ padding:'48px 44px 44px', animation:'fadeUp 0.4s cubic-bezier(0.16,1,0.3,1) both', transition:'transform 0.05s ease' }}>
      <div style={{ textAlign:'center', marginBottom:32 }}>
        <div style={{ width:64, height:64, borderRadius:16, background:C.surface2, border:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 20px' }}>
          <RobotIcon size={42}/>
        </div>
        <h2 style={{ fontFamily:T.sans, fontWeight:600, fontSize:20, color:C.text, letterSpacing:'-0.02em', marginBottom:6 }}>Panel Admin</h2>
        <p style={{ color:C.textDim, fontSize:12, fontFamily:T.sans }}>Nexus Analytics</p>
      </div>
      <form onSubmit={go} style={{ display:'flex', flexDirection:'column', gap:10 }}>
        <input ref={inputRef} type="password" value={pw} onChange={e=>setPw(e.target.value)}
          onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} placeholder="Contrasena"
          style={{ width:'100%', background:C.surface2, border:`1px solid ${err?C.red+'60':focused?'rgba(255,255,255,0.2)':C.border}`, borderRadius:8, padding:'11px 14px', color:C.text, fontSize:13, outline:'none', fontFamily:T.sans, transition:'border-color 0.15s ease' }}
        />
        {err && <div style={{ background:C.redDim, border:`1px solid ${C.red}25`, borderRadius:7, padding:'8px 12px', color:C.red, fontSize:11, fontFamily:T.sans }}>Contrasena incorrecta</div>}
        <button type="submit" disabled={loading||!pw} className="btn-base" style={{ background:loading||!pw?'rgba(255,255,255,0.04)':'rgba(255,255,255,0.9)', color:loading||!pw?C.textDim:'#0a0a0a', border:'none', borderRadius:8, padding:'11px 0', fontFamily:T.sans, fontSize:13, fontWeight:600, cursor:loading||!pw?'not-allowed':'pointer', transition:'all 0.15s ease' }}>
          {loading ? <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}><div style={{ width:12, height:12, borderRadius:'50%', border:'1.5px solid rgba(0,0,0,0.2)', borderTop:'1.5px solid rgba(0,0,0,0.7)', animation:'spin 0.7s linear infinite' }}/>Verificando</span> : 'Continuar'}
        </button>
      </form>

      {/* Hint de roles - puedes eliminar este bloque en produccion */}
      <div style={{ marginTop:20, padding:'10px 14px', background:'rgba(255,255,255,0.02)', border:`1px solid ${C.border}`, borderRadius:8 }}>
        <p style={{ color:C.textDim, fontSize:10, fontFamily:T.sans, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.07em' }}>Accesos disponibles</p>
        {ROLES.map(r => (
          <div key={r.name} style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 0' }}>
            <span style={{ width:6, height:6, borderRadius:'50%', background:r.color, flexShrink:0 }}/>
            <span style={{ color:r.color, fontSize:10, fontFamily:T.mono, fontWeight:500, width:76 }}>{r.name}</span>
            <span style={{ color:C.textDim, fontSize:10, fontFamily:T.sans }}>
              {r.isSuperAdmin ? 'Acceso total + gestion de empresas' : r.canDownload ? 'Acceso total + reportes' : `Solo ${r.tabs.join(', ')}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


function Dash({ onClose, role }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState('');
  const [genAI,   setGenAI]   = useState(false);
  const [tab,     setTab]     = useState(role.tabs[0]);
  const [last,    setLast]    = useState(null);
  const [auto,    setAuto]    = useState(true);
  const itvRef = useRef(null);

  const [activePresetId, setActivePresetId] = useState('30d');
  const [activePeriod,   setActivePeriod]   = useState(() => PERIOD_PRESETS.find(p=>p.id==='30d').getRange());
  const [customFrom, setCustomFrom] = useState('');
  const [customTo,   setCustomTo]   = useState('');

  const [leads,      setLeads]      = useState([]);
  const [leadsLoad,  setLeadsLoad]  = useState(false);
  const [leadSearch, setLeadSearch] = useState('');

  const isAdmin = role.canDownload; // only JUANPA


  const canSee = (tabId) => role.tabs.includes(tabId);


  const load = useCallback(async (silent=false, from=null, to=null) => {
    if (!silent) setLoading(true);
    try {
      const body = { action:'get' };
      if (from) body.from = from;
      if (to)   body.to   = to;
      const r = await fetch('/api/analytics', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) { setData(j.data); setLast(new Date()); }
    } catch(e) { console.error(e); }
    if (!silent) setLoading(false);
  }, []);

  const loadLeads = useCallback(async () => {
    setLeadsLoad(true);
    try {
      const r = await fetch('/api/analytics', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'getLeads' }) });
      const j = await r.json();
      if (j.ok) setLeads(j.leads || []);
    } catch(e) { console.error(e); }
    setLeadsLoad(false);
  }, []);

  useEffect(() => {
    if (canSee('overview') || canSee('activity') || canSee('products') || canSee('keywords') || canSee('messages') || canSee('ai')) {
      const p = PERIOD_PRESETS.find(p=>p.id==='30d');
      const range = p.getRange();
      load(false, range.from, range.to);
    } else {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'distribuidores') loadLeads();
  }, [tab]);

  useEffect(() => {
    clearInterval(itvRef.current);
    if (auto) itvRef.current = setInterval(() => load(true, activePeriod?.from, activePeriod?.to), 10000);
    return () => clearInterval(itvRef.current);
  }, [load, auto, activePeriod]);

  const handlePresetSelect = useCallback((preset) => {
    setActivePresetId(preset.id);
    if (preset.id === 'custom') return;
    const range = preset.getRange();
    setActivePeriod(range);
    setCustomFrom(''); setCustomTo('');
    load(false, range?.from, range?.to);
  }, [load]);

  const handleApplyCustom = useCallback(() => {
    if (!customFrom || !customTo) return;
    if (customFrom > customTo) { alert('Fecha inicio debe ser anterior a fecha fin.'); return; }
    setActivePeriod({ from:customFrom, to:customTo });
    load(false, customFrom, customTo);
  }, [customFrom, customTo, load]);

  const reset = async () => {
    if (!isAdmin) return;
    if (!confirm('Â¿Borrar TODAS las estadÃ­sticas? Esta acciÃ³n no se puede deshacer.')) return;
    await fetch('/api/analytics', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'reset'}) });
    load(false, activePeriod?.from, activePeriod?.to);
    setSummary('');
  };

  const doAI = async () => {
    if (!data) return;
    setGenAI(true); setSummary('');
    try {
      const tp   = Object.entries(data.products||{}).sort(([,a],[,b])=>b-a).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ');
      const tk   = Object.entries(data.keywords||{}).sort(([,a],[,b])=>b-a).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ');
      const msgs = (data.lastMessages||[]).slice(-20).map(m=>m.user).join(' | ');
      const pl   = activePeriod?.from ? `${activePeriod.from} -> ${activePeriod.to}` : 'Todo el historial';
      const prompt = `Eres analista de ventas de NEXUS. Analiza datos del chatbot, resumen ejecutivo en espanol (max 180 palabras).\nPeriodo: ${pl}\n\nSesiones:${data.totalSessions}|Mensajes:${data.totalMessages}|WhatsApp:${data.totalWhatsApp}|PDFs:${data.totalPDFs}\nProductos:${tp||'sin datos'}|Keywords:${tk||'sin datos'}\nIntenciones:Compra=${data.intents?.compra||0},Info=${data.intents?.info||0},PDF=${data.intents?.pdf||0},Empleo=${data.intents?.reclutamiento||0}\nConsultas:${msgs.substring(0,400)||'sin datos'}\n\nIncluye:comportamiento general,producto estrella,oportunidades,recomendacion comercial.`;
      const r = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages:[{role:'user',content:prompt}],language:'es',isVoice:false}) });
      const j = await r.json();
      setSummary(j.reply || 'No se pudo generar.');
    } catch { setSummary('Error al generar el resumen.'); }
    setGenAI(false);
  };

  const prodD  = Object.entries(data?.products||{}).map(([label,value])=>({label,value}));
  const kwD    = Object.entries(data?.keywords ||{}).map(([label,value])=>({label,value}));
  const today  = new Date().toISOString().split('T')[0];
  const td     = data?.daily?.[today]||{messages:0,sessions:0,wa:0,pdf:0};
  const yest   = new Date(); yest.setDate(yest.getDate()-1);
  const yd     = data?.daily?.[yest.toISOString().split('T')[0]]||{messages:0,sessions:0,wa:0,pdf:0};

  const periodLabel = (() => {
    if (activePresetId==='all') return 'Todo el historial';
    if (activePresetId==='custom' && activePeriod?.from) return `${activePeriod.from} - ${activePeriod.to}`;
    return PERIOD_PRESETS.find(p=>p.id===activePresetId)?.label || '';
  })();

  const leadsHoy    = leads.filter(l => (l.ts||'').startsWith(today)).length;
  const leadsSemana = leads.filter(l => { const d=new Date(l.ts||0); return (Date.now()-d)<7*24*60*60*1000; }).length;

  const leadsProdCount = {};
  leads.forEach(l => {
    (l.productos||'').split(',').forEach(p => {
      const t = p.trim(); if (t) leadsProdCount[t] = (leadsProdCount[t]||0) + 1;
    });
  });
  const leadsProdData = Object.entries(leadsProdCount).map(([label,value])=>({label,value}));


  const ALL_TABS = [
    { id:'empresas',       label:'ðŸ¢ Empresas' },
    { id:'overview',       label:'Resumen' },
    { id:'activity',       label:'Actividad' },
    { id:'products',       label:'Productos' },
    { id:'keywords',       label:'Busquedas' },
    { id:'messages',       label:'Mensajes' },
    { id:'distribuidores', label:'Distribuidores' },
    { id:'recruitment',    label:'Reclutamiento' },
    { id:'ai',             label:'Analisis IA' },
  ];
  const TABS = ALL_TABS.filter(t => canSee(t.id));

  const CARD = { background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:'20px 22px', marginBottom:10, position:'relative', overflow:'hidden' };
  const SECTION_TITLE = { fontFamily:T.sans, fontWeight:600, fontSize:13, color:C.text, letterSpacing:'-0.01em', marginBottom:16 };

  // â”€â”€ Badge de rol en header â”€â”€
  const roleBadgeColor = role.color || C.orange;

  return (
    <div className="admin-dash admin-panel-root panel-enter" style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:14, width:'95vw', maxWidth:1140, height:'90vh', maxHeight:'90vh', display:'flex', flexDirection:'column', overflowY:'hidden', boxShadow:'0 40px 80px rgba(0,0,0,0.9)', fontFamily:T.sans }}>
      <style>{GLOBAL_CSS}</style>

      {/* â”€â”€ HEADER â”€â”€ */}
      <div style={{ padding:'14px 18px', borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: isAdmin ? 12 : 8 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:36, height:36, borderRadius:8, background:C.surface2, border:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><RobotIcon size={26}/></div>
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2 }}>
                <span style={{ fontFamily:T.sans, fontWeight:600, fontSize:14, color:C.text, letterSpacing:'-0.01em' }}>Panel Admin</span>
                <Tag color={C.orange}>NEXUS</Tag>
                <Tag color={C.textSub}>Analytics</Tag>
                {/* Role badge */}
                <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'2px 9px', borderRadius:4, fontSize:10, fontWeight:600, background:`${roleBadgeColor}18`, color:roleBadgeColor, border:`1px solid ${roleBadgeColor}30`, fontFamily:T.sans, letterSpacing:'0.05em' }}>
                  <span style={{ width:5, height:5, borderRadius:'50%', background:roleBadgeColor, display:'inline-block' }}/>
                  {role.name}
                </span>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                {isAdmin && <><Dot active={auto}/><span style={{ color:C.textDim, fontSize:10, fontFamily:T.sans }}>{auto?'Live - cada 10s':'Pausado'}{last&&` - ${last.toLocaleTimeString('es-MX')}`}</span></>}
                {periodLabel && isAdmin && <span style={{ padding:'1px 7px', borderRadius:4, background:'rgba(255,255,255,0.05)', border:`1px solid ${C.border}`, color:C.textSub, fontSize:10, fontFamily:T.sans }}>{periodLabel}</span>}
              </div>
            </div>
          </div>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            {isAdmin && [
              { label:auto?'Pausar':'Live', onClick:()=>setAuto(p=>!p), style:{ background:auto?C.greenDim:'rgba(255,255,255,0.04)', border:`1px solid ${auto?C.green+'30':C.border}`, color:auto?C.green:C.textSub } },
              { label:'Sync', onClick:()=>load(false,activePeriod?.from,activePeriod?.to), style:{ background:'rgba(255,255,255,0.04)', border:`1px solid ${C.border}`, color:C.textSub } },
              { label:'Reset', onClick:reset, style:{ background:C.redDim, border:`1px solid ${C.red}25`, color:C.red } },
            ].map(b => (
              <button key={b.label} onClick={b.onClick} className="btn-base" style={{ padding:'6px 12px', borderRadius:7, fontSize:11, fontWeight:500, cursor:'pointer', fontFamily:T.sans, letterSpacing:'0.01em', ...b.style }}>{b.label}</button>
            ))}
            {/* Descarga de reporte solo para ADMIN */}
            {isAdmin && <DownloadReportButton data={data} periodMeta={{ preset:activePresetId, from:activePeriod?.from, to:activePeriod?.to }}/>}
            <button onClick={onClose} style={{ padding:'6px 10px', borderRadius:7, border:`1px solid ${C.border}`, background:'transparent', color:C.textDim, cursor:'pointer', fontSize:13, transition:'color 0.15s', fontFamily:T.sans }}>x</button>
          </div>
        </div>
        {/* Period selector solo para admin */}
        {isAdmin && (
          <div style={{ display:'flex', alignItems:'center', padding:'7px 10px', background:C.surface2, borderRadius:8, border:`1px solid ${C.border}` }}>
            <PeriodSelector activeId={activePresetId} onSelect={handlePresetSelect} customFrom={customFrom} customTo={customTo} setCustomFrom={setCustomFrom} setCustomTo={setCustomTo} onApplyCustom={handleApplyCustom}/>
          </div>
        )}
      </div>

      {/* â”€â”€ TABS â”€â”€ */}
      <div style={{ padding:'0 18px', borderBottom:`1px solid ${C.border}`, display:'flex', gap:2, overflowX:'auto', background:C.surface, flexShrink:0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} className={`tab-btn ${tab===t.id?'active':''}`}
            style={{ background:'transparent', color:tab===t.id?C.text:C.textDim, border:'none', padding:'10px 14px', cursor:'pointer', fontSize:12, fontWeight:tab===t.id?500:400, fontFamily:T.sans, whiteSpace:'nowrap' }}>
            {t.label}
            {t.id==='distribuidores' && leads.length>0 && (
              <span style={{ marginLeft:5, background:C.orange+'20', color:C.orange, borderRadius:10, padding:'1px 6px', fontSize:9, fontFamily:T.mono }}>{leads.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* â”€â”€ CONTENT â”€â”€ */}
      <div style={{ flex:1, overflowY:'auto', padding:'18px 18px 32px', background:C.bg }}>
        {loading && tab !== 'distribuidores' && tab !== 'recruitment' && <Spinner/>}

        {/* OVERVIEW */}
        {!loading && data && tab==='overview' && canSee('overview') && (
          <div className="tab-content" key="ov">
            <SectionLabel>Acumulado - {periodLabel}</SectionLabel>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:8, marginBottom:16 }}>
              <StatCard label="Sesiones"  value={data.totalSessions} sub="conversaciones"      color={C.orange} icon="ðŸ’¬"/>
              <StatCard label="Mensajes"  value={data.totalMessages} sub="preguntas recibidas"  color={C.blue}   icon="ðŸ“©"/>
              <StatCard label="WhatsApp"  value={data.totalWhatsApp} sub="leads generados"      color={C.green}  icon="ðŸ›’"/>
              <StatCard label="PDFs"      value={data.totalPDFs}     sub="catÃ¡logos enviados"   color={C.amber}  icon="ðŸ“„"/>
            </div>
            <div style={{ height:1, background:C.border, margin:'16px 0' }}/>
            <SectionLabel>Hoy - {new Date().toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'})}</SectionLabel>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:8, marginBottom:16 }}>
              <StatCard label="Mensajes hoy" value={td.messages} sub={`ayer: ${yd.messages}`} color={C.orange} icon="ðŸ“†" trend={td.messages-yd.messages}/>
              <StatCard label="Sesiones hoy" value={td.sessions} sub={`ayer: ${yd.sessions}`} color={C.purple} icon="ðŸ‘¤" trend={td.sessions-yd.sessions}/>
              <StatCard label="WhatsApp hoy" value={td.wa||0}    sub={`ayer: ${yd.wa||0}`}    color={C.green}  icon="ðŸ“²" trend={(td.wa||0)-(yd.wa||0)}/>
              <StatCard label="PDFs hoy"     value={td.pdf||0}   sub={`ayer: ${yd.pdf||0}`}   color={C.amber}  icon="ðŸ“‹" trend={(td.pdf||0)-(yd.pdf||0)}/>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="card-hover" style={CARD}><p style={SECTION_TITLE}>DistribuciÃ³n de intenciones</p><DonutChart intents={data.intents}/></div>
              <div className="card-hover" style={CARD}><p style={SECTION_TITLE}>Actividad - ultimos 14 dias</p><LineChart daily={data.daily}/></div>
            </div>
          </div>
        )}

        {/* ACTIVITY */}
        {!loading && data && tab==='activity' && canSee('activity') && (
          <div className="tab-content" key="ac">
            <div className="card-hover" style={CARD}>
              <p style={SECTION_TITLE}>Historial diario</p>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead><tr>{['Fecha','Sesiones','Mensajes','WhatsApp','PDFs','Conv.%'].map(h=>(
                    <th key={h} style={{ color:C.textDim, fontWeight:500, padding:'8px 12px', textAlign:'left', borderBottom:`1px solid ${C.border}`, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', fontFamily:T.sans, background:C.surface2 }}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {Object.entries(data.daily||{}).sort(([a],[b])=>b.localeCompare(a)).map(([date,v])=>{
                      const conv=v.messages?Math.round(((v.wa||0)/v.messages)*100):0, isToday=date===today;
                      return (
                        <tr key={date} className="row-hover" style={{ background:isToday?'rgba(122,37,50,0.05)':'transparent', borderBottom:`1px solid ${C.border2}` }}>
                          <td style={{ padding:'9px 12px', color:C.text, fontFamily:T.mono, fontSize:11 }}>{isToday&&<Tag color={C.orange}>hoy</Tag>} {date}</td>
                          <td style={{ padding:'9px 12px', color:C.textSub, fontFamily:T.mono }}>{v.sessions||0}</td>
                          <td style={{ padding:'9px 12px', color:C.text, fontFamily:T.mono, fontWeight:500 }}>{v.messages||0}</td>
                          <td style={{ padding:'9px 12px' }}><span style={{ color:C.green, fontFamily:T.mono }}>{v.wa||0}</span></td>
                          <td style={{ padding:'9px 12px' }}><span style={{ color:C.amber, fontFamily:T.mono }}>{v.pdf||0}</span></td>
                          <td style={{ padding:'9px 12px' }}><span style={{ padding:'2px 6px', borderRadius:4, background:conv>10?C.greenDim:conv>0?C.amberDim:'transparent', color:conv>10?C.green:conv>0?C.amber:C.textDim, fontSize:10, fontFamily:T.mono, fontWeight:500 }}>{conv}%</span></td>
                        </tr>
                      );
                    })}
                    {!Object.keys(data.daily||{}).length&&<tr><td colSpan={6} style={{ color:C.textDim, textAlign:'center', padding:40, fontFamily:T.sans, fontSize:11 }}>Sin datos</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card-hover" style={CARD}>
              <p style={SECTION_TITLE}>Mensajes por hora del dÃ­a</p>
              <BarChart data={(data.hourly||Array(24).fill(0)).map((v,i)=>({label:`${String(i).padStart(2,'0')}:00`,value:v}))} color={C.blue} max={24}/>
            </div>
          </div>
        )}

        {/* PRODUCTS */}
        {!loading && data && tab==='products' && canSee('products') && (
          <div className="tab-content" key="pr">
            <div className="card-hover" style={CARD}>
              <p style={SECTION_TITLE}>Productos mÃ¡s consultados</p>
              <BarChart data={prodD} color={C.orange} max={10}/>
              {prodD.length>0&&(()=>{
                const top=[...prodD].sort((a,b)=>b.value-a.value)[0];
                return <div style={{ marginTop:20, padding:'14px 16px', background:C.surface2, borderRadius:8, border:`1px solid ${C.border}`, borderLeft:`2px solid ${C.orange}`, display:'flex', alignItems:'center', gap:12 }}><div><span style={{ color:C.textDim, fontSize:10, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.07em', fontFamily:T.sans }}>Producto estrella</span><p style={{ margin:'4px 0 0', fontFamily:T.sans, fontWeight:600, fontSize:16, color:C.text }}>{top?.label}<span style={{ color:C.orange, marginLeft:8, fontFamily:T.mono, fontWeight:400, fontSize:13 }}>x{top?.value}</span></p></div></div>;
              })()}
            </div>
          </div>
        )}

        {/* KEYWORDS */}
        {!loading && data && tab==='keywords' && canSee('keywords') && (
          <div className="tab-content" key="kw" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div className="card-hover" style={CARD}><p style={SECTION_TITLE}>Palabras clave</p><BarChart data={kwD} color={C.blue} max={12}/></div>
            <div className="card-hover" style={CARD}><p style={SECTION_TITLE}>Productos mencionados</p><BarChart data={prodD} color={C.purple} max={8}/></div>
          </div>
        )}

        {/* MESSAGES */}
        {!loading && data && tab==='messages' && canSee('messages') && (
          <div className="tab-content" key="ms">
            <div className="card-hover" style={CARD}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <p style={{ ...SECTION_TITLE, marginBottom:0 }}>Consultas en tiempo real</p>
                <Tag color={C.green}>{data.lastMessages?.length||0} registros</Tag>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {(data.lastMessages||[]).slice().reverse().map((m,i)=>{
                  const iC={compra:C.green,pdf:C.blue,reclutamiento:C.purple}, color=iC[m.intent]||'rgba(255,255,255,0.15)';
                  return (
                    <div key={i} className="row-hover" style={{ padding:'9px 12px', background:C.surface2, borderRadius:7, border:`1px solid ${C.border}`, display:'flex', gap:10, alignItems:'center' }}>
                      <div style={{ width:2, height:28, borderRadius:1, background:color, flexShrink:0 }}/>
                      <div style={{ flexShrink:0, minWidth:52 }}>
                        <div style={{ color:C.textSub, fontSize:10, fontFamily:T.mono }}>{m.ts?new Date(m.ts).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}):'-'}</div>
                        <div style={{ color:C.textDim, fontSize:9, fontFamily:T.mono }}>{m.ts?new Date(m.ts).toLocaleDateString('es-MX',{day:'2-digit',month:'short'}):''}</div>
                      </div>
                      <span style={{ color:C.text, fontSize:12, flex:1, lineHeight:1.5, fontFamily:T.sans }}>{m.user}</span>
                      {m.prod&&<Tag color={C.amber}>{m.prod}</Tag>}
                      <Tag color={color}>{m.intent||'otro'}</Tag>
                    </div>
                  );
                })}
                {!(data.lastMessages||[]).length&&<div style={{ textAlign:'center', padding:'44px 0', color:C.textDim, fontFamily:T.sans, fontSize:12 }}>Sin mensajes registrados</div>}
              </div>
            </div>
          </div>
        )}

        {/* â”€â”€ DISTRIBUIDORES â”€â”€ */}
        {tab==='distribuidores' && canSee('distribuidores') && (
          <div className="tab-content" key="dist">
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:8, marginBottom:16 }}>
              <StatCard label="Total solicitudes" value={leads.length}   sub="acumulado"       color={C.orange} icon="ðŸ¤"/>
              <StatCard label="Esta semana"        value={leadsSemana}   sub="ultimos 7 dias"  color={C.blue}   icon="Sem"/>
              <StatCard label="Hoy"                value={leadsHoy}      sub="nuevas hoy"      color={C.green}  icon="âš¡"/>
            </div>
            {leads.length >= 2 && (
              <div className="card-hover" style={{ ...CARD, marginBottom:10 }}>
                <p style={SECTION_TITLE}>Tendencia de solicitudes - ultimos 14 dias</p>
                <LeadsLineChart leads={leads}/>
              </div>
            )}
            {leadsProdData.length > 0 && (
              <div className="card-hover" style={{ ...CARD, marginBottom:10 }}>
                <p style={SECTION_TITLE}>Productos de interÃ©s</p>
                <BarChart data={leadsProdData} color={C.orange} max={8}/>
              </div>
            )}
            <div className="card-hover" style={CARD}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <p style={{ ...SECTION_TITLE, marginBottom:0 }}>Registro de solicitudes</p>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <Tag color={C.orange}>{leads.length} registros</Tag>
                  <button onClick={loadLeads} className="btn-base" style={{ padding:'5px 12px', borderRadius:7, fontSize:11, fontWeight:500, background:'rgba(255,255,255,0.04)', border:`1px solid ${C.border}`, color:C.textSub, cursor:'pointer', fontFamily:T.sans }}>â†» Sync</button>
                  {/* Reset de leads solo para admin */}
                  {isAdmin && (
                    <button onClick={async()=>{
                      if(!confirm('Â¿Borrar todos los leads? Esta acciÃ³n no se puede deshacer.'))return;
                      await fetch('/api/analytics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resetLeads'})});
                      setLeads([]);
                    }} className="btn-base" style={{ padding:'5px 12px', borderRadius:7, fontSize:11, fontWeight:500, background:C.redDim, border:`1px solid ${C.red}25`, color:C.red, cursor:'pointer', fontFamily:T.sans }}>Borrar todo</button>
                  )}
                </div>
              </div>
              <input
                type="text"
                placeholder="Buscar por nombre, empresa, WhatsApp o email..."
                value={leadSearch}
                onChange={e=>setLeadSearch(e.target.value)}
                style={{ width:'100%', marginBottom:14, background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:'9px 14px', color:C.text, fontSize:12, outline:'none', fontFamily:T.sans, transition:'border-color 0.15s' }}
                onFocus={e=>e.target.style.borderColor='rgba(255,255,255,0.2)'}
                onBlur={e=>e.target.style.borderColor=C.border}
              />
              {leadsLoad ? <Spinner/> : (
                <div style={{ overflowX:'auto' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <thead>
                      <tr>
                        {['Fecha','Nombre','Empresa','WhatsApp','Email','Productos'].map(h=>(
                          <th key={h} style={{ color:C.textDim, fontWeight:500, padding:'8px 12px', textAlign:'left', borderBottom:`1px solid ${C.border}`, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', fontFamily:T.sans, background:C.surface2, whiteSpace:'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {leads
                        .filter(l => {
                          const q = leadSearch.toLowerCase();
                          return !q ||
                            (l.nombre   ||'').toLowerCase().includes(q) ||
                            (l.empresa  ||'').toLowerCase().includes(q) ||
                            (l.email    ||'').toLowerCase().includes(q) ||
                            (l.whatsapp ||'').includes(q);
                        })
                        .map((l,i) => (
                          <tr key={i} className="row-hover" style={{ borderBottom:`1px solid ${C.border2}` }}>
                            <td style={{ padding:'9px 12px', color:C.textDim, fontFamily:T.mono, fontSize:10, whiteSpace:'nowrap' }}>
                              {l.ts ? new Date(l.ts).toLocaleString('es-MX',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '-'}
                            </td>
                            <td style={{ padding:'9px 12px', color:C.text, fontFamily:T.sans, fontWeight:500 }}>{l.nombre}</td>
                            <td style={{ padding:'9px 12px', color:C.textSub, fontFamily:T.sans }}>{l.empresa}</td>
                            <td style={{ padding:'9px 12px' }}>
                              <a href={`https://wa.me/52${(l.whatsapp||'').replace(/\D/g,'')}`} target="_blank"
                                style={{ color:C.green, fontFamily:T.mono, fontSize:11, textDecoration:'none', display:'flex', alignItems:'center', gap:4 }}>
                                ðŸ“² {l.whatsapp}
                              </a>
                            </td>
                            <td style={{ padding:'9px 12px', color:C.blue, fontFamily:T.mono, fontSize:11 }}>{l.email}</td>
                            <td style={{ padding:'9px 12px' }}>
                              {(l.productos||'').split(',').filter(Boolean).map((p,j)=>(
                                <Tag key={j} color={C.orange}>{p.trim()}</Tag>
                              ))}
                              {!(l.productos||'').trim() && <span style={{ color:C.textDim, fontSize:10 }}>-</span>}
                            </td>
                          </tr>
                        ))
                      }
                      {!leads.length && !leadsLoad && (
                        <tr><td colSpan={6} style={{ color:C.textDim, textAlign:'center', padding:40, fontFamily:T.sans, fontSize:12 }}>Sin solicitudes registradas aun</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* EMPRESAS - solo SuperAdmin */}
        {tab==='empresas' && canSee('empresas') && (
          <div key="emp"><EmpresasTab/></div>
        )}

        {/* RECRUITMENT */}
        {tab==='recruitment' && canSee('recruitment') && (
          <div className="tab-content" key="rc"><RecruitmentTab/></div>
        )}

        {/* AI */}
        {!loading && data && tab==='ai' && canSee('ai') && (
          <div className="tab-content" key="ai">
            <div className="card-hover" style={CARD}>
              <p style={SECTION_TITLE}>Analisis Inteligente - NEXUS</p>
              <p style={{ color:C.textDim, fontSize:12, marginBottom:18, lineHeight:1.7, fontFamily:T.sans, maxWidth:520 }}>Genera un resumen ejecutivo basado en los datos del chatbot: patrones de comportamiento, productos destacados y recomendaciones comerciales.</p>
              <button onClick={doAI} disabled={genAI} className="btn-base" style={{ background:genAI?'rgba(255,255,255,0.04)':'rgba(255,255,255,0.9)', color:genAI?C.textDim:'#0a0a0a', border:'none', borderRadius:8, padding:'10px 20px', fontFamily:T.sans, fontSize:12, fontWeight:600, cursor:genAI?'not-allowed':'pointer', display:'flex', alignItems:'center', gap:8, transition:'all 0.15s ease' }}>
                {genAI?<><div style={{ width:12, height:12, borderRadius:'50%', border:'1.5px solid rgba(0,0,0,0.2)', borderTop:'1.5px solid rgba(0,0,0,0.6)', animation:'spin 0.7s linear infinite' }}/>Analizando...</>:<>Generar analisis</>}
              </button>
              {summary && (
                <div style={{ marginTop:16, padding:'16px 18px', background:C.surface2, border:`1px solid ${C.border}`, borderLeft:`2px solid ${C.blue}`, borderRadius:8 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                    <Dot active color={C.blue}/>
                    <span style={{ color:C.textDim, fontSize:10, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.07em', fontFamily:T.sans }}>Resumen ejecutivo - {periodLabel}</span>
                  </div>
                  <p style={{ color:C.text, fontSize:13, lineHeight:1.75, whiteSpace:'pre-wrap', fontFamily:T.sans }}>{summary}</p>
                </div>
              )}
              <div style={{ height:1, background:C.border, margin:'20px 0' }}/>
              <p style={{ ...SECTION_TITLE, marginBottom:10 }}>Ãšltimas 20 consultas</p>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {(data.lastMessages||[]).slice(-20).reverse().map((m,i)=>{
                  const iC={compra:C.green,pdf:C.blue}, color=iC[m.intent]||'rgba(255,255,255,0.15)';
                  return (
                    <div key={i} style={{ padding:'8px 12px', background:C.surface2, borderRadius:6, border:`1px solid ${C.border}`, display:'flex', gap:10, alignItems:'center' }}>
                      <span style={{ color:C.textDim, fontSize:9, flexShrink:0, fontFamily:T.mono }}>{m.ts?new Date(m.ts).toLocaleDateString('es-MX',{day:'2-digit',month:'short'}):'-'}</span>
                      <span style={{ color:C.text, fontSize:12, flex:1, fontFamily:T.sans }}>{m.user}</span>
                      <Tag color={color}>{m.intent||'otro'}</Tag>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// â”€â”€ Root Export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function AdminPanel() {
  const [visible, setVisible] = useState(false);
  const [role,    setRole]    = useState(null);

  useEffect(() => {
    const fn = (e) => {
      if ((e.ctrlKey||e.metaKey) && e.key==='9') { e.preventDefault(); setVisible(p=>!p); }
      if (e.key==='Escape') { setVisible(false); setRole(null); }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  const handleLogin = (pw, resolvedRole) => {
    setRole(resolvedRole);
  };

  return (
    <div className="admin-panel-root">
      <style>{GLOBAL_CSS}</style>
      {visible && (
        <div className="admin-overlay visible" onClick={e=>{ if(e.target===e.currentTarget){setVisible(false);setRole(null);} }}>
          {!role
            ? <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, width:'96vw', maxWidth:400, boxShadow:'0 40px 80px rgba(0,0,0,0.9)', position:'relative', overflow:'hidden' }}>
                <Login onLogin={handleLogin}/>
              </div>
            : <Dash onClose={()=>{setVisible(false);setRole(null);}} role={role}/>
          }
        </div>
      )}
    </div>
  );
}


