import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import './NEXUS.css';

console.log('🚀 NEXUS v4 (Astro Ready) CARGADO'); 

const RobotIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 100 100" fill="none">
    <defs>
      <linearGradient id="headGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#F24F13"/><stop offset="100%" stopColor="#F24F13"/>
      </linearGradient>
    </defs>
    <line x1="20" y1="35" x2="15" y2="20" stroke="#F24F13" strokeWidth="4" strokeLinecap="round"/>
    <circle cx="15" cy="20" r="4" fill="#F24F13"/>
    <line x1="80" y1="35" x2="85" y2="20" stroke="#F24F13" strokeWidth="4" strokeLinecap="round"/>
    <circle cx="85" cy="20" r="4" fill="#F24F13"/>
    <circle cx="50" cy="55" r="40" fill="url(#headGrad)"/>
    <ellipse cx="50" cy="58" rx="32" ry="30" fill="#FFF5E6"/>
    <rect x="25" y="45" width="50" height="22" rx="10" fill="#F24F13"/>
    <circle cx="38" cy="56" r="5" fill="#FFD700"/>
    <circle cx="62" cy="56" r="5" fill="#FFD700"/>
    <ellipse cx="50" cy="78" rx="6" ry="2" fill="#D35400" opacity="0.8"/>
  </svg>
);
const SendIcon = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>);
const MicIcon = ({ isListening, size = 24 }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill={isListening?"currentColor":"none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isListening?"pulse-animation":""}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>);
const BackArrowIcon = () => (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>);
const KeyboardIcon = () => (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="6" y1="16" x2="11" y2="16"/><line x1="15" y1="16" x2="18" y2="16"/></svg>);
const CloseIcon = ({ size = 24 }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>);
const WhatsAppIcon = () => (<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.008-.57-.008-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>);
const PdfIcon = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>);

const PDF_MAP = {
  rafia:      { label: 'Catálogo Rafia',            url: 'https://drive.google.com/file/d/1uAiR4uxO2iX_LsNFul6kXeb7jnnCEV_J/view' },
  stretch:    { label: 'Catálogo Stretch Film',     url: 'https://drive.google.com/file/d/1HYGcpgkRO_7OX22IcWvRpzpLZKgpYV3A/view' },
  cuerda:     { label: 'Catálogo Cuerdas',          url: 'https://drive.google.com/file/d/14GrV9P1ViQKvFp3BucYjgmryRgWKLEZh/view' },
  cuerdas:    { label: 'Catálogo Cuerdas',          url: 'https://drive.google.com/file/d/14GrV9P1ViQKvFp3BucYjgmryRgWKLEZh/view' },
  saco:       { label: 'Catálogo Sacos',            url: 'https://drive.google.com/file/d/16S43-PUrQECO9q2J1fOgbN-YeIxQ2GhP/view' },
  sacos:      { label: 'Catálogo Sacos',            url: 'https://drive.google.com/file/d/16S43-PUrQECO9q2J1fOgbN-YeIxQ2GhP/view' },
  arpilla:    { label: 'Catálogo Arpillas',         url: 'https://drive.google.com/file/d/1OQKGpnRCfA2yFdAlT6q7GczYua2FFFVU/view' },
  arpillas:   { label: 'Catálogo Arpillas',         url: 'https://drive.google.com/file/d/1OQKGpnRCfA2yFdAlT6q7GczYua2FFFVU/view' },
  malla:      { label: 'Catálogo Arpillas',         url: 'https://drive.google.com/file/d/1OQKGpnRCfA2yFdAlT6q7GczYua2FFFVU/view' },
  esquinero:  { label: 'Catálogo Esquineros',       url: 'https://drive.google.com/file/d/181Hvr0HQffLU3rmcXkccYoqj-Y_A-gxr/view' },
  esquineros: { label: 'Catálogo Esquineros',       url: 'https://drive.google.com/file/d/181Hvr0HQffLU3rmcXkccYoqj-Y_A-gxr/view' },
  flexible:   { label: 'Catálogo Empaque Flexible', url: 'https://drive.google.com/file/d/1TGxUcGHjW1NHF8K8YkRisbRE8uAuTnPO/view' },
  empaque:    { label: 'Catálogo Empaque Flexible', url: 'https://drive.google.com/file/d/1TGxUcGHjW1NHF8K8YkRisbRE8uAuTnPO/view' },
  general:    { label: 'Catálogo General',          url: 'https://drive.google.com/file/d/1348E3b37R1KmpggjAURhsuQMfARyBaXB/view' },
};

function detectarProducto(texto) {
  if (!texto) return null;
  const lower = texto.toLowerCase();
  const lista = ['stretch film','pelicula stretch','película stretch','stretch','empaque flexible','empaque','esquineros','esquinero','cuerdas','cuerda','arpillas','arpilla','malla','sacos','saco','rafia','flexible'];
  for (const p of lista) { if (lower.includes(p)) return p; }
  return null;
}

function esIntencionCompra(texto) {
  if (!texto) return false;
  const u = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const regexTolerantes = [
    /comp[a-z]{0,4}r/,/coti[a-z]{0,6}/,/preci[a-z]{0,3}/,/cuant[a-z]{0,2}/,
    /cost[a-z]{0,3}/,/presup[a-z]{0,6}/,/adquir[a-z]{0,4}/,/dispon[a-z]{0,8}/,
    /pedid[a-z]{0,2}/,/orden[a-z]{0,2}/,
  ];
  if (regexTolerantes.some(r => r.test(u))) return true;
  const frases = ['me interesa','me gustaria','quisiera','estoy interesad','hay stock','tienen stock','hay disponible','como compro','donde compro','voy a comprar','contactar','whatsapp','llamar'];
  if (frases.some(k => u.includes(k))) return true;
  const tieneProducto = detectarProducto(texto) !== null;
  if ((u.includes('quiero') || u.includes('necesito')) && tieneProducto) return true;
  return false;
}

function esSolicitudPDF(texto) {
  if (!texto) return false;
  const u = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return ['pdf','ficha tecnica','ficha del producto','descargar','descarga','brochure','folleto','informacion del producto','mas informacion','especificaciones','hoja tecnica'].some(k => u.includes(k));
}

const MessageRenderer = ({ content, isAssistant }) => {
  if (!isAssistant) return <span>{content}</span>;
  const clean = content.replace(/\[ACCION:[^\]]+\]/gi,'').replace(/👉\s*https?:\/\/\S+/g,'').replace(/https?:\/\/\S+/g,'').replace(/\n{3,}/g,'\n\n').trim();
  return (
    <ReactMarkdown components={{
      p:({children})=><p className="msg-p">{children}</p>,
      strong:({children})=><strong className="msg-strong">{children}</strong>,
      ul:({children})=><ul className="msg-ul">{children}</ul>,
      ol:({children})=><ol className="msg-ol">{children}</ol>,
      li:({children})=><li className="msg-li">{children}</li>,
      a:({children})=><span className="msg-link-stripped">{children}</span>,
    }}>{clean}</ReactMarkdown>
  );
};

