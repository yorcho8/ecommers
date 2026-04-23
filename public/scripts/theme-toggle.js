document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("theme-toggle");
  
  // Si no hay botón en esta página, no hacemos nada
  if (!btn) return;

  btn.addEventListener("click", () => {
    const html = document.documentElement;
    
    // 1. Cambiar la clase
    html.classList.toggle("dark");
    
    // 2. Verificar cómo quedó
    const isDark = html.classList.contains("dark");
    
    // 3. Guardar en localStorage
    localStorage.setItem("theme", isDark ? "dark" : "light");
    
    console.log("Tema cambiado a:", isDark ? "Oscuro" : "Claro");
  });
});