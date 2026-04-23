import { createClient } from "@libsql/client";
import 'dotenv/config';
import { ensureProductModerationSchema, ensureProductVisibilitySchema } from "../../../lib/product-visibility.js";
import { ensureProductVariantExtendedSchema } from "../../../lib/product-variant-schema.js";
import {
  sendProductPendingReviewAlert,
  sendProductSubmissionReceived,
} from "../../../lib/mail.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN
});

function parseSpecs(specValue) {
  if (!specValue) return null;
  try {
    return typeof specValue === 'string' ? JSON.parse(specValue) : specValue;
  } catch {
    return null;
  }
}

function validateExactDimensions(specObj) {
  const dims = specObj?.dimensiones;
  if (!dims) return { ok: true };
  const largo = Number(dims.largo);
  const ancho = Number(dims.ancho);
  const grosor = Number(dims.grosor);
  if (!Number.isFinite(largo) || largo <= 0 || !Number.isFinite(ancho) || ancho <= 0 || !Number.isFinite(grosor) || grosor <= 0) {
    return { ok: false, error: 'Largo, ancho y grosor deben ser valores exactos mayores a 0.' };
  }
  return { ok: true };
}

function validateVariantsDistinctPrices(variantes) {
  if (!Array.isArray(variantes) || variantes.length === 0) return { ok: true };
  const filtered = variantes.filter((v) => String(v?.descripcion || '').trim());
  for (const v of filtered) {
    const n = Number(v?.precio);
    if (v?.precio == null || v?.precio === '' || !Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `La variante "${String(v?.descripcion || '').trim()}" requiere un precio mayor a 0.` };
    }
    const s = Number(v?.stock);
    if (v?.stock == null || v?.stock === '' || !Number.isFinite(s) || s < 0) {
      return { ok: false, error: `La variante "${String(v?.descripcion || '').trim()}" requiere stock (mínimo 0).` };
    }
  }
  return { ok: true };
}

