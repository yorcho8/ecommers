import React, { useCallback, useEffect, useMemo, useState } from 'react';
import '../styles/AdminCrudSidebar.css';

const EMPTY_PRODUCT = {
  nombre: '',
  codigoReferencia: '',
  descripcion: '',
  precio: '',
  stock: '',
  categoriaId: '',
  imagenUrl: '',
};

const EMPTY_CATEGORY = {
  nombre: '',
  descripcion: '',
  imagenUrl: '',
};

const EMPTY_USER = {
  nombre: '',
  apellidoPaterno: '',
  apellidoMaterno: '',
  correo: '',
  telefono: '',
  rol: 'usuario',
  contrasena: '',
};

const EMPTY_AD_FORM = {
  productoId: '',
  cardId: '',
  posicion: 'grid',
  dias: '1',
  prioridadExtra: '0',
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { credentials: 'include', ...options });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export default function AdminCrudSidebar() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('productos');
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState({ type: '', text: '' });
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT);
  const [categoryForm, setCategoryForm] = useState(EMPTY_CATEGORY);
  const [userForm, setUserForm] = useState(EMPTY_USER);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [currentRole, setCurrentRole] = useState('');
  const [adForm, setAdForm] = useState(EMPTY_AD_FORM);
  const [adProducts, setAdProducts] = useState([]);
  const [adCards, setAdCards] = useState([]);
  const [adCampaigns, setAdCampaigns] = useState([]);
  const [adPlans, setAdPlans] = useState([]);
  const [adProcessing, setAdProcessing] = useState(false);
  const canManageUsers = currentRole === 'superusuario';

  const resetStatus = useCallback(() => setStatus({ type: '', text: '' }), []);

  const ensureAdmin = useCallback(async () => {
    const { response, data } = await fetchJson('/api/me');
    const role = String(data?.user?.rol || '').toLowerCase();
    const isPrivileged = response.ok && data?.success && (role === 'admin' || role === 'superusuario');
    if (!isPrivileged) {
      setStatus({ type: 'error', text: 'Sesion no autorizada para administracion.' });
      setCurrentRole('');
      return '';
    } else {
      setCurrentRole(role);
      return role;
    }
  }, []);

  const loadData = useCallback(async (roleOverride = '') => {
    setLoading(true);
    resetStatus();
    const roleToUse = String(roleOverride || currentRole || '').toLowerCase();

    try {
      const [productsRes, categoriesRes] = await Promise.all([
        fetchJson('/api/productos'),
        fetchJson('/api/productos/categorias'),
      ]);

      if (productsRes.response.ok && productsRes.data?.success) {
        setProducts(Array.isArray(productsRes.data.productos) ? productsRes.data.productos : []);
      }

      if (categoriesRes.response.ok && categoriesRes.data?.success) {
        setCategories(Array.isArray(categoriesRes.data.categorias) ? categoriesRes.data.categorias : []);
      }

      if (roleToUse === 'superusuario') {
        const usersRes = await fetchJson('/api/admin/usuarios');
        if (usersRes.response.ok && usersRes.data?.success) {
          setUsers(Array.isArray(usersRes.data.usuarios) ? usersRes.data.usuarios : []);
        }
      } else {
        setUsers([]);
      }
    } catch (error) {
      setStatus({ type: 'error', text: 'No se pudieron cargar datos del panel.' });
    } finally {
      setLoading(false);
    }
  }, [resetStatus, currentRole]);

  const loadPublicidadData = useCallback(async () => {
    try {
      const [productsRes, cardsRes, campaignsRes, plansRes] = await Promise.all([
        fetchJson('/api/publicidad/productos'),
        fetchJson('/api/tarjetas'),
        fetchJson('/api/publicidad/mis-campanas'),
        fetchJson('/api/publicidad/planes'),
      ]);

      if (productsRes.response.ok && productsRes.data?.success) {
        setAdProducts(Array.isArray(productsRes.data.products) ? productsRes.data.products : []);
      }

      if (cardsRes.response.ok && cardsRes.data?.success) {
        setAdCards(Array.isArray(cardsRes.data.tarjetas) ? cardsRes.data.tarjetas : []);
      }

      if (campaignsRes.response.ok && campaignsRes.data?.success) {
        setAdCampaigns(Array.isArray(campaignsRes.data.campaigns) ? campaignsRes.data.campaigns : []);
      }

      if (plansRes.response.ok && plansRes.data?.success) {
        setAdPlans(Array.isArray(plansRes.data.plans) ? plansRes.data.plans : []);
      }
    } catch {
      setStatus({ type: 'error', text: 'No se pudieron cargar los datos de publicidad.' });
    }
  }, []);

  useEffect(() => {
    if (!open || activeTab !== 'publicidad') return;
    void loadPublicidadData();
  }, [open, activeTab, loadPublicidadData]);

  useEffect(() => {
    if (activeTab === 'usuarios' && !canManageUsers) {
      setActiveTab('productos');
    }
  }, [activeTab, canManageUsers]);

  useEffect(() => {
    const openCrud = async () => {
      const role = await ensureAdmin();
      if (!role) return;
      setOpen(true);
      await loadData(role);
    };

    const handler = (event) => {
      const requestedTab = event?.detail?.tab;
      const canOpenUsers = currentRole === 'superusuario';
      if (requestedTab === 'usuarios' && !canOpenUsers) {
        setActiveTab('productos');
      } else if (requestedTab === 'productos' || requestedTab === 'categorias' || requestedTab === 'usuarios' || requestedTab === 'publicidad') {
        setActiveTab(requestedTab);
      }
      void openCrud();
    };

    window.addEventListener('admin:openCrudSidebar', handler);
    return () => window.removeEventListener('admin:openCrudSidebar', handler);
  }, [ensureAdmin, loadData, currentRole]);

  const selectedProduct = useMemo(
    () => products.find((p) => String(p.id) === String(selectedProductId)) || null,
    [products, selectedProductId]
  );

  const selectedCategory = useMemo(
    () => categories.find((c) => String(c.id || c.Id_Categoria) === String(selectedCategoryId)) || null,
    [categories, selectedCategoryId]
  );

  const selectedUser = useMemo(
    () => users.find((u) => String(u.id) === String(selectedUserId)) || null,
    [users, selectedUserId]
  );

  useEffect(() => {
    if (!selectedProduct) return;
    setProductForm({
      nombre: selectedProduct.nombre || '',
      codigoReferencia: selectedProduct.codigoReferencia || '',
      descripcion: selectedProduct.descripcion || '',
      precio: selectedProduct.precio != null ? String(selectedProduct.precio) : '',
      stock: selectedProduct.stock != null ? String(selectedProduct.stock) : '',
      categoriaId: selectedProduct.categoriaId != null ? String(selectedProduct.categoriaId) : '',
      imagenUrl: selectedProduct.imagen || '',
    });
  }, [selectedProduct]);

  useEffect(() => {
    if (!selectedCategory) return;
    setCategoryForm({
      nombre: selectedCategory.nombre || selectedCategory.Nombre || '',
      descripcion: selectedCategory.descripcion || selectedCategory.Descripcion || '',
      imagenUrl: selectedCategory.imagen || selectedCategory.Imagen_URL || '',
    });
  }, [selectedCategory]);

  useEffect(() => {
    if (!selectedUser) return;
    setUserForm({
      nombre: selectedUser.nombre || '',
      apellidoPaterno: selectedUser.apellidoPaterno || '',
      apellidoMaterno: selectedUser.apellidoMaterno || '',
      correo: selectedUser.correo || '',
      telefono: selectedUser.telefono || '',
      rol: String(selectedUser.rol || 'usuario').toLowerCase(),
      contrasena: '',
    });
  }, [selectedUser]);

  const handleCreateProduct = async () => {
    const role = await ensureAdmin();
    if (!role) return;

    if (!productForm.nombre || !productForm.precio || !productForm.categoriaId || !productForm.imagenUrl) {
      setStatus({ type: 'error', text: 'Completa los campos obligatorios del producto.' });
      return;
    }

    const fd = new FormData();
    fd.append('nombre', productForm.nombre.trim());
    if (productForm.codigoReferencia) fd.append('codigoReferencia', productForm.codigoReferencia.trim());
    fd.append('descripcion', productForm.descripcion.trim());
    fd.append('precio', String(Number(productForm.precio)));
    fd.append('stockDisponible', String(Number(productForm.stock || 0)));
    fd.append('categoriaId', String(Number(productForm.categoriaId)));
    fd.append('imagenes', productForm.imagenUrl.trim());

    const { response, data } = await fetchJson('/api/productos/crear', { method: 'POST', body: fd });
    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo crear el producto.' });
      return;
    }

    setStatus({
      type: 'ok',
      text: data?.pendingApproval
        ? 'Producto enviado a revision. Se publicara cuando superusuario lo apruebe.'
        : 'Producto creado correctamente.',
    });
    setProductForm(EMPTY_PRODUCT);
    await loadData(role);
  };

  const handleCreateCategory = async () => {
    const role = await ensureAdmin();
    if (!role) return;

    if (!categoryForm.nombre.trim()) {
      setStatus({ type: 'error', text: 'El nombre de categoria es obligatorio.' });
      return;
    }

    const payload = {
      nombre: categoryForm.nombre.trim(),
      descripcion: categoryForm.descripcion.trim(),
      imagenUrl: categoryForm.imagenUrl.trim(),
    };

    const { response, data } = await fetchJson('/api/categorias/crear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo crear la categoria.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Categoria creada correctamente.' });
    setCategoryForm(EMPTY_CATEGORY);
    await loadData(role);
  };

  const handleUpdateProduct = async () => {
    const role = await ensureAdmin();
    if (!role) return;
    if (!selectedProductId) {
      setStatus({ type: 'error', text: 'Selecciona un producto para actualizar.' });
      return;
    }
    if (!productForm.nombre || !productForm.precio || !productForm.categoriaId) {
      setStatus({ type: 'error', text: 'Completa nombre, precio y categoria para actualizar.' });
      return;
    }

    const payload = {
      nombre: productForm.nombre.trim(),
      descripcion: productForm.descripcion.trim(),
      precio: Number(productForm.precio),
      stockDisponible: Number(productForm.stock || 0),
      categoriaId: Number(productForm.categoriaId),
      imagenUrl: productForm.imagenUrl.trim(),
    };

    const { response, data } = await fetchJson(`/api/admin/productos/${selectedProductId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo actualizar el producto.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Producto actualizado correctamente.' });
    await loadData(role);
  };

  const handleDeleteProduct = async () => {
    const role = await ensureAdmin();
    if (!role) return;
    if (!selectedProductId) {
      setStatus({ type: 'error', text: 'Selecciona un producto para eliminar.' });
      return;
    }

    const confirmed = window.confirm('Esta accion eliminara el producto. Deseas continuar?');
    if (!confirmed) return;

    const { response, data } = await fetchJson(`/api/admin/productos/${selectedProductId}`, {
      method: 'DELETE',
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo eliminar el producto.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Producto eliminado correctamente.' });
    setSelectedProductId('');
    setProductForm(EMPTY_PRODUCT);
    await loadData(role);
  };

  const handleUpdateCategory = async () => {
    const role = await ensureAdmin();
    if (!role) return;
    if (!selectedCategoryId) {
      setStatus({ type: 'error', text: 'Selecciona una categoria para actualizar.' });
      return;
    }
    if (!categoryForm.nombre.trim()) {
      setStatus({ type: 'error', text: 'El nombre de categoria es obligatorio.' });
      return;
    }

    const payload = {
      nombre: categoryForm.nombre.trim(),
      descripcion: categoryForm.descripcion.trim(),
      imagenUrl: categoryForm.imagenUrl.trim(),
    };

    const { response, data } = await fetchJson(`/api/admin/categorias/${selectedCategoryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo actualizar la categoria.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Categoria actualizada correctamente.' });
    await loadData(role);
  };

  const handleDeleteCategory = async () => {
    const role = await ensureAdmin();
    if (!role) return;
    if (!selectedCategoryId) {
      setStatus({ type: 'error', text: 'Selecciona una categoria para eliminar.' });
      return;
    }

    const confirmed = window.confirm('Esta accion eliminara la categoria si no tiene productos enlazados. Continuar?');
    if (!confirmed) return;

    const { response, data } = await fetchJson(`/api/admin/categorias/${selectedCategoryId}`, {
      method: 'DELETE',
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo eliminar la categoria.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Categoria eliminada correctamente.' });
    setSelectedCategoryId('');
    setCategoryForm(EMPTY_CATEGORY);
    await loadData(role);
  };

  const handleCreateUser = async () => {
    const role = await ensureAdmin();
    if (!role || role !== 'superusuario') {
      setStatus({ type: 'error', text: 'Solo superusuario puede gestionar usuarios.' });
      return;
    }

    if (!userForm.nombre.trim() || !userForm.apellidoPaterno.trim() || !userForm.correo.trim() || !userForm.contrasena.trim()) {
      setStatus({ type: 'error', text: 'Nombre, apellido paterno, correo y contrasena son obligatorios.' });
      return;
    }

    const payload = {
      nombre: userForm.nombre.trim(),
      apellidoPaterno: userForm.apellidoPaterno.trim(),
      apellidoMaterno: userForm.apellidoMaterno.trim(),
      correo: userForm.correo.trim(),
      telefono: userForm.telefono.trim(),
      rol: userForm.rol,
      contrasena: userForm.contrasena,
    };

    const { response, data } = await fetchJson('/api/admin/usuarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo crear el usuario.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Usuario creado correctamente.' });
    setUserForm(EMPTY_USER);
    await loadData(role);
  };

  const handleUpdateUser = async () => {
    const role = await ensureAdmin();
    if (!role || role !== 'superusuario') {
      setStatus({ type: 'error', text: 'Solo superusuario puede gestionar usuarios.' });
      return;
    }
    if (!selectedUserId) {
      setStatus({ type: 'error', text: 'Selecciona un usuario para actualizar.' });
      return;
    }

    if (!userForm.nombre.trim() || !userForm.apellidoPaterno.trim() || !userForm.correo.trim()) {
      setStatus({ type: 'error', text: 'Nombre, apellido paterno y correo son obligatorios.' });
      return;
    }

    const payload = {
      nombre: userForm.nombre.trim(),
      apellidoPaterno: userForm.apellidoPaterno.trim(),
      apellidoMaterno: userForm.apellidoMaterno.trim(),
      correo: userForm.correo.trim(),
      telefono: userForm.telefono.trim(),
      rol: userForm.rol,
      contrasena: userForm.contrasena.trim(),
    };

    const { response, data } = await fetchJson(`/api/admin/usuarios/${selectedUserId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo actualizar el usuario.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Usuario actualizado correctamente.' });
    setUserForm((prev) => ({ ...prev, contrasena: '' }));
    await loadData(role);
  };

  const handleDeleteUser = async () => {
    const role = await ensureAdmin();
    if (!role) return;
    if (!selectedUserId) {
      setStatus({ type: 'error', text: 'Selecciona un usuario para eliminar.' });
      return;
    }

    if (role !== 'superusuario') {
      setStatus({ type: 'error', text: 'Solo superusuario puede eliminar usuarios.' });
      return;
    }

    const confirmed = window.confirm('Esta accion eliminara al usuario seleccionado. Deseas continuar?');
    if (!confirmed) return;

    const { response, data } = await fetchJson(`/api/admin/usuarios/${selectedUserId}`, {
      method: 'DELETE',
    });

    if (!response.ok || !data?.success) {
      setStatus({ type: 'error', text: data?.error || 'No se pudo eliminar el usuario.' });
      return;
    }

    setStatus({ type: 'ok', text: 'Usuario eliminado correctamente.' });
    setSelectedUserId('');
    setUserForm(EMPTY_USER);
    await loadData(role);
  };

  const adQuote = useMemo(() => {
    const position = String(adForm.posicion || 'grid').toLowerCase();
    const days = Math.max(1, Math.min(30, Number(adForm.dias) || 1));
    const selectedPlan = adPlans.find((plan) => String(plan.key || '').toLowerCase() === position) || null;
    const pricePerDay = Number(selectedPlan?.pricePerDay || 20);
    const subtotal = pricePerDay * days;
    let discount = 0;

    if (days === 3) discount = subtotal - pricePerDay * 2.5;
    else if (days >= 7) discount = subtotal * 0.25;
    else if (days >= 5) discount = subtotal * 0.15;
    else if (days >= 4) discount = subtotal * 0.1;

    return {
      planLabel: selectedPlan?.label || position.toUpperCase(),
      days,
      subtotal,
      discount,
      total: Math.max(0, subtotal - discount),
    };
  }, [adForm.posicion, adForm.dias, adPlans]);

  const handlePayCampaign = async () => {
    const role = await ensureAdmin();
    if (!role) return;

    const productoId = Number(adForm.productoId || 0);
    const cardId = Number(adForm.cardId || 0);
    const dias = Math.max(1, Math.min(30, Number(adForm.dias) || 1));
    const prioridadExtra = Math.max(0, Math.min(10, Number(adForm.prioridadExtra) || 0));
    const posicion = String(adForm.posicion || 'grid').toLowerCase();

    if (!productoId || !cardId || !posicion || !dias) {
      setStatus({ type: 'error', text: 'Selecciona producto, posicion, dias y tarjeta.' });
      return;
    }

    setAdProcessing(true);
    try {
      const { response, data } = await fetchJson('/api/publicidad/pagar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productoId,
          cardId,
          posicion,
          duracionDias: dias,
          prioridadExtra,
        }),
      });

      if (!response.ok || !data?.success) {
        setStatus({ type: 'error', text: data?.error || 'No se pudo activar la campana.' });
        return;
      }

      setStatus({ type: 'ok', text: `Campana ${String(data?.campaign?.posicionLabel || posicion)} activada correctamente.` });
      await loadPublicidadData();
    } finally {
      setAdProcessing(false);
    }
  };

  return (
    <aside className={`admin-crud ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="admin-crud__header">
        <div>
          <p className="admin-crud__title">Gestion de productos</p>
          <p className="admin-crud__subtitle">CRUD admin con validacion de sesion</p>
        </div>
        <button className="admin-crud__close" type="button" onClick={() => setOpen(false)}>
          Cerrar
        </button>
      </div>

      <div className="admin-crud__tabs">
        <button className={`admin-crud__tab ${activeTab === 'productos' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('productos')}>
          Productos
        </button>
        <button className={`admin-crud__tab ${activeTab === 'categorias' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('categorias')}>
          Categorias
        </button>
        {canManageUsers ? (
          <button className={`admin-crud__tab ${activeTab === 'usuarios' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('usuarios')}>
            Usuarios
          </button>
        ) : null}
        <button className={`admin-crud__tab ${activeTab === 'publicidad' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('publicidad')}>
          Publicidad
        </button>
      </div>

      <div className="admin-crud__content">
        {status.text ? <p className={`admin-crud__status ${status.type === 'ok' ? 'ok' : 'error'}`}>{status.text}</p> : null}
        {loading ? <p className="admin-crud__meta">Cargando datos...</p> : null}

        {activeTab === 'productos' && (
          <>
            <section className="admin-crud__card">
              <h4>Crear producto</h4>
              <div className="admin-crud__grid">
                <input className="admin-crud__input" placeholder="Nombre" value={productForm.nombre} onChange={(e) => setProductForm((p) => ({ ...p, nombre: e.target.value }))} />
                <input className="admin-crud__input" placeholder="Código de referencia (opcional)" value={productForm.codigoReferencia} onChange={(e) => setProductForm((p) => ({ ...p, codigoReferencia: e.target.value }))} />
                <input className="admin-crud__input" placeholder="Precio" type="number" min="0" step="0.01" value={productForm.precio} onChange={(e) => setProductForm((p) => ({ ...p, precio: e.target.value }))} />
                <input className="admin-crud__input" placeholder="Stock" type="number" min="0" value={productForm.stock} onChange={(e) => setProductForm((p) => ({ ...p, stock: e.target.value }))} />
                <select className="admin-crud__select" value={productForm.categoriaId} onChange={(e) => setProductForm((p) => ({ ...p, categoriaId: e.target.value }))}>
                  <option value="">Categoria</option>
                  {categories.map((c) => (
                    <option key={c.id || c.Id_Categoria} value={c.id || c.Id_Categoria}>{c.nombre || c.Nombre}</option>
                  ))}
                </select>
              </div>
              <textarea className="admin-crud__textarea" placeholder="Descripcion" value={productForm.descripcion} onChange={(e) => setProductForm((p) => ({ ...p, descripcion: e.target.value }))} />
              <input className="admin-crud__input" placeholder="URL imagen principal" value={productForm.imagenUrl} onChange={(e) => setProductForm((p) => ({ ...p, imagenUrl: e.target.value }))} />
              <div className="admin-crud__actions">
                <button className="admin-crud__btn primary" type="button" onClick={handleCreateProduct}>Crear</button>
              </div>
            </section>

            <section className="admin-crud__card">
              <h4>Editar o eliminar producto</h4>
              <select className="admin-crud__select" value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value)}>
                <option value="">Selecciona producto</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.nombre}</option>
                ))}
              </select>
              <div className="admin-crud__actions">
                <button className="admin-crud__btn warning" type="button" onClick={handleUpdateProduct}>Actualizar</button>
                <button className="admin-crud__btn danger" type="button" onClick={handleDeleteProduct}>Eliminar</button>
              </div>
              <p className="admin-crud__meta">Selecciona un producto para cargar sus datos en el formulario superior y aplicar cambios.</p>
            </section>

            <section className="admin-crud__card">
              <h4>Inventario actual</h4>
              {products.slice(0, 12).map((p) => (
                <div className="admin-crud__row" key={p.id}>
                  <div className="admin-crud__row-title">{p.nombre}</div>
                  <div className="admin-crud__meta">Categoria: {p.categoria || 'Sin categoria'} | Stock: {p.stock ?? 0} | ${p.precio}</div>
                </div>
              ))}
            </section>
          </>
        )}

        {activeTab === 'categorias' && (
          <>
            <section className="admin-crud__card">
              <h4>Crear categoria</h4>
              <div className="admin-crud__grid">
                <input className="admin-crud__input" placeholder="Nombre" value={categoryForm.nombre} onChange={(e) => setCategoryForm((c) => ({ ...c, nombre: e.target.value }))} />
                <input className="admin-crud__input" placeholder="URL imagen" value={categoryForm.imagenUrl} onChange={(e) => setCategoryForm((c) => ({ ...c, imagenUrl: e.target.value }))} />
              </div>
              <textarea className="admin-crud__textarea" placeholder="Descripcion" value={categoryForm.descripcion} onChange={(e) => setCategoryForm((c) => ({ ...c, descripcion: e.target.value }))} />
              <div className="admin-crud__actions">
                <button className="admin-crud__btn primary" type="button" onClick={handleCreateCategory}>Crear</button>
              </div>
            </section>

            <section className="admin-crud__card">
              <h4>Editar o eliminar categoria</h4>
              <select className="admin-crud__select" value={selectedCategoryId} onChange={(e) => setSelectedCategoryId(e.target.value)}>
                <option value="">Selecciona categoria</option>
                {categories.map((c) => (
                  <option key={c.id || c.Id_Categoria} value={c.id || c.Id_Categoria}>{c.nombre || c.Nombre}</option>
                ))}
              </select>
              <div className="admin-crud__actions">
                <button className="admin-crud__btn warning" type="button" onClick={handleUpdateCategory}>Actualizar</button>
                <button className="admin-crud__btn danger" type="button" onClick={handleDeleteCategory}>Eliminar</button>
              </div>
            </section>

            <section className="admin-crud__card">
              <h4>Listado de categorias</h4>
              {categories.map((c) => (
                <div className="admin-crud__row" key={c.id || c.Id_Categoria}>
                  <div className="admin-crud__row-title">{c.nombre || c.Nombre}</div>
                  <div className="admin-crud__meta">ID: {c.id || c.Id_Categoria}</div>
                </div>
              ))}
            </section>
          </>
        )}

        {activeTab === 'usuarios' && canManageUsers && (
          <>
            <section className="admin-crud__card">
              <h4>Crear usuario</h4>
              <div className="admin-crud__grid">
                <input className="admin-crud__input" placeholder="Nombre" value={userForm.nombre} onChange={(e) => setUserForm((u) => ({ ...u, nombre: e.target.value }))} />
                <input className="admin-crud__input" placeholder="Apellido paterno" value={userForm.apellidoPaterno} onChange={(e) => setUserForm((u) => ({ ...u, apellidoPaterno: e.target.value }))} />
                <input className="admin-crud__input" placeholder="Apellido materno" value={userForm.apellidoMaterno} onChange={(e) => setUserForm((u) => ({ ...u, apellidoMaterno: e.target.value }))} />
                <input className="admin-crud__input" placeholder="Telefono" value={userForm.telefono} onChange={(e) => setUserForm((u) => ({ ...u, telefono: e.target.value }))} />
                <input className="admin-crud__input" placeholder="Correo" type="email" value={userForm.correo} onChange={(e) => setUserForm((u) => ({ ...u, correo: e.target.value }))} />
                <select className="admin-crud__select" value={userForm.rol} onChange={(e) => setUserForm((u) => ({ ...u, rol: e.target.value }))}>
                  <option value="usuario">Usuario</option>
                  <option value="admin">Admin</option>
                  <option value="superusuario">Superusuario</option>
                </select>
              </div>
              <input className="admin-crud__input" placeholder="Contrasena" type="password" value={userForm.contrasena} onChange={(e) => setUserForm((u) => ({ ...u, contrasena: e.target.value }))} />
              <div className="admin-crud__actions">
                <button className="admin-crud__btn primary" type="button" onClick={handleCreateUser}>Crear</button>
              </div>
            </section>

            <section className="admin-crud__card">
              <h4>Editar o eliminar usuario</h4>
              <select className="admin-crud__select" value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
                <option value="">Selecciona usuario</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.nombre} ({u.correo})</option>
                ))}
              </select>
              <p className="admin-crud__meta">Para cambiar contrasena, escribe una nueva; si lo dejas vacio, no se modifica.</p>
              <div className="admin-crud__actions">
                <button className="admin-crud__btn warning" type="button" onClick={handleUpdateUser}>Actualizar</button>
                <button className="admin-crud__btn danger" type="button" onClick={handleDeleteUser} disabled={currentRole !== 'superusuario'}>Eliminar</button>
              </div>
              {currentRole !== 'superusuario' ? (
                <p className="admin-crud__meta">Solo un superusuario puede eliminar cualquier tipo de usuario.</p>
              ) : null}
            </section>

            <section className="admin-crud__card">
              <h4>Listado de usuarios</h4>
              {users.slice(0, 20).map((u) => (
                <div className="admin-crud__row" key={u.id}>
                  <div className="admin-crud__row-title">{u.nombre} {u.apellidoPaterno}</div>
                  <div className="admin-crud__meta">{u.correo} | Rol: {String(u.rol || '').toLowerCase()}</div>
                </div>
              ))}
            </section>
          </>
        )}

        {activeTab === 'publicidad' && (
          <>
            <section className="admin-crud__card">
              <h4>Activar campana premium</h4>
              <div className="admin-crud__grid">
                <select className="admin-crud__select" value={adForm.productoId} onChange={(e) => setAdForm((p) => ({ ...p, productoId: e.target.value }))}>
                  <option value="">Producto</option>
                  {adProducts.map((p) => (
                    <option key={p.id} value={p.id}>{p.nombre}</option>
                  ))}
                </select>
                <select className="admin-crud__select" value={adForm.posicion} onChange={(e) => setAdForm((p) => ({ ...p, posicion: e.target.value }))}>
                  <option value="grid">Grid</option>
                  <option value="top1">Top1</option>
                  <option value="hero">Hero</option>
                </select>
                <input className="admin-crud__input" type="number" min="1" max="30" placeholder="Dias" value={adForm.dias} onChange={(e) => setAdForm((p) => ({ ...p, dias: e.target.value }))} />
                <input className="admin-crud__input" type="number" min="0" max="10" placeholder="Prioridad extra" value={adForm.prioridadExtra} onChange={(e) => setAdForm((p) => ({ ...p, prioridadExtra: e.target.value }))} />
                <select className="admin-crud__select" value={adForm.cardId} onChange={(e) => setAdForm((p) => ({ ...p, cardId: e.target.value }))}>
                  <option value="">Tarjeta</option>
                  {adCards.map((c) => (
                    <option key={c.id} value={c.id}>{c.marca || 'Tarjeta'} {c.numero || ''}</option>
                  ))}
                </select>
              </div>
              <p className="admin-crud__meta">{adQuote.planLabel} - {adQuote.days} dia(s) - Subtotal ${adQuote.subtotal.toFixed(2)} - Descuento ${adQuote.discount.toFixed(2)} - Total ${adQuote.total.toFixed(2)} MXN</p>
              <div className="admin-crud__actions">
                <button className="admin-crud__btn primary" type="button" onClick={handlePayCampaign} disabled={adProcessing}>
                  {adProcessing ? 'Procesando...' : 'Pagar y activar'}
                </button>
              </div>
            </section>

            <section className="admin-crud__card">
              <h4>Planes disponibles</h4>
              {adPlans.map((plan) => (
                <div className="admin-crud__row" key={plan.key}>
                  <div className="admin-crud__row-title">{plan.label}</div>
                  <div className="admin-crud__meta">${Number(plan.pricePerDay || 0).toFixed(2)} MXN por dia - 3 dias desde ${Number(plan.quote3Days?.total || 0).toFixed(2)}</div>
                </div>
              ))}
            </section>

            <section className="admin-crud__card">
              <h4>Campanas y metricas</h4>
              {adCampaigns.length === 0 ? <p className="admin-crud__meta">No hay campanas registradas.</p> : null}
              {adCampaigns.slice(0, 25).map((c) => (
                <div className="admin-crud__row" key={c.id}>
                  <div className="admin-crud__row-title">{c.productoNombre}</div>
                  <div className="admin-crud__meta">
                    {String(c.posicion || 'grid').toUpperCase()} | Estado: {c.estado} | Impresiones: {Number(c.impresiones || 0)} | Clicks: {Number(c.clicks || 0)} | CTR: {Number(c.ctr || 0).toFixed(2)}%
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}


