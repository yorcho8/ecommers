import React, { useState, useEffect } from 'react';

export default function RecruitmentTab() {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/recruitment', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        setCandidates(Array.isArray(d.candidates) ? d.candidates : []);
        setLoading(false);
      })
      .catch(() => {
        setError('No se pudieron cargar los candidatos.');
        setLoading(false);
      });
  }, []);

  if (loading) return <div style={{ color: '#aaa', padding: 24 }}>Cargando candidatos…</div>;
  if (error)   return <div style={{ color: '#f87171', padding: 24 }}>{error}</div>;
  if (!candidates.length) return <div style={{ color: '#aaa', padding: 24 }}>No hay candidatos registrados.</div>;

  return (
    <div style={{ padding: '16px 0', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            {['Nombre', 'Correo', 'Puesto', 'Fecha', 'Estado'].map((h) => (
              <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {candidates.map((c, i) => (
            <tr key={c.id || i} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <td style={{ padding: '8px 10px', color: '#f0f2f5' }}>{c.nombre || c.name || '—'}</td>
              <td style={{ padding: '8px 10px', color: '#f0f2f5' }}>{c.correo || c.email || '—'}</td>
              <td style={{ padding: '8px 10px', color: '#f0f2f5' }}>{c.puesto || c.position || '—'}</td>
              <td style={{ padding: '8px 10px', color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>{c.fecha || c.date || '—'}</td>
              <td style={{ padding: '8px 10px' }}>
                <span style={{
                  display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 11,
                  background: 'rgba(34,197,94,0.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.3)'
                }}>
                  {c.estado || c.status || 'nuevo'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
