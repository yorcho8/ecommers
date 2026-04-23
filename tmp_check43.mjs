import { getTodosLosProductos } from './src/lib/productos-service.js';
const products = await getTodosLosProductos();
const p43 = products.find((p) => Number(p.id) === 43);
console.log('TOTAL', products.length);
console.log('HAS_43', !!p43);
if (p43) {
  console.log(JSON.stringify({ id:p43.id, nombre:p43.nombre, precio:p43.precio, precioOriginal:p43.precioOriginal, descuento:p43.descuento, stock:p43.stock, activo:p43.activo }, null, 2));
}
