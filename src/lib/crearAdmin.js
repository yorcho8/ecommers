import { createClient } from "@libsql/client";
import 'dotenv/config';
import { hashPassword } from './auth-utils.js';

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN
});

async function crearAdmin() {
  try {
    // TODO: Reemplaza estos datos con tus credenciales reales
    const nuevoAdmin = {
      nombre: "JORGE CRISTIAN",          
      apellidoPaterno: "PEREZ", 
      apellidoMaterno: "RODRIGUEZ", 
      correo: "Jp9971721@gmail.com",       
      contrasena: "Superman88",      
      rol: "admin",
      telefono: "8137022499",
      fechaCreacion: new Date().toISOString()
    };

    // Cifrar la contraseña usando PBKDF2
    const { hash, salt } = hashPassword(nuevoAdmin.contrasena);
    const contrasenaEncriptada = `${hash}:${salt}`;

    // Insertar el admin en la tabla Usuario
    await db.execute({
      sql: `INSERT INTO Usuario (Nombre, Apellido_Paterno, Apellido_Materno, Correo, Contrasena, Rol, Telefono, Fecha_Creacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nuevoAdmin.nombre,
        nuevoAdmin.apellidoPaterno,
        nuevoAdmin.apellidoMaterno,
        nuevoAdmin.correo,
        contrasenaEncriptada,
        nuevoAdmin.rol,
        nuevoAdmin.telefono,
        nuevoAdmin.fechaCreacion
      ]
    });

    console.log(`✅ Admin creado exitosamente`);
    console.log(`📧 Correo: ${nuevoAdmin.correo}`);
    console.log(`🔐 Contraseña: ${nuevoAdmin.contrasena}`);
    console.log(`⚠️  IMPORTANTE: Cambia la contraseña después del primer login`);

  } catch (error) {
    if (error.message.includes("UNIQUE constraint failed")) {
      console.error("❌ Error: El correo ya existe en la base de datos");
    } else {
      console.error("❌ Error creando admin:", error);
    }
  }
}

crearAdmin();
