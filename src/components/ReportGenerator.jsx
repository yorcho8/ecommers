import React from 'react';

export function DownloadReportButton({ data, periodMeta }) {
  const handleDownload = () => {
    if (!data) return;
    const json = JSON.stringify({ data, period: periodMeta }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte_${periodMeta?.preset || 'custom'}_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      onClick={handleDownload}
      style={{
        padding: '6px 12px',
        borderRadius: 7,
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        background: 'rgba(122,37,50,0.18)',
        border: '1px solid rgba(122,37,50,0.45)',
        color: '#f9a8a8',
        fontFamily: 'inherit',
        letterSpacing: '0.01em',
      }}
    >
      Descargar reporte
    </button>
  );
}
