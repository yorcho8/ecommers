/**
 * EmpresasTab.jsx
 * Tab exclusivo para SuperAdmin en el AdminPanel.
 * CRUD completo de empresas: listar, crear (+ admin user), editar y eliminar.
 */
import React, { useState, useEffect, useCallback } from "react";

const SUPER_KEY = "GOSUPER2026";

// -- Paleta (misma que AdminPanel) -------------------------------------------
const C = {
  bg:        "#080808",
  surface:   "#111111",
  surface2:  "#161616",
  surface3:  "#1c1c1c",
  border:    "rgba(255,255,255,0.07)",
  border2:   "rgba(255,255,255,0.04)",
  text:      "rgba(255,255,255,0.92)",
  textSub:   "rgba(255,255,255,0.45)",
  textDim:   "rgba(255,255,255,0.22)",
  orange:    "#7A2532",
  orangeDim: "rgba(122,37,50,0.10)",
  green:     "#22C55E",
  greenDim:  "rgba(34,197,94,0.08)",
  blue:      "#3B82F6",
  blueDim:   "rgba(59,130,246,0.08)",
  purple:    "#8B5CF6",
  red:       "#EF4444",
  redDim:    "rgba(239,68,68,0.08)",
  amber:     "#F59E0B",
  amberDim:  "rgba(245,158,11,0.08)",
};
const T = {
  sans: "'DM Sans', system-ui, sans-serif",
  mono: "'DM Mono', monospace",
};

// -- Mini helpers de UI -------------------------------------------------------
const Label = ({ children }) => (
  <label style={{ color: C.textDim, fontSize: 10, fontFamily: T.sans, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 500, display: "block", marginBottom: 5 }}>
    {children}
  </label>
);

const InputField = ({ label, ...props }) => (
  <div style={{ marginBottom: 14 }}>
    <Label>{label}</Label>
    <input
      {...props}
      style={{
        width: "100%", background: C.surface2, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 13,
        outline: "none", fontFamily: T.sans, transition: "border-color 0.15s",
        boxSizing: "border-box",
        ...(props.style || {}),
      }}
      onFocus={e => e.target.style.borderColor = "rgba(255,255,255,0.25)"}
      onBlur={e  => e.target.style.borderColor = C.border}
    />
  </div>
);

const TextareaField = ({ label, ...props }) => (
  <div style={{ marginBottom: 14 }}>
    <Label>{label}</Label>
    <textarea
      {...props}
      rows={2}
      style={{
        width: "100%", background: C.surface2, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 13,
        outline: "none", fontFamily: T.sans, resize: "vertical", transition: "border-color 0.15s",
        boxSizing: "border-box",
        ...(props.style || {}),
      }}
      onFocus={e => e.target.style.borderColor = "rgba(255,255,255,0.25)"}
      onBlur={e  => e.target.style.borderColor = C.border}
    />
  </div>
);

const Btn = ({ children, onClick, variant = "default", disabled, style: s }) => {
  const variants = {
    default:  { bg: "rgba(255,255,255,0.07)", color: C.text,    border: C.border },
    primary:  { bg: "rgba(255,255,255,0.92)", color: "#0a0a0a", border: "transparent" },
    danger:   { bg: C.redDim,   color: C.red,   border: `${C.red}30` },
    success:  { bg: C.greenDim, color: C.green, border: `${C.green}30` },
    ghost:    { bg: "transparent", color: C.textSub, border: "transparent" },
  };
  const v = variants[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600,
        fontFamily: T.sans, cursor: disabled ? "not-allowed" : "pointer",
        background: v.bg, color: v.color, border: `1px solid ${v.border}`,
        opacity: disabled ? 0.45 : 1,
        transition: "all 0.15s ease", whiteSpace: "nowrap",
        ...(s || {}),
      }}
    >
      {children}
    </button>
  );
};

const StatusBadge = ({ estado }) => {
  const map = {
    activo:    { bg: C.greenDim, color: C.green,  label: "Activo" },
    inactivo:  { bg: C.amberDim, color: C.amber,  label: "Inactivo" },
    suspendido:{ bg: C.redDim,   color: C.red,    label: "Suspendido" },
  };
  const s = map[estado] || map.inactivo;
  return (
    <span style={{ padding: "2px 8px", borderRadius: 20, background: s.bg, color: s.color, fontSize: 10, fontWeight: 600, fontFamily: T.sans }}>
      {s.label}
    </span>
  );
};

