import React, { useState } from "react";

export default function CategoriaCarousel({ categorias, currentLang, t }) {
  const [index, setIndex] = useState(0);
  if (!categorias || categorias.length === 0) return null;
  const categoria = categorias[index];

  const handlePrev = () => setIndex((prev) => (prev === 0 ? categorias.length - 1 : prev - 1));
  const handleNext = () => setIndex((prev) => (prev === categorias.length - 1 ? 0 : prev + 1));

  return (
    <section className="categoria-section">
      <div className="categoria-header">
        <button className="carousel-arrow left" onClick={handlePrev} aria-label="Anterior categoría">&#8592;</button>
        <h2>{categoria.nombre}</h2>
        <a
          href={`/${currentLang}/productos/categoria/${categoria.id}`}
          className="ver-mas-btn"
        >
          {t.common.seeMore || 'Ver más'}
        </a>
        <button className="carousel-arrow right" onClick={handleNext} aria-label="Siguiente categoría">&#8594;</button>
      </div>
      <div className="productos-carousel">
        {categoria.productos.slice(0, 4).map((producto) => (
          <div className="producto-card" key={producto.id}>
            <div className="producto-imagen">
              {producto.imagenes && producto.imagenes.length > 0 ? (
                <img
                  src={producto.imagenes[0]}
                  alt={producto.nombre}
                  loading="lazy"
                />
              ) : (
                <div className="producto-imagen-placeholder">
                  <span>Sin imagen</span>
                </div>
              )}
            </div>
            <div className="producto-info">
              <h3 className="producto-nombre">{producto.nombre}</h3>
              <p className="producto-descripcion">
                {producto.descripcion ? producto.descripcion.substring(0, 80) + '...' : ''}
              </p>
              <div className="producto-precio">
                <span className="precio">${producto.precio}</span>
              </div>
            </div>
          </div>
        ))}
        {categoria.productos.length === 0 && (
          <div className="no-productos-categoria">
            <p>No hay productos en esta categoría aún.</p>
          </div>
        )}
      </div>
    </section>
  );
}
