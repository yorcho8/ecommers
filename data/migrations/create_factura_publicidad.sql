-- ─────────────────────────────────────────────────────────────────────────────
-- NEXUS: Migrar FacturaPublicidad al esquema correcto (Nexus → Empresa)
-- Corre en Turso con: turso db shell <nombre-db> < data/migrations/create_factura_publicidad.sql
--
-- Esta migración crea la tabla (si no existe) o aplica el cambio de esquema:
--   Antes: Id_Usuario INTEGER NOT NULL   (incorrecto — la factura es a la empresa)
--   Ahora: Id_Empresa INTEGER            (la empresa a quien Nexus le factura)
--
-- PASOS: crear tabla nueva → copiar datos → eliminar vieja → renombrar
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Crear tabla nueva con esquema correcto
CREATE TABLE IF NOT EXISTS FacturaPublicidad_v2 (
  Id_FacturaPublicidad  INTEGER PRIMARY KEY AUTOINCREMENT,
  Id_Campana            INTEGER NOT NULL,
  Id_Empresa            INTEGER,
  Facturama_Id          TEXT,
  UUID                  TEXT,
  RFC_Receptor          TEXT,
  Nombre_Receptor       TEXT,
  Uso_CFDI              TEXT,
  Regimen_Fiscal        TEXT,
  CP_Fiscal             TEXT,
  Total                 REAL,
  Fecha_Emision         TEXT,
  Estado                TEXT NOT NULL DEFAULT 'vigente',
  Fecha_Creacion        TEXT NOT NULL,
  FOREIGN KEY (Id_Campana) REFERENCES PublicidadCampana(Id_Publicidad) ON DELETE CASCADE
);

-- 2. Si existe la tabla vieja, migrar datos (Id_Empresa queda NULL para filas antiguas)
INSERT OR IGNORE INTO FacturaPublicidad_v2
  (Id_FacturaPublicidad, Id_Campana, Facturama_Id, UUID,
   RFC_Receptor, Nombre_Receptor, Uso_CFDI, Regimen_Fiscal, CP_Fiscal,
   Total, Fecha_Emision, Estado, Fecha_Creacion)
SELECT
  Id_FacturaPublicidad, Id_Campana, Facturama_Id, UUID,
  RFC_Receptor, Nombre_Receptor, Uso_CFDI, Regimen_Fiscal, CP_Fiscal,
  Total, Fecha_Emision, Estado, Fecha_Creacion
FROM FacturaPublicidad;

-- 3. Eliminar tabla vieja
DROP TABLE IF EXISTS FacturaPublicidad;

-- 4. Renombrar nueva tabla
ALTER TABLE FacturaPublicidad_v2 RENAME TO FacturaPublicidad;

-- 5. Índices
CREATE INDEX IF NOT EXISTS idx_factura_pub_campana ON FacturaPublicidad(Id_Campana);
CREATE INDEX IF NOT EXISTS idx_factura_pub_empresa ON FacturaPublicidad(Id_Empresa);
CREATE INDEX IF NOT EXISTS idx_factura_pub_estado  ON FacturaPublicidad(Estado);