// -- Spinner ------------------------------------------------------------------
const Spin = () => (
  <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.1)", borderTop: `2px solid ${C.orange}`, animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
);

// -- Modal wrapper -------------------------------------------------------------
function Modal({ onClose, title, children, width = 560 }) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000100,
        background: "rgba(0,0,0,0.75)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
        width: "100%", maxWidth: width, maxHeight: "92vh", overflowY: "auto",
        boxShadow: "0 40px 80px rgba(0,0,0,0.95)",
        animation: "fadeUp 0.28s cubic-bezier(0.16,1,0.3,1) both",
      }}>
        <div style={{ padding: "18px 22px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: T.sans, fontWeight: 600, fontSize: 14, color: C.text }}>{title}</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontSize: 16, padding: "2px 6px" }}>x</button>
        </div>
        <div style={{ padding: "20px 22px 24px" }}>{children}</div>
      </div>
    </div>
  );
}

// -- Confirmacion de alta (sin exponer password) ------------------------------
function EmpresaCreadaCard({ empresa, onClose }) {
  return (
    <Modal onClose={onClose} title="Solicitud registrada" width={480}>
      <div style={{ marginBottom: 16, padding: "14px 16px", background: C.greenDim, border: `1px solid ${C.green}30`, borderRadius: 8 }}>
        <p style={{ color: C.green, fontSize: 12, fontFamily: T.sans, fontWeight: 600, marginBottom: 4 }}>Solicitud registrada correctamente</p>
        <p style={{ color: C.textSub, fontSize: 11, fontFamily: T.sans }}>La credencial de acceso se enviara por correo al administrador al aprobar la solicitud.</p>
      </div>

      {[
        { label: "Empresa",     value: empresa },
        { label: "Estado",      value: "Pendiente de revision" },
        { label: "Entrega de credenciales", value: "Solo por correo" },
      ].map(({ label, value, mono }) => (
        <div key={label} style={{ marginBottom: 10, padding: "10px 14px", background: C.surface2, borderRadius: 8, border: `1px solid ${C.border2}` }}>
          <div style={{ color: C.textDim, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: T.sans, marginBottom: 3 }}>{label}</div>
          <div style={{ color: C.text, fontSize: 13, fontFamily: mono ? T.mono : T.sans, fontWeight: mono ? 500 : 400, letterSpacing: mono ? "0.04em" : 0 }}>{value}</div>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <Btn onClick={onClose}>Cerrar</Btn>
      </div>
    </Modal>
  );
}

// -- Formulario: Crear empresa -------------------------------------------------
const EMPTY_FORM = {
  nombre_empresa: "", rfc: "", descripcion: "", logo_url: "", sitio_web: "",
  admin_nombre: "", admin_apellido: "", admin_correo: "", admin_telefono: "",
};

function CrearEmpresaModal({ onClose, onCreated }) {
  const [form, setForm]   = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSubmit = async () => {
    setError("");
    if (!form.nombre_empresa.trim() || !form.admin_nombre.trim() || !form.admin_apellido.trim() || !form.admin_correo.trim()) {
      setError("Los campos marcados con * son obligatorios");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/admin/empresas", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": SUPER_KEY },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!data.success) { setError(data.error || "Error desconocido"); return; }

      onCreated(data.empresa?.nombre || form.nombre_empresa || "Empresa");
    } catch {
      setError("Error de red. Intenta de nuevo.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Nueva Empresa" width={600}>
      {error && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: C.redDim, border: `1px solid ${C.red}30`, borderRadius: 8, color: C.red, fontSize: 12, fontFamily: T.sans }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: 6 }}>
        <span style={{ color: C.orange, fontSize: 11, fontFamily: T.sans, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Datos de la Empresa</span>
        <div style={{ height: 1, background: C.border, margin: "8px 0 14px" }} />
      </div>

      <InputField label="Nombre de la empresa *" value={form.nombre_empresa} onChange={e => set("nombre_empresa", e.target.value)} placeholder="Ej. Distribuidora XYZ S.A. de C.V." />
      <InputField label="RFC" value={form.rfc} onChange={e => set("rfc", e.target.value)} placeholder="Ej. XYZ240101ABC" />
      <InputField label="Sitio web" value={form.sitio_web} onChange={e => set("sitio_web", e.target.value)} placeholder="https://empresa.com" />
      <TextareaField label="Descripción" value={form.descripcion} onChange={e => set("descripcion", e.target.value)} placeholder="Breve descripción de la empresa" />

      <div style={{ height: 1, background: C.border, margin: "4px 0 18px" }} />
      <span style={{ color: C.blue, fontSize: 11, fontFamily: T.sans, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Administrador de la Empresa</span>
      <div style={{ height: 1, background: C.border, margin: "8px 0 14px" }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <InputField label="Nombre *" value={form.admin_nombre} onChange={e => set("admin_nombre", e.target.value)} placeholder="Juan" />
        <InputField label="Apellido *" value={form.admin_apellido} onChange={e => set("admin_apellido", e.target.value)} placeholder="Pérez" />
      </div>
      <InputField label="Correo electrónico *" value={form.admin_correo} onChange={e => set("admin_correo", e.target.value)} placeholder="admin@empresa.com" type="email" />
      <InputField label="Teléfono" value={form.admin_telefono} onChange={e => set("admin_telefono", e.target.value)} placeholder="+52 55 0000 0000" />

      <div style={{ padding: "10px 14px", background: C.amberDim, border: `1px solid ${C.amber}30`, borderRadius: 8, marginBottom: 18 }}>
        <p style={{ color: C.amber, fontSize: 11, fontFamily: T.sans }}>
          Las credenciales de acceso no se muestran en pantalla: se envian por correo al aprobar la solicitud.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="primary" onClick={handleSubmit} disabled={loading}>
          {loading ? <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Spin /> Creando...</span> : "Crear Empresa"}
        </Btn>
      </div>
    </Modal>
  );
}

// -- Formulario: Editar empresa ------------------------------------------------
function EditarEmpresaModal({ empresa, onClose, onUpdated }) {
  const [form, setForm]   = useState({
    nombre_empresa: empresa.Nombre_Empresa || "",
    rfc:            empresa.RFC            || "",
    descripcion:    empresa.Descripcion    || "",
    logo_url:       empresa.Logo_URL       || "",
    sitio_web:      empresa.Sitio_Web      || "",
    estado:         empresa.Estado         || "activo",
  });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSubmit = async () => {
    setError("");
    if (!form.nombre_empresa.trim()) { setError("El nombre es obligatorio"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/admin/empresas", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-key": SUPER_KEY },
        body: JSON.stringify({ id: empresa.Id_Empresa, ...form }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || "Error desconocido"); return; }
      onUpdated();
    } catch {
      setError("Error de red.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`Editar - ${empresa.Nombre_Empresa}`} width={560}>
      {error && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: C.redDim, border: `1px solid ${C.red}30`, borderRadius: 8, color: C.red, fontSize: 12, fontFamily: T.sans }}>
          {error}
        </div>
      )}

      <InputField label="Nombre de la empresa *" value={form.nombre_empresa} onChange={e => set("nombre_empresa", e.target.value)} />
      <InputField label="RFC" value={form.rfc} onChange={e => set("rfc", e.target.value)} />
      <InputField label="Sitio web" value={form.sitio_web} onChange={e => set("sitio_web", e.target.value)} />
      <InputField label="Logo URL" value={form.logo_url} onChange={e => set("logo_url", e.target.value)} />
      <TextareaField label="Descripción" value={form.descripcion} onChange={e => set("descripcion", e.target.value)} />

      <div style={{ marginBottom: 14 }}>
        <Label>Estado</Label>
        <select
          value={form.estado}
          onChange={e => set("estado", e.target.value)}
          style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 13, fontFamily: T.sans, outline: "none" }}
        >
          <option value="activo">Activo</option>
          <option value="inactivo">Inactivo</option>
          <option value="suspendido">Suspendido</option>
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="primary" onClick={handleSubmit} disabled={loading}>
          {loading ? <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Spin /> Guardando...</span> : "Guardar cambios"}
        </Btn>
      </div>
    </Modal>
  );
}

// -- Tabla de empresas ---------------------------------------------------------
function EmpresaRow({ empresa, onEdit, onDelete }) {
  const fecha = empresa.Fecha_Creacion
    ? new Date(empresa.Fecha_Creacion).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" })
    : "-";

  return (
    <tr style={{ borderBottom: `1px solid ${C.border2}` }}>
      <td style={{ padding: "12px 14px", fontFamily: T.sans, fontSize: 13, color: C.text, fontWeight: 500 }}>
        {empresa.Logo_URL
          ? <img src={empresa.Logo_URL} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: "cover", marginRight: 8, verticalAlign: "middle" }} />
          : null}
        {empresa.Nombre_Empresa}
      </td>
      <td style={{ padding: "12px 14px", fontFamily: T.mono, fontSize: 11, color: C.textSub }}>{empresa.RFC || "-"}</td>
      <td style={{ padding: "12px 14px" }}>
        <StatusBadge estado={empresa.Estado} />
      </td>
      <td style={{ padding: "12px 14px", fontFamily: T.sans, fontSize: 12, color: C.textSub }}>
        <div>{empresa.Usuario_Nombre} {empresa.Usuario_Apellido}</div>
        <div style={{ color: C.blue, fontSize: 11, fontFamily: T.mono }}>{empresa.Usuario_Correo}</div>
      </td>
      <td style={{ padding: "12px 14px", fontFamily: T.mono, fontSize: 11, color: C.textDim }}>{fecha}</td>
      <td style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn onClick={() => onEdit(empresa)} style={{ padding: "5px 12px", fontSize: 11 }}>Editar</Btn>
          <Btn variant="danger" onClick={() => onDelete(empresa)} style={{ padding: "5px 12px", fontSize: 11 }}>Eliminar</Btn>
        </div>
      </td>
    </tr>
  );
}