// ── BOTONES DE ACCIÓN ──
// ── BOTONES DE ACCIÓN (LIMPIOS Y NATURALES) ──
const MessageActions = ({ waLink, pdfData }) => {
  if (!waLink && !pdfData) return null;

  return (
    <div className="msg-actions" style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
      
      {waLink && (
        <a href={waLink} target="_blank" rel="noopener noreferrer" className="msg-action-btn msg-action-wa"
          style={{ backgroundColor: '#25D366', color: '#ffffff', padding: '12px 20px', borderRadius: '24px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', fontSize: '14px', width: 'fit-content' }}>
          <WhatsAppIcon /> <span>Contactar por WhatsApp</span>
        </a>
      )}

      {pdfData && (
        <a href={pdfData.url} target="_blank" rel="noopener noreferrer" className="msg-action-btn msg-action-pdf"
          style={{ backgroundColor: '#fff7f4', color: '#F24F13', border: '2px solid #F24F13', padding: '12px 20px', borderRadius: '24px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', fontSize: '14px', width: 'fit-content' }}>
          <PdfIcon /> <span>{pdfData.label}</span>
        </a>
      )}
      
    </div>
  );
};

export default function NEXUS({ language = 'es' }) {
  const t = {
    greeting: '¡Hola! Soy NEXUS 🤖. ¿en qué puedo ayudarte hoy?',
    placeholder: 'Escribe un mensaje...',
    listeningState: 'Escuchando...',
    thinking: 'Pensando...',
    errorMsg: 'Error de conexión.',
    salesBtn: 'Cotizar por WhatsApp',
    voiceAssistantTitle: 'Asistente Virtual',
    voiceCode: 'es-MX',
    waStart: 'Hola NEXUS, me gustaría una cotización',
    pdfBtn: 'Ver PDF',
  };
  const isRTL = false;

  // Inicialización limpia, sin links forzados que se borren.
  const [messages, setMessages] = useState([{ 
    role: 'assistant', 
    content: t.greeting, 
    waLink: null, 
    pdfData: null 
  }]);
  
  const [input,       setInput]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [isOpen,      setIsOpen]      = useState(false);
  const [viewMode,    setViewMode]    = useState('voice');
  const [isListening, setIsListening] = useState(false);
  const [lastVoiceResponse, setLastVoiceResponse] = useState(t.greeting);
  const [isBotSpeaking,     setIsBotSpeaking]     = useState(false);

const chatWindowRef        = useRef(null);
  const inputRef             = useRef(null);
  const messagesContainerRef = useRef(null);
  const voiceTextRef         = useRef('');
  const productoCtxRef       = useRef(null);
  const audioRef             = useRef(null);
  const messagesEndRef       = useRef(null); // 👈 1. AGREGAMOS ESTA NUEVA REFERENCIA

  // 👈 2. REEMPLAZA TU useEffect DEL SCROLL POR ESTE:
  useEffect(() => {
    if (viewMode === 'chat' && messagesEndRef.current) {
      // Le damos 150ms para asegurar que el botón ya se dibujó antes de bajar
      setTimeout(() => { 
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' }); 
      }, 150);
    }
  }, [messages, loading, viewMode]);

  useEffect(() => {
    if (isOpen && viewMode === 'chat' && window.innerWidth > 768) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen, viewMode]);

  useEffect(() => {
    const onKey = (e) => { if (e.key.toLowerCase()==='f') { const tag=e.target.tagName; if (tag!=='INPUT'&&tag!=='TEXTAREA'&&!e.target.isContentEditable) { e.preventDefault(); setIsOpen(true); } } };
    const onEsc = (e) => { if (e.key==='Escape') handleCloseChat(); };
    const onOutside = (e) => { if (isOpen&&chatWindowRef.current&&!chatWindowRef.current.contains(e.target)) { const btn=document.querySelector('.NEXUS-button'); if (btn&&btn.contains(e.target)) return; handleCloseChat(); } };
    window.addEventListener('keydown', onKey);
    if (isOpen) { document.addEventListener('mousedown', onOutside); document.addEventListener('keydown', onEsc); }
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onOutside); document.removeEventListener('keydown', onEsc); };
  }, [isOpen]);

  const handleCloseChat = () => { setIsOpen(false); setViewMode('voice'); inputRef.current?.blur(); window.focus(); };

  const toggleListening = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current=null; setIsBotSpeaking(false); }
    if (isListening) { setIsListening(false); return; }
    
    // Verificación segura para SSR en Astro
    if (typeof window === 'undefined') return;
    
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Tu navegador no soporta reconocimiento de voz.'); return; }
    const rec = new SR();
    rec.lang = t?.voiceCode || 'es-ES';
    rec.continuous = false; rec.interimResults = true;
    rec.onstart  = () => { setIsListening(true); voiceTextRef.current=''; };
    rec.onresult = (e) => { const txt=Array.from(e.results).map(r=>r[0].transcript).join(''); setInput(txt); voiceTextRef.current=txt; };
    rec.onerror  = () => setIsListening(false);
    rec.onend    = () => { setIsListening(false); if (voiceTextRef.current.trim()) setTimeout(()=>sendMessage(null,voiceTextRef.current,true),600); };
    try { rec.start(); } catch(err) { console.error(err); }
  };

  const playAudio = async (b64) => {
    if (!b64) return;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current=null; }
    const a = new Audio(b64);
    audioRef.current = a;
    a.onplay  = () => setIsBotSpeaking(true);
    a.onended = () => setIsBotSpeaking(false);
    a.onpause = () => setIsBotSpeaking(false);
    try { await a.play(); } catch(err) { setIsBotSpeaking(false); }
  };

  const sendMessage = async (e=null, textOverride=null, isVoice=false) => {
    if (e) e.preventDefault();
    const text = (textOverride ?? input).trim();
    if (!text) return;

    if (audioRef.current) { audioRef.current.pause(); setIsBotSpeaking(false); }
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();

    const userMsg = { role:'user', content:text, waLink:null, pdfData:null };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const prodUser   = detectarProducto(text);
    if (prodUser) productoCtxRef.current = prodUser;
    const compraNow  = esIntencionCompra(text);
    const pdfNow     = esSolicitudPDF(text);

    try {
      const res  = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ messages:[...messages, userMsg], isVoice, language:currentLangCode }),
      });
      const data = await res.json();

      const replyText = data.reply    || '';
      const audioUrl  = data.audio    || null;
      const accionWA  = data.accionWA || false;
      const accionPDF = data.accionPDF || null;

      const prodReply = detectarProducto(replyText);
      if (prodReply && !prodUser) productoCtxRef.current = prodReply;
      const prodFinal = productoCtxRef.current || 'sus productos';

      const mostrarWA  = compraNow || accionWA === true;
      const mostrarPDF = pdfNow    || accionPDF != null;

      let waLink  = null;
      let pdfData = null;

      if (mostrarWA) {
        waLink = `https://wa.me/524432072593?text=${encodeURIComponent('Hola NEXUS, me interesa cotizar ' + prodFinal)}`;
      }
      if (mostrarPDF) {
        const clave = accionPDF || prodUser || prodReply || productoCtxRef.current || 'general';
        pdfData = PDF_MAP[clave] || PDF_MAP['general'];
      }

      setMessages(prev => [...prev, { role:'assistant', content:replyText, waLink, pdfData }]);
      setLastVoiceResponse(replyText);
      if (isVoice && audioUrl) await playAudio(audioUrl);

    } catch(err) {
      console.error('❌', err);
      setMessages(prev => [...prev, { role:'assistant', content:t.errorMsg||'Error de conexión.', waLink:null, pdfData:null }]);
    } finally {
      setLoading(false);
      if (viewMode==='chat' && typeof window !== 'undefined' && window.innerWidth>768) setTimeout(()=>inputRef.current?.focus(), 50);
    }
  };

  return (
    <div className={`NEXUS-container ${isOpen?'open':''}`} style={{ fontFamily: isRTL?'Tahoma, Arial, sans-serif':'inherit' }}>
      <div ref={chatWindowRef} className={`NEXUS-window ${isOpen?'show':''}`}>

        {viewMode === 'voice' && (
          <div className="NEXUS-voice-interface">
            <div className="voice-header">
              <span>{t.voiceAssistantTitle||'Asistente Virtual'}</span>
              <button className="voice-close-btn" onClick={handleCloseChat}><CloseIcon /></button>
            </div>
            <div className="voice-content">
              <div className={`voice-orb-container ${loading?'thinking':isBotSpeaking?'speaking':isListening?'listening':'idle'}`}>
                <div className="voice-orb-core"/><div className="voice-orb-ring ring-1"/><div className="voice-orb-ring ring-2"/>
              </div>
              <div className="voice-text-display">
                {isListening ? (
                  <p className="user-listening-text">{input||t.listeningState||'Escuchando...'}</p>
                ) : loading ? (
                  <p className="assistant-thinking-text">{t.thinking||'Pensando...'}</p>
                ) : (
                  <div className="assistant-speech-text">
                    <ReactMarkdown>{lastVoiceResponse.replace(/\[ACCION:[^\]]+\]/gi,'').replace(/https?:\/\/\S+/g,'').split(/\n+/).filter(Boolean).slice(0,2).join('\n\n')}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
            <div className="voice-controls">
              <button className="voice-control-btn secondary" onClick={()=>setViewMode('chat')}><KeyboardIcon /></button>
              <button className={`voice-control-btn primary-mic ${isListening?'active':''}`} onClick={toggleListening}><MicIcon isListening={isListening} size={32}/></button>
              <button className="voice-control-btn secondary" onClick={handleCloseChat}><CloseIcon /></button>
            </div>
          </div>
        )}

        {viewMode === 'chat' && (
          <div className="NEXUS-chat-interface">
            <div className="NEXUS-header-clean" style={{ flexDirection: isRTL?'row-reverse':'row' }}>
              <button onClick={()=>setViewMode('voice')} className="header-back-btn"><BackArrowIcon /></button>
              <div className="header-title"><h2>NEXUS</h2></div>
              <div className="header-avatar-container"><RobotIcon className="header-robot-icon"/></div>
            </div>

            <div className="NEXUS-messages" ref={messagesContainerRef}>
              {messages.map((msg, idx) => (
                <div key={idx} className={`msg-row ${msg.role}`}>
                  {msg.role==='assistant' && <div className="msg-avatar-small"><RobotIcon className="msg-icon-svg"/></div>}
                <div className="msg-col">
  <div className={`msg-bubble ${msg.role}`} style={{ direction: isRTL?'rtl':'ltr' }}>
    <MessageRenderer content={msg.content} isAssistant={msg.role==='assistant'}/>
  </div>

  {/* 🚨 PANEL DE DIAGNÓSTICO INVISIBLE A ERRORES DE CSS 🚨 */}
  {msg.role === 'assistant' && (
    <div style={{ background: '#222', color: '#00FF00', padding: '10px', marginTop: '10px', borderRadius: '8px', fontSize: '13px', width: '100%', fontFamily: 'monospace', zIndex: 999999 }}>
      <strong>🕵️ DIAGNÓSTICO INTERNO:</strong><br/>
      👉 ¿Llegó WhatsApp al chat?: {msg.waLink ? '✅ SÍ' : '❌ NO'}<br/>
      👉 ¿Llegó PDF al chat?: {msg.pdfData ? '✅ SÍ' : '❌ NO'}
      
      {/* Botón a prueba de fallos */}
      {msg.waLink && (
         <a href={msg.waLink} target="_blank" rel="noopener noreferrer" style={{ display:'block', background:'#25D366', color:'white', padding:'10px', marginTop:'8px', textAlign:'center', borderRadius:'20px', textDecoration:'none', fontWeight:'bold' }}>
           BOTÓN DE EMERGENCIA
         </a>
      )}
    </div>
  )}

  {/* Tu código original de los botones (lo dejamos por si acaso) */}
  {msg.role === 'assistant' && (msg.waLink || msg.pdfData) ? (
    <MessageActions waLink={msg.waLink} pdfData={msg.pdfData}/>
  ) : null}
</div>
                </div>
              ))}
              {loading && (
                <div className="msg-row assistant">
                  <div className="msg-avatar-small"><RobotIcon className="msg-icon-svg"/></div>
                  <div className="msg-col">
                    <div className="msg-bubble assistant typing">
                      <span className="dot"/><span className="dot"/><span className="dot"/>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="NEXUS-footer-curve">
              <form onSubmit={(e)=>sendMessage(e,null,false)} className="NEXUS-input-capsule" style={{ flexDirection: isRTL?'row-reverse':'row' }}>
                <button type="button" className="action-btn-mic" onClick={toggleListening}><MicIcon isListening={isListening}/></button>
                <input ref={inputRef} className="NEXUS-input-field" type="text" value={input} onChange={(e)=>setInput(e.target.value)}
                  placeholder={isListening?(t.listeningState||'Escuchando...'):t.placeholder} disabled={loading} dir={isRTL?'rtl':'ltr'}/>
                <button type="submit" className="action-btn-send" disabled={loading||!input.trim()}><SendIcon /></button>
              </form>
            </div>
          </div>
        )}
      </div>

      {!isOpen && (
        <button className="NEXUS-button" onClick={()=>setIsOpen(true)}>
          <RobotIcon className="NEXUS-btn-icon"/>
        </button>
      )}
    </div>
  );
}