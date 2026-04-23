export async function ensureEmpresaProfileSchema(_db) {
  // Compatibilidad: el esquema ya existe y no se ejecuta DDL desde código.
  return true;
}

export async function expireEmpresaProfilePayments(db) {
  const nowIso = new Date().toISOString();
  await db.execute({
    sql: `
      UPDATE EmpresaPerfilPago
      SET Estado = 'vencida', Fecha_Actualizacion = ?
      WHERE Estado = 'activa'
        AND Fecha_Fin IS NOT NULL
        AND Fecha_Fin <= ?
    `,
    args: [nowIso, nowIso],
  });

  await db.execute({
    sql: `
      UPDATE Empresa
      SET Perfil_Publico_Activo = 0
      WHERE Id_Empresa IN (
        SELECT e.Id_Empresa
        FROM Empresa e
        LEFT JOIN EmpresaPerfilPago ep ON ep.Id_Empresa = e.Id_Empresa AND ep.Estado = 'activa' AND (ep.Fecha_Fin IS NULL OR ep.Fecha_Fin > ?)
        WHERE ep.Id_PerfilPago IS NULL
      )
    `,
    args: [nowIso],
  });
}
