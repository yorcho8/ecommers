// src/components/FondoSilk.jsx
import React from 'react';
// IMPORTANTE: Asegúrate de importar el componente Silk desde donde lo tengas instalado
// Ejemplo: import Silk from 'react-silk'; o import { Silk } from './Silk'; 
// Si Silk es un archivo local, ajusta la ruta.
import Silk from './Silk'; 

export default function FondoSilk() {
  return (
    <div 
      className="fondo-silk-wrapper"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100vh',
        zIndex: -1, /* Se queda detrás de todo */
        pointerEvents: 'none', /* Permite hacer clic a través de él */
        opacity: 0, /* Invisible por defecto (modo claro) */
        transition: 'opacity 0.8s ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
      }}
    >
      {/* Estilo global para activar la visibilidad en modo oscuro */}
      <style>{`
        html.dark .fondo-silk-wrapper {
          opacity: 1 !important;
        }
      `}</style>

      {/* Tu configuración de Silk */}
      <Silk
        speed={5}
        scale={1}
        color="#fb670b"
        noiseIntensity={0.4}
        rotation={0}
      />
    </div>
  );
}