export async function POST({ request, cookies }) {
  try {
    await ensureProductVisibilitySchema(db);
    await ensureProductModerationSchema(db);
    await ensureProductVariantExtendedSchema(db);
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: 'No autenticado' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const user = (() => { try { return verifySessionToken(token); } catch { return null; } })();
    if (!user) {
      return new Response(
        JSON.stringify({ success: false, error: 'No autenticado' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const rol = String(user?.rol || "").toLowerCase();
    const userId = user?.userId;

    const esSuperAdmin = rol === "superusuario";
    const tieneAcceso = ["admin", "superusuario", "vendedor"].includes(rol);

    if (!tieneAcceso) {
      return new Response(
        JSON.stringify({ success: false, error: 'Acceso denegado.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let empresaId = null;
    const empresaRes = await db.execute({
      sql: `SELECT Id_Empresa FROM UsuarioEmpresa WHERE Id_Usuario = ? AND Activo = 1 LIMIT 1`,
      args: [userId],
    });
    if (empresaRes.rows.length) {
      empresaId = Number(empresaRes.rows[0].Id_Empresa);
    }

    if (!empresaId && !esSuperAdmin) {
      return new Response(
        JSON.stringify({ success: false, error: 'No tienes empresa asignada. Contacta al administrador.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const formData = await request.formData();

    if (esSuperAdmin) {
      const empresaIdForm = formData.get('empresaId');
      if (empresaIdForm && !isNaN(parseInt(empresaIdForm))) {
        empresaId = parseInt(empresaIdForm);
      }
    }

    const nombre          = formData.get('nombre');
    // SKU generado automáticamente
    let sku = '';
    // Código de referencia opcional del usuario
    const codigoReferencia = formData.get('codigoReferencia') ? String(formData.get('codigoReferencia')).trim() : null;
    const descripcion     = formData.get('descripcion') || '';
    const precio          = parseFloat(formData.get('precio'));
    const stockDisponible = parseInt(formData.get('stockDisponible')) || 0;
    const categoriaId     = parseInt(formData.get('categoriaId'));
    const requestedActivo = Number(formData.get('activo') ?? 1) === 0 ? 0 : 1;
    const requiresModeration = !esSuperAdmin;
    const activo = requiresModeration ? 0 : requestedActivo;
    const pesoRaw         = formData.get('peso');
    const peso            = pesoRaw != null && pesoRaw !== '' && !isNaN(parseFloat(pesoRaw))
                ? parseFloat(pesoRaw) : null;
    const imagenesUrls    = formData.getAll('imagenes');

    // ── NUEVOS CAMPOS ──
    const division      = formData.get('division') ? String(formData.get('division')).trim() : null;
    const unidadVenta   = formData.get('unidadVenta') ? String(formData.get('unidadVenta')).trim() : null;
    const especRaw      = formData.get('especificaciones');
    const especificaciones = especRaw ? String(especRaw).trim() : null;
    const variantesRaw  = formData.get('variantes');
    let variantes = [];
    if (variantesRaw) {
      try { variantes = JSON.parse(variantesRaw); } catch { variantes = []; }
    }
    const specObj = parseSpecs(especificaciones);

    const errores = [];
    if (!nombre)                            errores.push('Nombre del producto');
    if (!precio || isNaN(precio))           errores.push('Precio válido');
    if (imagenesUrls.length === 0)          errores.push('Al menos una URL de imagen');
    if (!categoriaId || isNaN(categoriaId)) errores.push('Categoría válida');
    const dimsValidation = validateExactDimensions(specObj);
    if (!dimsValidation.ok) errores.push(dimsValidation.error);
    const variantsValidation = validateVariantsDistinctPrices(variantes);
    if (!variantsValidation.ok) errores.push(variantsValidation.error);

    if (errores.length > 0) {
      return new Response(
        JSON.stringify({ success: false, error: `Campos requeridos faltantes: ${errores.join(', ')}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const fechaCreacion = new Date().toISOString();
    let productoId;

    // ── Insertar Producto con nuevos campos ──
    try {
      // Obtener el siguiente SKU automático
      const skuRes = await db.execute({
        sql: `SELECT MAX(Id_Producto) as maxId FROM Producto`,
        args: []
      });
      const nextId = (skuRes.rows[0]?.maxId || 0) + 1;
      sku = `SKU-${String(nextId).padStart(6, '0')}`;

      await db.execute({
        sql: `INSERT INTO Producto
                (Nombre, SKU, CodigoReferencia, Descripcion, Fecha_Creacion, Precio, StockDisponible,
                 Activo, Peso, Id_Empresa, Division, Unidad_Venta, Especificaciones)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [nombre, sku, codigoReferencia, descripcion, fechaCreacion, precio, stockDisponible,
               activo, peso, empresaId, division, unidadVenta, especificaciones]
      });

      const resultado = await db.execute({
        sql: `SELECT Id_Producto FROM Producto WHERE Nombre = ? AND SKU = ? AND Fecha_Creacion = ? LIMIT 1`,
        args: [nombre, sku, fechaCreacion]
      });

      if (!resultado.rows.length) throw new Error('No se pudo obtener el ID del producto');
      productoId = resultado.rows[0].Id_Producto;

    } catch (dbError) {
      console.error('Error insertando producto:', dbError);
      return new Response(
        JSON.stringify({ success: false, error: 'Error al crear el producto en la BD' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      const estadoModeracion = requiresModeration ? 'pendiente' : 'aprobado';
      await db.execute({
        sql: `INSERT OR REPLACE INTO ProductoModeracion
              (Id_Producto, Estado, Motivo_Rechazo, Solicitado_Por, Revisado_Por, Fecha_Solicitud, Fecha_Revision)
              VALUES (?, ?, NULL, ?, ?, ?, ?)` ,
        args: [
          productoId,
          estadoModeracion,
          userId || null,
          esSuperAdmin ? (userId || null) : null,
          fechaCreacion,
          esSuperAdmin ? fechaCreacion : null,
        ],
      });
    } catch (dbError) {
      console.error('Error registrando moderacion de producto:', dbError);
    }

    // ── Insertar imágenes ──
    try {
      for (let i = 0; i < imagenesUrls.length; i++) {
        await db.execute({
          sql: `INSERT INTO Imagen_Producto (Id_Producto, Url) VALUES (?, ?)`,
          args: [productoId, imagenesUrls[i]]
        });
      }
    } catch (dbError) {
      console.error('Error insertando imágenes:', dbError);
      return new Response(
        JSON.stringify({ success: false, error: 'Error al guardar las URLs de las imágenes', details: dbError.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Insertar categoría ──
    try {
      await db.execute({
        sql: `INSERT INTO ProductoCategoria (Id_Producto, Id_Categoria) VALUES (?, ?)`,
        args: [productoId, categoriaId]
      });
    } catch (dbError) {
      console.error('Error insertando categoría:', dbError);
      return new Response(
        JSON.stringify({ success: false, error: 'Error al asignar la categoría al producto' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Insertar variantes ──
    if (Array.isArray(variantes) && variantes.length > 0) {
      try {
        for (const v of variantes) {
          const vDesc  = String(v?.descripcion || "").trim();
          const vPrecio = v?.precio != null && !isNaN(Number(v.precio)) ? Number(v.precio) : null;
          const vStock  = v?.stock  != null && !isNaN(Number(v.stock))  ? Number(v.stock)  : null;
          const vPeso   = v?.peso   != null && !isNaN(Number(v.peso))   ? Number(v.peso)   : null;
          const vSpecsObj = (() => {
            if (v?.especificaciones == null) return null;
            if (typeof v.especificaciones === 'string') {
              const trimmed = v.especificaciones.trim();
              return trimmed ? trimmed : null;
            }
            try {
              return JSON.stringify(v.especificaciones);
            } catch {
              return null;
            }
          })();
          if (!vDesc) continue;
          await db.execute({
            sql: `INSERT INTO ProductoVariante (Id_Producto, Descripcion, Precio, Stock, Peso, Especificaciones) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [productoId, vDesc, vPrecio, vStock, vPeso, vSpecsObj]
          });
        }
      } catch (dbError) {
        console.error('Error insertando variantes:', dbError);
      }
    }

    let reviewNotice = null;
    if (requiresModeration) {
      const requesterName = String(user?.nombre || '').trim() || 'Administrador';
      const requesterEmail = String(user?.correo || '').trim().toLowerCase();
      let empresaNombre = `Empresa #${empresaId}`;
      try {
        const empresaData = await db.execute({
          sql: `SELECT Nombre_Empresa FROM Empresa WHERE Id_Empresa = ? LIMIT 1`,
          args: [empresaId],
        });
        if (empresaData.rows.length) {
          empresaNombre = String(empresaData.rows[0].Nombre_Empresa || empresaNombre).trim() || empresaNombre;
        }
      } catch {}

      const creatorMail = await sendProductSubmissionReceived({
        to: requesterEmail,
        requesterName,
        productName: nombre,
        empresaName: empresaNombre,
      });

      let notifiedSuperusers = 0;
      try {
        const superRows = await db.execute({
          sql: `SELECT Nombre, Correo FROM Usuario WHERE LOWER(Rol) = 'superusuario'`,
          args: [],
        });
        const jobs = [];
        for (const row of superRows.rows) {
          const email = String(row.Correo || '').trim().toLowerCase();
          if (!email || email === requesterEmail) continue;
          jobs.push(
            sendProductPendingReviewAlert({
              to: email,
              reviewerName: String(row.Nombre || 'Superusuario'),
              requesterName,
              productName: nombre,
              empresaName: empresaNombre,
            })
          );
        }
        const sent = await Promise.all(jobs);
        notifiedSuperusers = sent.filter((x) => x?.sent).length;
      } catch (notifyError) {
        console.error('Error notificando superusuarios:', notifyError);
      }

      reviewNotice = {
        creatorEmailSent: Boolean(creatorMail?.sent),
        superusersNotified: notifiedSuperusers,
      };
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: requiresModeration
          ? 'Producto enviado a revision. Quedara publicado cuando un superusuario lo apruebe.'
          : 'Producto creado exitosamente',
        pendingApproval: requiresModeration,
        productoId,
        empresaId,
        reviewNotice,
        producto: {
          nombre,
          precio,
          stockDisponible,
          activo: activo === 1,
          division,
          unidadVenta,
          variantes,
          imagenes: imagenesUrls.map((url, i) => ({ url, orden: i }))
        }
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error en POST /api/productos/crear:', error);
    return new Response(
      JSON.stringify({ success: false, error: 'Error del servidor' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}