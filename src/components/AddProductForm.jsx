import React, { useState, useEffect, useRef } from 'react';

export function AddProductForm() {
  const [formData, setFormData] = useState({
    nombre: '',
    codigoReferencia: '',
    descripcion: '',
    precio: '',
    stockDisponible: '',
    peso: '',
    largoExacto: '',
    anchoExacto: '',
    grosorExacto: '',
    unidadDimensiones: 'cm'
  });
  const [variantes, setVariantes] = useState([]);

  const [imagenes, setImagenes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const urlInputRef = useRef(null);

  const [categorias, setCategorias] = useState([]);
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState('');
  const [nuevaCategoria, setNuevaCategoria] = useState('');
  const [nuevaDescripcionCategoria, setNuevaDescripcionCategoria] = useState('');
  const [nuevaImagenCategoria, setNuevaImagenCategoria] = useState('');
  const [loadingCategorias, setLoadingCategorias] = useState(false);

  useEffect(() => {
    const cargarCategorias = async () => {
      try {
        const response = await fetch('/api/categorias');
        const data = await response.json();
        if (data.success) {
          setCategorias(data.categorias);
        }
      } catch (error) {
        console.error('Error cargando categorías:', error);
      }
    };
    cargarCategorias();
  }, []);

  const agregarCategoria = async () => {
    if (!nuevaCategoria.trim()) {
      setMessage({
        type: 'error',
        text: 'Por favor ingresa un nombre para la categoría'
      });
      return;
    }

    setLoadingCategorias(true);
    try {
      const response = await fetch('/api/categorias/crear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: nuevaCategoria.trim(),
          descripcion: nuevaDescripcionCategoria.trim(),
          imagenUrl: nuevaImagenCategoria.trim()
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setCategorias(prev => [...prev, data.categoria]);
        setCategoriaSeleccionada(data.categoria.Id_Categoria.toString());
        setNuevaCategoria('');
        setNuevaDescripcionCategoria('');
        setNuevaImagenCategoria('');
        setMessage({
          type: 'success',
          text: `Categoría "${data.categoria.Nombre}" creada exitosamente`
        });
      } else {
        setMessage({
          type: 'error',
          text: data.error || 'Error al crear la categoría'
        });
      }
    } catch (error) {
      console.error('Error:', error);
      setMessage({
        type: 'error',
        text: 'Error de conexión al crear la categoría'
      });
    } finally {
      setLoadingCategorias(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const agregarUrl = () => {
    if (!urlInput.trim()) {
      setMessage({
        type: 'error',
        text: 'Por favor ingresa una URL válida'
      });
      setUrlInput('');
      return;
    }

    try {
      new URL(urlInput);
    } catch (e) {
      setMessage({
        type: 'error',
        text: 'La URL no es válida'
      });
      setUrlInput('');
      return;
    }

    setImagenes(prev => [...prev, { url: urlInput, orden: prev.length }]);
    setUrlInput('');
    setMessage(null);

    setTimeout(() => {
      if (urlInputRef.current) {
        urlInputRef.current.focus();
      }
    }, 100);
  };

  const handleUrlKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (imagenes.length === 0) {
        agregarUrl();
      }
    }
  };

  const handleUrlBlur = () => {
    if (imagenes.length === 0 && urlInput.trim()) {
      agregarUrl();
    }
  };

  const removeImage = (index) => {
    setImagenes(prev => prev.filter((_, i) => i !== index));
  };

  const addVariante = () => {
    setVariantes((prev) => [...prev, { descripcion: '', precio: '', stock: '', peso: '', largo: '', ancho: '', grosor: '' }]);
  };

  const removeVariante = (idx) => {
    setVariantes((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateVariante = (idx, field, value) => {
    setVariantes((prev) => prev.map((v, i) => i === idx ? { ...v, [field]: value } : v));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const categoriaNum = parseInt(categoriaSeleccionada);
    if (!formData.nombre || !formData.precio || imagenes.length === 0 || !categoriaSeleccionada || isNaN(categoriaNum)) {
      setMessage({
        type: 'error',
        text: 'Por favor completa los campos obligatorios: nombre, precio, imágenes y categoría'
      });
      return;
    }

    const variantesValidas = variantes
      .filter((v) => String(v.descripcion || '').trim())
      .map((v) => ({
        descripcion: String(v.descripcion || '').trim(),
        precio: v.precio === '' ? null : Number(v.precio),
        stock: v.stock === '' ? null : Number(v.stock),
        peso: v.peso === '' ? null : Number(v.peso),
        especificaciones: (v.largo !== '' && v.ancho !== '' && v.grosor !== '')
          ? {
              dimensiones: {
                unidad: formData.unidadDimensiones,
                largo: Number(v.largo),
                ancho: Number(v.ancho),
                grosor: Number(v.grosor),
              }
            }
          : null,
      }));

    for (const v of variantesValidas) {
      if (v.precio == null || !Number.isFinite(v.precio) || v.precio <= 0) {
        setMessage({ type: 'error', text: `La variante "${v.descripcion}" requiere un precio mayor a 0` });
        return;
      }
      if (v.stock == null || !Number.isFinite(v.stock) || v.stock < 0) {
        setMessage({ type: 'error', text: `La variante "${v.descripcion}" requiere stock (mínimo 0)` });
        return;
      }
    }
    if (variantesValidas.some((v) => v.peso != null && (!Number.isFinite(v.peso) || v.peso <= 0))) {
      setMessage({ type: 'error', text: 'Si capturas peso en variante, debe ser mayor a 0' });
      return;
    }

    setLoading(true);

    try {
      const submitData = new FormData();
      submitData.append('nombre', formData.nombre);
      if (formData.codigoReferencia) submitData.append('codigoReferencia', formData.codigoReferencia);
      submitData.append('descripcion', formData.descripcion);
      submitData.append('precio', parseFloat(formData.precio));
      submitData.append('stockDisponible', parseInt(formData.stockDisponible) || 0);
      submitData.append('categoriaId', categoriaNum);
      if (formData.peso !== '' && Number(formData.peso) > 0) {
        submitData.append('peso', Number(formData.peso));
      }
      if (formData.largoExacto !== '' && formData.anchoExacto !== '' && formData.grosorExacto !== '' && Number(formData.largoExacto) > 0 && Number(formData.anchoExacto) > 0 && Number(formData.grosorExacto) > 0) {
        submitData.append('especificaciones', JSON.stringify({
          dimensiones: {
            unidad: formData.unidadDimensiones,
            largo: Number(formData.largoExacto),
            ancho: Number(formData.anchoExacto),
            grosor: Number(formData.grosorExacto),
          }
        }));
      }
      if (variantesValidas.length > 0) {
        submitData.append('variantes', JSON.stringify(variantesValidas));
      }

      imagenes.forEach((img, index) => {
        submitData.append(`imagenes`, img.url);
      });

      const response = await fetch('/api/productos/crear', {
        method: 'POST',
        body: submitData,
        credentials: 'include'
      });

      const data = await response.json();
      console.log('Respuesta crear producto:', { status: response.status, data });

      if (response.ok && data.success) {
        setMessage({
          type: 'success',
          text: data?.pendingApproval
            ? `Producto "${formData.nombre}" enviado a revision. Espera aprobacion de superusuario.`
            : `Producto "${formData.nombre}" creado exitosamente`
        });

        setFormData({
          nombre: '',
          codigoReferencia: '',
          descripcion: '',
          precio: '',
          stockDisponible: '',
          peso: '',
          largoExacto: '',
          anchoExacto: '',
          grosorExacto: '',
          unidadDimensiones: 'cm'
        });
        setVariantes([]);
        setImagenes([]);
        setUrlInput('');

        console.log(' Producto creado:', data);
        setTimeout(() => {
          console.log('Recargando página...');
          window.location.reload();
        }, 3000);
      } else {
        setMessage({
          type: 'error',
          text: data.error || 'Error al crear el producto'
        });
      }
    } catch (error) {
      console.error('Error:', error);
      setMessage({
        type: 'error',
        text: 'Error de conexión. Intenta nuevamente.'
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="add-product-form">
      {message && (
        <div className={`form-message form-message--${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="form-group">
        <label htmlFor="nombre" className="form-label">
          Nombre del Producto <span className="required">*</span>
        </label>
        <input
          id="nombre"
          type="text"
          name="nombre"
          value={formData.nombre}
          onChange={handleInputChange}
          placeholder="Ej: Bolsas de Nylon"
          className="form-input"
          required
        />
      </div>
      <div className="form-group">
        <label htmlFor="codigoReferencia" className="form-label">
          Código de referencia (opcional)
        </label>
        <input
          id="codigoReferencia"
          type="text"
          name="codigoReferencia"
          value={formData.codigoReferencia}
          onChange={handleInputChange}
          placeholder="Ej: REF-001"
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label htmlFor="descripcion" className="form-label">
          Descripción
        </label>
        <textarea
          id="descripcion"
          name="descripcion"
          value={formData.descripcion}
          onChange={handleInputChange}
          placeholder="Descripción detallada del producto"
          className="form-textarea"
          rows={4}
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="precio" className="form-label">
            Precio ($MX) <span className="required">*</span>
          </label>
          <input
            id="precio"
            type="number"
            name="precio"
            value={formData.precio}
            onChange={handleInputChange}
            placeholder="0.00"
            className="form-input"
            step="0.01"
            min="0"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="stockDisponible" className="form-label">
            Stock Disponible
          </label>
          <input
            id="stockDisponible"
            type="number"
            name="stockDisponible"
            value={formData.stockDisponible}
            onChange={handleInputChange}
            placeholder="0"
            className="form-input"
            min="0"
          />
        </div>

        <div className="form-group">
          <label htmlFor="peso" className="form-label">
            Peso real (kg)
          </label>
          <input
            id="peso"
            type="number"
            name="peso"
            value={formData.peso}
            onChange={handleInputChange}
            placeholder="0.00"
            className="form-input"
            step="0.01"
            min="0"
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="largoExacto" className="form-label">Largo exacto</label>
          <input id="largoExacto" type="number" name="largoExacto" value={formData.largoExacto} onChange={handleInputChange} className="form-input" step="0.01" min="0" />
        </div>
        <div className="form-group">
          <label htmlFor="anchoExacto" className="form-label">Ancho exacto</label>
          <input id="anchoExacto" type="number" name="anchoExacto" value={formData.anchoExacto} onChange={handleInputChange} className="form-input" step="0.01" min="0" />
        </div>
        <div className="form-group">
          <label htmlFor="grosorExacto" className="form-label">Grosor exacto</label>
          <input id="grosorExacto" type="number" name="grosorExacto" value={formData.grosorExacto} onChange={handleInputChange} className="form-input" step="0.01" min="0" />
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="unidadDimensiones" className="form-label">Unidad de dimensiones</label>
        <select id="unidadDimensiones" name="unidadDimensiones" value={formData.unidadDimensiones} onChange={handleInputChange} className="form-select">
          <option value="mm">mm</option>
          <option value="cm">cm</option>
          <option value="m">m</option>
          <option value="in">in</option>
          <option value="ft">ft</option>
        </select>
      </div>

      <div className="form-group">
        <label className="form-label">Variantes (color, caja, calibre, etc.)</label>
        <button type="button" onClick={addVariante} className="btn btn--add-url" style={{ marginBottom: '10px' }}>
          + Agregar variante
        </button>
        {variantes.map((v, idx) => (
          <div key={idx} className="form-row" style={{ marginBottom: '8px' }}>
            <div className="form-group">
              <input type="text" value={v.descripcion} onChange={(e) => updateVariante(idx, 'descripcion', e.target.value)} placeholder="Descripción" className="form-input" />
            </div>
            <div className="form-group">
              <input type="number" value={v.precio} onChange={(e) => updateVariante(idx, 'precio', e.target.value)} placeholder="Precio" className="form-input" step="0.01" min="0" />
            </div>
            <div className="form-group">
              <input type="number" value={v.stock} onChange={(e) => updateVariante(idx, 'stock', e.target.value)} placeholder="Stock" className="form-input" min="0" />
            </div>
            <div className="form-group">
              <input type="number" value={v.peso || ''} onChange={(e) => updateVariante(idx, 'peso', e.target.value)} placeholder="Peso kg" className="form-input" min="0" step="0.01" />
            </div>
            <div className="form-group">
              <input type="number" value={v.largo || ''} onChange={(e) => updateVariante(idx, 'largo', e.target.value)} placeholder="Largo" className="form-input" min="0" step="0.01" />
            </div>
            <div className="form-group">
              <input type="number" value={v.ancho || ''} onChange={(e) => updateVariante(idx, 'ancho', e.target.value)} placeholder="Ancho" className="form-input" min="0" step="0.01" />
            </div>
            <div className="form-group">
              <input type="number" value={v.grosor || ''} onChange={(e) => updateVariante(idx, 'grosor', e.target.value)} placeholder="Grosor" className="form-input" min="0" step="0.01" />
            </div>
            <button type="button" onClick={() => removeVariante(idx)} className="btn-remove-url">x</button>
          </div>
        ))}
      </div>

      <div className="form-group">
        <label className="form-label">
          URLs de Imágenes (Cloudinary) <span className="required">*</span>
        </label>
        <p className="form-help-text">
          {imagenes.length === 0
            ? "Pega la URL de la imagen principal (se agregará automáticamente al presionar Enter o cambiar de campo)"
            : "Para agregar más imágenes, pega la URL aquí y click en '+'"
          }
        </p>
        <div className="image-url-input-area">
          <input
            ref={urlInputRef}
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyPress={handleUrlKeyPress}
            onBlur={handleUrlBlur}
            placeholder={
              imagenes.length === 0
                ? "Pega la URL de Cloudinary aquí (Enter o click fuera para agregar)"
                : "Pega otra URL de Cloudinary aquí y click en + para agregarla"
            }
            className="form-input"
          />
          <button
            type="button"
            onClick={agregarUrl}
            className="btn btn--add-url"
          >
            + Agregar URL
          </button>
        </div>

        {imagenes.length > 0 && (
          <div className="image-url-list">
            <h4>Imágenes añadidas ({imagenes.length}):</h4>
            {imagenes.map((img, index) => (
              <div key={index} className="image-url-item">
                <span className="url-number">{index + 1}</span>
                <span className="url-text" title={img.url}>
                  {img.url.length > 50 ? img.url.substring(0, 50) + '...' : img.url}
                </span>
                <button
                  type="button"
                  onClick={() => removeImage(index)}
                  className="btn-remove-url"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="categoria" className="form-label">
          Categoría <span className="required">*</span>
        </label>
        <div className="categoria-input-area">
          <select
            id="categoria"
            value={categoriaSeleccionada}
            onChange={(e) => setCategoriaSeleccionada(e.target.value)}
            className="form-select"
            required
          >
            <option value="">Selecciona una categoría</option>
            {categorias.map((cat) => (
              <option key={cat.Id_Categoria} value={cat.Id_Categoria}>
                {cat.Nombre}
              </option>
            ))}
          </select>

          <div className="add-categoria-section">
            <h4 className="categoria-section-title">Crear nueva categoría</h4>
            <p className="categoria-section-help">
              Escribe el nombre y, si quieres, agrega descripción e imagen para mostrarla en el carrusel.
            </p>

            <label className="categoria-field-label" htmlFor="nuevaCategoriaNombre">
              Nombre de categoría <span className="required">*</span>
            </label>
            <input
              id="nuevaCategoriaNombre"
              type="text"
              value={nuevaCategoria}
              onChange={(e) => setNuevaCategoria(e.target.value)}
              placeholder="Ej: Cuerdas Industriales"
              className="form-input form-input--small"
              disabled={loadingCategorias}
            />

            <label className="categoria-field-label" htmlFor="nuevaCategoriaDescripcion">
              Descripción (opcional)
            </label>
            <input
              id="nuevaCategoriaDescripcion"
              type="text"
              value={nuevaDescripcionCategoria}
              onChange={(e) => setNuevaDescripcionCategoria(e.target.value)}
              placeholder="Texto breve para mostrar en el carrusel"
              className="form-input form-input--small"
              disabled={loadingCategorias}
            />

            <label className="categoria-field-label" htmlFor="nuevaCategoriaImagen">
              URL imagen categoría (opcional)
            </label>
            <input
              id="nuevaCategoriaImagen"
              type="text"
              value={nuevaImagenCategoria}
              onChange={(e) => setNuevaImagenCategoria(e.target.value)}
              placeholder="https://..."
              className="form-input form-input--small"
              disabled={loadingCategorias}
            />

            <button
              type="button"
              onClick={agregarCategoria}
              disabled={loadingCategorias || !nuevaCategoria.trim()}
              className="btn btn--add-categoria"
            >
              {loadingCategorias ? 'Creando...' : 'Crear categoría'}
            </button>
          </div>
        </div>
      </div>

      <div className="form-actions">
        <button
          type="submit"
          disabled={loading}
          className="btn btn--primary"
        >
          {loading ? 'Creando producto...' : 'Crear Producto'}
        </button>
      </div>
    </form>
  );
}

export default AddProductForm;


