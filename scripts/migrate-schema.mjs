import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN,
});

if (!process.env.ECOMERS_DATABASE_URL || !process.env.ECOMERS_AUTH_TOKEN) {
  console.error("[migrate-schema] Missing ECOMERS_DATABASE_URL or ECOMERS_AUTH_TOKEN");
  process.exit(1);
}

async function executeSafe(sql) {
  try {
    await db.execute({ sql, args: [] });
  } catch (error) {
    const msg = String(error?.message || "").toLowerCase();
    const ignorable =
      msg.includes("already exists") ||
      msg.includes("duplicate") ||
      msg.includes("duplicate column");
    if (!ignorable) throw error;
  }
}

async function migrateOperationalTables() {
  const statements = [
    // Core carrito/user/payment compatibility columns
    "ALTER TABLE Carrito ADD COLUMN Ultima_Actividad TEXT",
    "ALTER TABLE Carrito ADD COLUMN Email_Abandono_Enviado TEXT",
    "ALTER TABLE Usuario ADD COLUMN Requires_Password_Change INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE Usuario ADD COLUMN TwoFactor_Enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE Usuario ADD COLUMN TwoFactor_Channel TEXT DEFAULT 'email'",

    // Email verification/auth state (separated from Usuario)
    `CREATE TABLE IF NOT EXISTS UsuarioEmailAuth (
      Id_Usuario INTEGER PRIMARY KEY,
      Email_Verified INTEGER NOT NULL DEFAULT 1,
      Email_Verification_Token TEXT,
      Email_Verification_Expires TEXT,
      Updated_At TEXT NOT NULL,
      FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE CASCADE
    )`,
    "CREATE INDEX IF NOT EXISTS idx_user_emailauth_verified ON UsuarioEmailAuth(Email_Verified)",
    "CREATE INDEX IF NOT EXISTS idx_user_emailauth_token ON UsuarioEmailAuth(Email_Verification_Token)",

    // Payment / shipping compatibility columns
    "ALTER TABLE Pago ADD COLUMN ID_Tarjeta INTEGER",
    "ALTER TABLE Pago ADD COLUMN Marca_Tarjeta TEXT",
    "ALTER TABLE Pago ADD COLUMN Tipo_Financiamiento TEXT",
    "ALTER TABLE Pago ADD COLUMN Ultimos4 TEXT",
    "ALTER TABLE Pago ADD COLUMN Estado_Reembolso TEXT",
    "ALTER TABLE Pago ADD COLUMN Stripe_Refund_Id TEXT",
    "ALTER TABLE Pago ADD COLUMN Fecha_Reembolso TEXT",
    "ALTER TABLE Envio ADD COLUMN Carrier TEXT",
    "ALTER TABLE Envio ADD COLUMN Service TEXT",

    // Devoluciones
    `CREATE TABLE IF NOT EXISTS DevolucionPedido (
      Id_Devolucion INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Pedido INTEGER NOT NULL,
      Estado TEXT NOT NULL DEFAULT 'solicitada',
      Carrier TEXT,
      Service TEXT,
      Numero_Guia TEXT,
      Label_URL TEXT,
      Track_URL TEXT,
      Fecha_Limite TEXT,
      Fecha_Creacion TEXT NOT NULL,
      Fecha_Actualizacion TEXT NOT NULL,
      FOREIGN KEY (Id_Pedido) REFERENCES Pedido(Id_Pedido) ON DELETE CASCADE
    )`,
    "CREATE INDEX IF NOT EXISTS idx_devolucion_pedido ON DevolucionPedido(Id_Pedido, Fecha_Creacion DESC)",

    // Favoritos
    `CREATE TABLE IF NOT EXISTS Favorito (
      Id_Favorito    INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Usuario     INTEGER NOT NULL,
      Id_Producto    INTEGER NOT NULL,
      Fecha_Creacion TEXT NOT NULL,
      UNIQUE (Id_Usuario, Id_Producto),
      FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE CASCADE,
      FOREIGN KEY (Id_Producto) REFERENCES Producto(Id_Producto) ON DELETE CASCADE
    )`,
    "CREATE INDEX IF NOT EXISTS idx_favorito_usuario ON Favorito(Id_Usuario, Fecha_Creacion DESC)",

    // Feedback / quejas
    `CREATE TABLE IF NOT EXISTS QuejaSugerencia (
      Id_Feedback INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Usuario INTEGER,
      Tipo TEXT NOT NULL,
      Asunto TEXT NOT NULL,
      Mensaje TEXT NOT NULL,
      Categoria TEXT NOT NULL DEFAULT 'general',
      Canal_Respuesta TEXT NOT NULL DEFAULT 'ticket',
      Estado TEXT NOT NULL DEFAULT 'nuevo',
      Origen TEXT NOT NULL DEFAULT 'web',
      Fecha_Creacion TEXT NOT NULL,
      Fecha_Actualizacion TEXT NOT NULL,
      FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE SET NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_feedback_estado_fecha ON QuejaSugerencia(Estado, Fecha_Creacion DESC)",
    "CREATE INDEX IF NOT EXISTS idx_feedback_usuario_fecha ON QuejaSugerencia(Id_Usuario, Fecha_Creacion DESC)",

    // Security codes
    `CREATE TABLE IF NOT EXISTS UserSecurityCode (
      Id_Code INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Usuario INTEGER NOT NULL,
      Proposito TEXT NOT NULL DEFAULT 'password_change',
      Canal TEXT NOT NULL,
      Destino TEXT NOT NULL,
      CodigoHash TEXT NOT NULL,
      Expira_En TEXT NOT NULL,
      Usado INTEGER NOT NULL DEFAULT 0,
      Intentos INTEGER NOT NULL DEFAULT 0,
      Fecha_Creacion TEXT NOT NULL
    )`,

    // Discounts
    `CREATE TABLE IF NOT EXISTS Descuento (
      Id_Descuento INTEGER PRIMARY KEY AUTOINCREMENT,
      Nombre TEXT NOT NULL,
      Tipo TEXT NOT NULL DEFAULT 'porcentaje',
      Valor REAL NOT NULL,
      Fecha_Inicio TEXT NOT NULL,
      Fecha_Fin TEXT NOT NULL,
      Activo INTEGER NOT NULL DEFAULT 1,
      Aplica_A TEXT NOT NULL DEFAULT 'producto',
      Fecha_Creacion TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS DescuentoProducto (
      Id_Descuento INTEGER NOT NULL,
      Id_Producto INTEGER NOT NULL,
      PRIMARY KEY (Id_Descuento, Id_Producto),
      FOREIGN KEY (Id_Descuento) REFERENCES Descuento(Id_Descuento) ON DELETE CASCADE,
      FOREIGN KEY (Id_Producto) REFERENCES Producto(Id_Producto) ON DELETE CASCADE
    )`,
    "CREATE INDEX IF NOT EXISTS idx_descuento_activo ON Descuento(Activo)",
    "CREATE INDEX IF NOT EXISTS idx_descuento_fechas ON Descuento(Fecha_Inicio, Fecha_Fin)",
    "CREATE INDEX IF NOT EXISTS idx_desc_prod_prod ON DescuentoProducto(Id_Producto)",

    // Facturacion pedidos
    `CREATE TABLE IF NOT EXISTS Factura (
      Id_Factura INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Pedido INTEGER NOT NULL,
      Id_Usuario INTEGER NOT NULL,
      Facturama_Id TEXT,
      UUID TEXT,
      RFC_Receptor TEXT,
      Nombre_Receptor TEXT,
      Uso_CFDI TEXT,
      Regimen_Fiscal TEXT,
      CP_Fiscal TEXT,
      Total REAL,
      Fecha_Emision TEXT,
      Estado TEXT NOT NULL DEFAULT 'vigente',
      Fecha_Creacion TEXT NOT NULL,
      FOREIGN KEY (Id_Pedido) REFERENCES Pedido(Id_Pedido) ON DELETE CASCADE,
      FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE CASCADE
    )`,

    // Facturacion publicidad
    `CREATE TABLE IF NOT EXISTS FacturaPublicidad (
      Id_FacturaPublicidad INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Campana INTEGER NOT NULL,
      Id_Empresa INTEGER,
      Facturama_Id TEXT,
      UUID TEXT,
      RFC_Receptor TEXT,
      Nombre_Receptor TEXT,
      Uso_CFDI TEXT,
      Regimen_Fiscal TEXT,
      CP_Fiscal TEXT,
      Total REAL,
      Fecha_Emision TEXT,
      Estado TEXT NOT NULL DEFAULT 'vigente',
      Fecha_Creacion TEXT NOT NULL,
      FOREIGN KEY (Id_Campana) REFERENCES PublicidadCampana(Id_Publicidad) ON DELETE CASCADE
    )`,

    // Incidencias de pedidos
    `CREATE TABLE IF NOT EXISTS PedidoIncidencia (
      Id_Incidencia INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Pedido INTEGER NOT NULL,
      Id_Usuario INTEGER NOT NULL,
      Motivo TEXT NOT NULL,
      Prioridad TEXT NOT NULL DEFAULT 'media',
      Descripcion TEXT NOT NULL,
      Estado TEXT NOT NULL DEFAULT 'pendiente',
      Veredicto TEXT,
      Comentario_Veredicto TEXT,
      Fecha_Referencia_Entrega TEXT NOT NULL,
      Fecha_Limite_Reporte TEXT NOT NULL,
      Fecha_Creacion TEXT NOT NULL,
      Fecha_Resolucion TEXT,
      Resuelto_Por INTEGER,
      FOREIGN KEY (Id_Pedido) REFERENCES Pedido(Id_Pedido) ON DELETE CASCADE,
      FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE CASCADE,
      FOREIGN KEY (Resuelto_Por) REFERENCES Usuario(Id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS PedidoIncidenciaImagen (
      Id_Imagen INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Incidencia INTEGER NOT NULL,
      URL_Imagen TEXT NOT NULL,
      Public_ID TEXT,
      Fecha_Creacion TEXT NOT NULL,
      FOREIGN KEY (Id_Incidencia) REFERENCES PedidoIncidencia(Id_Incidencia) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS PedidoIncidenciaBitacora (
      Id_Log INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Incidencia INTEGER NOT NULL,
      Accion TEXT NOT NULL,
      Detalle TEXT,
      Id_Actor INTEGER,
      Fecha_Creacion TEXT NOT NULL,
      FOREIGN KEY (Id_Incidencia) REFERENCES PedidoIncidencia(Id_Incidencia) ON DELETE CASCADE,
      FOREIGN KEY (Id_Actor) REFERENCES Usuario(Id) ON DELETE SET NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_pedido_incidencia_estado ON PedidoIncidencia(Estado, Fecha_Creacion DESC)",
    "CREATE INDEX IF NOT EXISTS idx_pedido_incidencia_pedido ON PedidoIncidencia(Id_Pedido, Fecha_Creacion DESC)",
    "CREATE INDEX IF NOT EXISTS idx_pedido_incidencia_usuario ON PedidoIncidencia(Id_Usuario, Fecha_Creacion DESC)",
    "CREATE INDEX IF NOT EXISTS idx_pedido_incidencia_img ON PedidoIncidenciaImagen(Id_Incidencia)",
    "CREATE INDEX IF NOT EXISTS idx_pedido_incidencia_log ON PedidoIncidenciaBitacora(Id_Incidencia, Fecha_Creacion DESC)",

    // Empresa / KYC / biometria
    `CREATE TABLE IF NOT EXISTS EmpresaSolicitud (
      Id_Solicitud INTEGER PRIMARY KEY AUTOINCREMENT,
      Nombre_Empresa TEXT NOT NULL,
      RFC TEXT,
      Descripcion TEXT,
      Logo_URL TEXT,
      Sitio_Web TEXT,
      Razon_Social TEXT,
      Regimen_Fiscal TEXT,
      Codigo_Postal_Fiscal TEXT,
      Domicilio_Numero_Casa INTEGER,
      Domicilio_Calle TEXT,
      Domicilio_Codigo_Postal INTEGER,
      Domicilio_Ciudad TEXT,
      Domicilio_Provincia TEXT,
      Domicilio_Pais TEXT,
      Domicilio_Nombre TEXT,
      Sucursal_Nombre TEXT,
      Sucursal_Telefono TEXT,
      Admin_Nombre TEXT NOT NULL,
      Admin_Apellido TEXT NOT NULL,
      Admin_Apellido_Materno TEXT,
      Admin_Correo TEXT NOT NULL,
      Admin_Telefono TEXT,
      Documentos_JSON TEXT NOT NULL,
      Estado TEXT NOT NULL DEFAULT 'pendiente',
      Motivo_Rechazo TEXT,
      Fecha_Solicitud TEXT NOT NULL,
      Fecha_Resolucion TEXT,
      Resuelto_Por INTEGER,
      Id_Empresa_Creada INTEGER,
      CHECK (Estado IN ('pendiente','aprobada','rechazada'))
    )`,
    "CREATE INDEX IF NOT EXISTS idx_empresa_sol_estado ON EmpresaSolicitud(Estado)",
    "CREATE INDEX IF NOT EXISTS idx_empresa_sol_fecha ON EmpresaSolicitud(Fecha_Solicitud)",
    "CREATE INDEX IF NOT EXISTS idx_empresa_sol_correo ON EmpresaSolicitud(Admin_Correo)",

    `CREATE TABLE IF NOT EXISTS EmpresaSolicitudKYC (
      Id_KYC INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Solicitud INTEGER NOT NULL UNIQUE,
      Proveedor TEXT NOT NULL DEFAULT 'mock',
      Estado TEXT NOT NULL DEFAULT 'pendiente',
      Nivel_Validacion TEXT NOT NULL DEFAULT 'representante',
      Sesion_Externa_ID TEXT,
      URL_Verificacion TEXT,
      Score_Comparacion REAL,
      Liveness_Score REAL,
      Documento_Valido INTEGER,
      Biometria_Valida INTEGER,
      Fraude_Sospecha INTEGER,
      Payload_Proveedor_JSON TEXT,
      Motivo_Rechazo TEXT,
      Intentos INTEGER NOT NULL DEFAULT 0,
      Fecha_Creacion TEXT NOT NULL,
      Fecha_Actualizacion TEXT NOT NULL,
      Fecha_Verificacion TEXT,
      CHECK (Estado IN ('pendiente','en_proceso','aprobado','rechazado','expirado'))
    )`,
    `CREATE TABLE IF NOT EXISTS EmpresaSolicitudKYCEvento (
      Id_Evento INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Solicitud INTEGER NOT NULL,
      Id_KYC INTEGER,
      Tipo_Evento TEXT NOT NULL,
      Estado_Nuevo TEXT,
      Detalle TEXT,
      Payload_JSON TEXT,
      Creado_Por INTEGER,
      Fecha_Creacion TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_empresa_kyc_solicitud ON EmpresaSolicitudKYC(Id_Solicitud)",
    "CREATE INDEX IF NOT EXISTS idx_empresa_kyc_estado ON EmpresaSolicitudKYC(Estado)",
    "CREATE INDEX IF NOT EXISTS idx_empresa_kyc_evento_solicitud ON EmpresaSolicitudKYCEvento(Id_Solicitud, Fecha_Creacion DESC)",

    `CREATE TABLE IF NOT EXISTS EmpresaSolicitudBiometria (
      Id_Biometria INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Solicitud INTEGER NOT NULL UNIQUE,
      Mime_Type TEXT NOT NULL,
      Foto_Enc_B64 TEXT NOT NULL,
      Iv_B64 TEXT NOT NULL,
      Tag_B64 TEXT NOT NULL,
      Hash_SHA256 TEXT NOT NULL,
      Consentimiento_Texto TEXT,
      Consentimiento_Aceptado INTEGER NOT NULL DEFAULT 0,
      Consentimiento_Fecha TEXT,
      Retencion_Hasta TEXT,
      Fecha_Creacion TEXT NOT NULL,
      Fecha_Actualizacion TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_emp_bio_solicitud ON EmpresaSolicitudBiometria(Id_Solicitud)",
    "CREATE INDEX IF NOT EXISTS idx_emp_bio_retencion ON EmpresaSolicitudBiometria(Retencion_Hasta)",

    // Volume pricing
    `CREATE TABLE IF NOT EXISTS PrecioVolumen (
      Id_PrecioVolumen INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Producto INTEGER NOT NULL,
      Min_Cantidad INTEGER NOT NULL,
      Descuento_Pct REAL NOT NULL,
      Label TEXT,
      Activo INTEGER NOT NULL DEFAULT 1,
      Fecha_Creacion TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_preciovol_producto ON PrecioVolumen(Id_Producto, Min_Cantidad ASC)",
  ];

  for (const sql of statements) {
    await executeSafe(sql);
  }
}

async function backfillUsuarioEmailAuth() {
  const now = new Date().toISOString();

  try {
    await db.execute({
      sql: `INSERT INTO UsuarioEmailAuth (
              Id_Usuario,
              Email_Verified,
              Email_Verification_Token,
              Email_Verification_Expires,
              Updated_At
            )
            SELECT
              u.Id,
              COALESCE(u.Email_Verified, 1),
              u.Email_Verification_Token,
              u.Email_Verification_Expires,
              ?
            FROM Usuario u
            LEFT JOIN UsuarioEmailAuth e ON e.Id_Usuario = u.Id
            WHERE e.Id_Usuario IS NULL`,
      args: [now],
    });
    return;
  } catch {
    // Legacy email columns may not exist in some environments.
  }

  await db.execute({
    sql: `INSERT INTO UsuarioEmailAuth (
            Id_Usuario,
            Email_Verified,
            Email_Verification_Token,
            Email_Verification_Expires,
            Updated_At
          )
          SELECT
            u.Id,
            1,
            NULL,
            NULL,
            ?
          FROM Usuario u
          LEFT JOIN UsuarioEmailAuth e ON e.Id_Usuario = u.Id
          WHERE e.Id_Usuario IS NULL`,
    args: [now],
  });
}

async function main() {
  console.log("[migrate-schema] Running schema migrations...");
  await migrateOperationalTables();
  await backfillUsuarioEmailAuth();
  console.log("[migrate-schema] Done.");
}

main().catch((error) => {
  console.error("[migrate-schema] Failed:", error);
  process.exit(1);
});