// -- Confirmar eliminar --------------------------------------------------------
function ConfirmDeleteModal({ empresa, onClose, onConfirm, loading }) {
  return (
    <Modal onClose={onClose} title="Confirmar eliminación" width={420}>
      <p style={{ color: C.text, fontSize: 13, fontFamily: T.sans, marginBottom: 8 }}>
        ¿Eliminar la empresa <strong>{empresa.Nombre_Empresa}</strong>?
      </p>
      <p style={{ color: C.textSub, fontSize: 12, fontFamily: T.sans, marginBottom: 20, lineHeight: 1.6 }}>
        Esta accion es irreversible. Se eliminaran tambien las sucursales asociadas. El usuario administrador permanecera en el sistema.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={loading}>Cancelar</Btn>
        <Btn variant="danger" onClick={onConfirm} disabled={loading}>
          {loading ? <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Spin /> Eliminando...</span> : "Sí, eliminar"}
        </Btn>
      </div>
    </Modal>
  );
}

// -- Componente principal ------------------------------------------------------
export default function EmpresasTab() {
  const [empresas,    setEmpresas]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState("");
  const [search,      setSearch]      = useState("");

  const [showCrear,   setShowCrear]   = useState(false);
  const [editTarget,  setEditTarget]  = useState(null);
  const [deleteTarget,setDeleteTarget]= useState(null);
  const [deletingId,  setDeletingId]  = useState(null);

  // Confirmacion visual tras crear
  const [createdEmpresa, setCreatedEmpresa] = useState(null);

  const fetchEmpresas = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res  = await fetch("/api/admin/empresas", { headers: { "x-admin-key": SUPER_KEY } });
      const data = await res.json();
      if (data.success) setEmpresas(data.empresas || []);
      else setError(data.error || "Error al cargar empresas");
    } catch {
      setError("Error de red al cargar empresas");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchEmpresas(); }, []);

  const handleCreated = (empresa) => {
    setShowCrear(false);
    setCreatedEmpresa(empresa);
    fetchEmpresas();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.Id_Empresa);
    try {
      const res  = await fetch("/api/admin/empresas", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-admin-key": SUPER_KEY },
        body: JSON.stringify({ id: deleteTarget.Id_Empresa }),
      });
      const data = await res.json();
      if (data.success) { setDeleteTarget(null); fetchEmpresas(); }
      else setError(data.error || "Error al eliminar");
    } catch {
      setError("Error de red al eliminar");
    } finally {
      setDeletingId(null);
    }
  };

  const CARD = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" };
  const filtered = empresas.filter(e =>
    !search.trim() ||
    e.Nombre_Empresa.toLowerCase().includes(search.toLowerCase()) ||
    (e.RFC || "").toLowerCase().includes(search.toLowerCase()) ||
    (e.Usuario_Correo || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="tab-content" style={{ maxWidth: 1100 }}>
      {/* Modales */}
      {showCrear && (
        <CrearEmpresaModal onClose={() => setShowCrear(false)} onCreated={handleCreated} />
      )}
      {editTarget && (
        <EditarEmpresaModal
          empresa={editTarget}
          onClose={() => setEditTarget(null)}
          onUpdated={() => { setEditTarget(null); fetchEmpresas(); }}
        />
      )}
      {deleteTarget && (
        <ConfirmDeleteModal
          empresa={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          loading={!!deletingId}
        />
      )}
      {createdEmpresa && (
        <EmpresaCreadaCard
          empresa={createdEmpresa}
          onClose={() => setCreatedEmpresa(null)}
        />
      )}

      {/* Header de seccion */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ color: C.text, fontSize: 15, fontFamily: T.sans, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" }}>Empresas</h2>
          <p style={{ color: C.textDim, fontSize: 11, fontFamily: T.sans, margin: "3px 0 0" }}>
            {loading ? "Cargando..." : `${empresas.length} empresa${empresas.length !== 1 ? "s" : ""} registrada${empresas.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <Btn variant="primary" onClick={() => setShowCrear(true)}>+ Nueva Empresa</Btn>
      </div>

      {error && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: C.redDim, border: `1px solid ${C.red}30`, borderRadius: 8, color: C.red, fontSize: 12, fontFamily: T.sans }}>
          {error}
        </div>
      )}

      {/* Stats rapidos */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginBottom: 16 }}>
        {[
          { label: "Total empresas",  value: empresas.length,                                             color: C.orange },
          { label: "Activas",         value: empresas.filter(e => e.Estado === "activo").length,           color: C.green  },
          { label: "Inactivas",       value: empresas.filter(e => e.Estado === "inactivo").length,         color: C.amber  },
          { label: "Suspendidas",     value: empresas.filter(e => e.Estado === "suspendido").length,       color: C.red    },
        ].map(s => (
          <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ color: C.textDim, fontSize: 10, fontFamily: T.sans, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>{s.label}</div>
            <div style={{ color: s.color, fontSize: 22, fontFamily: T.mono, fontWeight: 500 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Buscador */}
      <input
        type="text"
        placeholder="Buscar empresa, RFC o correo del admin..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          width: "100%", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: "9px 14px", color: C.text, fontSize: 12, outline: "none", fontFamily: T.sans,
          marginBottom: 12, boxSizing: "border-box", transition: "border-color 0.15s",
        }}
        onFocus={e => e.target.style.borderColor = "rgba(255,255,255,0.2)"}
        onBlur={e  => e.target.style.borderColor = C.border}
      />

      {/* Tabla */}
      <div style={CARD}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
            <Spin />
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.surface2 }}>
                  {["Empresa", "RFC", "Estado", "Administrador", "Creación", "Acciones"].map(h => (
                    <th key={h} style={{
                      padding: "10px 14px", textAlign: "left", color: C.textDim, fontSize: 10,
                      fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.07em",
                      fontFamily: T.sans, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length > 0 ? (
                  filtered.map(e => (
                    <EmpresaRow
                      key={e.Id_Empresa}
                      empresa={e}
                      onEdit={setEditTarget}
                      onDelete={setDeleteTarget}
                    />
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} style={{ padding: "48px 0", textAlign: "center", color: C.textDim, fontFamily: T.sans, fontSize: 12 }}>
                      {search ? "Sin resultados para esa búsqueda" : "Aún no hay empresas registradas"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}



