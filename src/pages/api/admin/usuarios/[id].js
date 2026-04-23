import { createClient } from "@libsql/client";
import "dotenv/config";
import { hashPassword } from "../../../../lib/auth-utils.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getCurrentUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

function isPrivileged(role) {
  return role === "admin" || role === "superusuario";
}

export async function PUT({ params, request, cookies }) {
  const currentUser = getCurrentUser(cookies);
  const currentRole = String(currentUser?.rol || "").toLowerCase();
  if (!isPrivileged(currentRole)) return json({ success: false, error: "Acceso denegado" }, 403);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ success: false, error: "ID de usuario invalido" }, 400);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const nombre = String(body?.nombre || "").trim();
    const apellidoPaterno = String(body?.apellidoPaterno || "").trim();
    const apellidoMaterno = String(body?.apellidoMaterno || "").trim();
    const correo = String(body?.correo || "").trim().toLowerCase();
    const rol = String(body?.rol || "usuario").trim().toLowerCase();
    const telefono = String(body?.telefono || "").trim();
    const contrasena = String(body?.contrasena || "").trim();
    const numeroCasaRaw = String(body?.numeroCasa ?? "").trim();
    const calle = String(body?.calle || "").trim();
    const codigoPostalRaw = String(body?.codigoPostal ?? "").trim();
    const ciudad = String(body?.ciudad || "").trim();
    const provincia = String(body?.provincia || "").trim();
    const pais = String(body?.pais || "Mexico").trim();

    const rolesValidos = ["usuario", "admin", "superusuario"];
    if (!nombre || !apellidoPaterno || !correo) {
      return json({ success: false, error: "Nombre, apellido paterno y correo son obligatorios" }, 400);
    }
    if (!rolesValidos.includes(rol)) {
      return json({ success: false, error: "Rol invalido" }, 400);
    }

    if (rol === "superusuario" && currentRole !== "superusuario") {
      return json({ success: false, error: "Solo un superusuario puede asignar rol superusuario" }, 403);
    }

    const hasAddressData =
      numeroCasaRaw !== "" ||
      calle !== "" ||
      codigoPostalRaw !== "" ||
      ciudad !== "" ||
      provincia !== "" ||
      pais !== "";

    if (hasAddressData) {
      const numeroCasa = Number(numeroCasaRaw);
      const codigoPostal = Number(codigoPostalRaw);
      if (!Number.isFinite(numeroCasa) || numeroCasa <= 0 || !calle || !Number.isFinite(codigoPostal) || codigoPostal <= 0 || !ciudad || !provincia || !pais) {
        return json({ success: false, error: "Direccion incompleta o invalida" }, 400);
      }
    }

    const exists = await db.execute({
      sql: "SELECT Id FROM Usuario WHERE Id = ? LIMIT 1",
      args: [id],
    });
    if (!exists.rows.length) {
      return json({ success: false, error: "Usuario no encontrado" }, 404);
    }

    const duplicate = await db.execute({
      sql: "SELECT Id FROM Usuario WHERE LOWER(Correo) = LOWER(?) AND Id <> ? LIMIT 1",
      args: [correo, id],
    });
    if (duplicate.rows.length) {
      return json({ success: false, error: "El correo ya existe" }, 409);
    }

    await db.execute({
      sql: `UPDATE Usuario
            SET Nombre = ?, Apellido_Paterno = ?, Apellido_Materno = ?, Correo = ?, Rol = ?, Telefono = ?
            WHERE Id = ?`,
      args: [nombre, apellidoPaterno, apellidoMaterno || null, correo, rol, telefono || null, id],
    });

    if (contrasena) {
      const { hash, salt } = hashPassword(contrasena);
      const contrasenaHash = `${hash}:${salt}`;
      await db.execute({
        sql: "UPDATE Usuario SET Contrasena = ? WHERE Id = ?",
        args: [contrasenaHash, id],
      });
    }

    if (hasAddressData) {
      const numeroCasa = Number(numeroCasaRaw);
      const codigoPostal = Number(codigoPostalRaw);
      const direccion = await db.execute({
        sql: "SELECT Id_Direccion FROM Direccion WHERE Id_Usuario = ? ORDER BY Id_Direccion DESC LIMIT 1",
        args: [id],
      });

      if (direccion.rows.length) {
        await db.execute({
          sql: `UPDATE Direccion
                SET Numero_casa = ?, Calle = ?, Codigo_Postal = ?, Ciudad = ?, Provincia = ?, Pais = ?
                WHERE Id_Direccion = ?`,
          args: [numeroCasa, calle, codigoPostal, ciudad, provincia, pais, direccion.rows[0].Id_Direccion],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO Direccion
                (Id_Usuario, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Pais)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [id, numeroCasa, calle, codigoPostal, ciudad, provincia, pais],
        });
      }
    }

    return json({ success: true, message: "Usuario actualizado" });
  } catch (error) {
    console.error("[PUT /api/admin/usuarios/:id] Error:", error);
    return json({ success: false, error: "Error actualizando usuario" }, 500);
  }
}

export async function DELETE({ params, cookies }) {
  const currentUser = getCurrentUser(cookies);
  const currentRole = String(currentUser?.rol || "").toLowerCase();

  if (currentRole !== "superusuario") {
    return json({ success: false, error: "Solo superusuario puede eliminar usuarios" }, 403);
  }

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ success: false, error: "ID de usuario invalido" }, 400);
  }

  try {
    if (Number(currentUser?.userId) === id) {
      return json({ success: false, error: "No puedes eliminar tu propio usuario" }, 400);
    }

    const target = await db.execute({
      sql: "SELECT Id, Rol FROM Usuario WHERE Id = ? LIMIT 1",
      args: [id],
    });

    if (!target.rows.length) {
      return json({ success: false, error: "Usuario no encontrado" }, 404);
    }

    // Cascade-delete related records before deleting the user to avoid FK constraint violations
    await db.execute({ sql: "DELETE FROM ItemCarrito WHERE Id_Carrito IN (SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ?)", args: [id] });
    await db.execute({ sql: "DELETE FROM Carrito WHERE Id_Usuario = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM Tarjeta WHERE Id_Usuario = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM Direccion WHERE Id_Usuario = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM Usuario WHERE Id = ?", args: [id] });

    return json({ success: true, message: "Usuario eliminado" });
  } catch (error) {
    console.error("[DELETE /api/admin/usuarios/:id] Error:", error);
    return json({ success: false, error: "Error eliminando usuario" }, 500);
  }
}
